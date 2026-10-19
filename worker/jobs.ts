import type { JobConfig, Pool } from "./handlers";
import { charge, LIMITS, LimitError } from "./limits";
import { badRequest } from "./http/context";
import { capabilities, parseLensDefinition } from "./store";
import { jevUnavailable } from "../src/attention";
import { restoredContentStateSql } from "./content-state";
import type { Lens, Tag } from "../src/types";
import { JEV_FAILURE_MESSAGES } from "../src/failures";
const POOL_LIMITS = { browser: 2, jev: 16 } as const;
export function poolLimit(env: Env, pool: Pool) {
  const override = Number(
    pool === "browser" ? env.BROWSER_CONCURRENCY : env.JEV_CONCURRENCY,
  );
  return Number.isFinite(override) && override > 0
    ? override
    : POOL_LIMITS[pool];
}
export type JobRow = {
  id: string;
  batch_id: string;
  /** A job targets either a saved link or a browser capture, never both. */
  link_id: string | null;
  target_id?: string | null;
  status: string;
};
export type Config = JobConfig;
export const contentMissing = "Content missing. Extract it first.";
// A link runs one job at a time. A job enqueued while another is queued, running or waiting on the same link
// waits in D1 (never in the Queue) and starts when the jobs before it settle, oldest first.
const busy = "status IN ('queued','running','waiting')";
/** A link is busy while it has a queued, running or waiting job; one-off link edits wait for it to be idle. */
export const linkIdle = "NOT EXISTS (SELECT 1 FROM jobs WHERE link_id=? AND status IN ('queued','running','waiting'))";
/** Jev refused because none of the links in the request has content or an extraction on the way. */
export class NothingToRun extends Error {
  constructor(message: string, readonly skipped: string[]) {
    super(message);
  }
}
/**
 * Cancels the Jev jobs waiting on links whose extraction was just cancelled: they depended on it.
 * `cancelled` selects those extract jobs (alias e). Must run, in the same transaction, after they are
 * marked Cancelled and before promoteWaiting, so no dependent ever starts. Per-link cancel (FAC-55) reuses it.
 */
export const cancelDependents = (db: D1Database, cancelled: string, params: unknown[], now: string) =>
  db.prepare(
    `UPDATE jobs SET status='failed',step='Cancelled',error='Cancelled: its extraction was cancelled',completed_at=? WHERE status='waiting' AND batch_id IN (SELECT id FROM batches WHERE kind IN ('autotag','lens','query')) AND link_id IN (SELECT e.link_id FROM jobs e JOIN batches eb ON eb.id=e.batch_id WHERE eb.kind='extract' AND e.status='failed' AND e.step='Cancelled' AND ${cancelled})`,
  ).bind(now, ...params);
const ahead = (j: string) =>
  `NOT EXISTS (SELECT 1 FROM jobs a WHERE a.link_id=${j}.link_id AND (a.status IN ('queued','running') OR (a.status='waiting' AND (a.created_at<${j}.created_at OR (a.created_at=${j}.created_at AND a.rowid<${j}.rowid)))))`;
/** Moves the next waiting job of each idle link (or of one link) to queued. Safe to repeat. `guard` adds a condition. */
export const promoteWaiting = (db: D1Database, linkId?: string, guard?: { sql: string; params: unknown[] }) =>
  db.prepare(`UPDATE jobs SET status='queued' WHERE status='waiting' AND link_id IS NOT NULL${linkId ? " AND link_id=?" : ""} AND ${ahead("jobs")}${guard ? ` AND ${guard.sql}` : ""}`)
    .bind(...(linkId ? [linkId] : []), ...(guard?.params ?? []));
/** Sends the queued jobs of these links. A lost send is resent by recover(), and dispatch ignores repeats. */
export async function startNext(env: Env, linkIds: (string | null)[]) {
  const ids = [...new Set(linkIds.filter((id): id is string => !!id))];
  if (!ids.length) return;
  const rows = await env.DB.prepare(`SELECT id FROM jobs WHERE status='queued' AND link_id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids)).all<{ id: string }>();
  if (!rows.results.length) return;
  try {
    await env.JOBS.sendBatch(rows.results.map((body) => ({ body })));
  } catch {
    console.error("Queue dispatch deferred to outbox recovery");
  }
}
/** The job finished (done, failed or cancelled) before the cancel could stop it. */
export class JobFinished extends Error {}
// Stops a running job's workflow. An instance that already ended (or never existed) has nothing to stop;
// anything else unknown keeps the job running rather than cancelling it under a live workflow.
async function stopWorkflow(env: Env, id: string) {
  try {
    await (await env.PROCESS_LINK.get(id)).terminate();
  } catch (error) {
    const status = await env.PROCESS_LINK.get(id).then((i) => i.status()).catch((e: unknown) => (/not.?found/i.test(String(e)) ? null : undefined));
    console.log(JSON.stringify({ event: "job_terminate_failed", job_id: id, instance: status === undefined ? "unknown" : status?.status ?? "missing", detail: String(error).slice(0, 300) }));
    if (status === undefined || (status && !["complete", "errored", "terminated"].includes(status.status)))
      throw badRequest("Could not stop this job. Try again.");
  }
}
/**
 * Cancels one job (FAC-55). A queued or waiting job is dropped; a running one has its workflow terminated first.
 * Either way it ends as Cancelled, as if it had never been requested: what already ran is kept, a queued
 * extraction's link goes back to how it was, the slot is released, Needs attention is never touched, and the
 * link's next waiting job starts. Cancelling an extraction also cancels the Jev jobs waiting for it.
 * Every write is guarded by the status read here, so a job settling at the same time either finishes first
 * (JobFinished) or finds itself cancelled and leaves it alone.
 */
export async function cancelJob(env: Env, userId: string, id: string) {
  for (let round = 0; round < 3; round++) {
    const job = await env.DB.prepare("SELECT j.id,j.batch_id,j.link_id,j.status,b.kind FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=? AND b.user_id=?")
      .bind(id, userId).first<JobRow & { kind: string }>();
    if (!job) return null;
    if (job.status === "done" || job.status === "failed") throw new JobFinished("This job already finished.");
    if (job.status === "running") await stopWorkflow(env, id);
    const now = new Date().toISOString();
    const won = "EXISTS (SELECT 1 FROM jobs WHERE id=? AND step='Cancelled' AND completed_at=?)";
    const extract = job.kind === "extract" && !!job.link_id;
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE jobs SET status='failed',step='Cancelled',error=CASE WHEN jev_call IS NOT NULL THEN ? ELSE 'Cancelled' END,reason=NULL,attempt_started_at=NULL,completed_at=? WHERE id=? AND status IN (${job.status === "running" ? "'running'" : "'queued','waiting'"})`,
      ).bind(JEV_FAILURE_MESSAGES.cancelled_sent, now, id),
      ...(extract ? [cancelDependents(env.DB, "e.id=? AND e.completed_at=?", [id, now], now)] : []),
      // A provider call cut short may still be billed; Usage records it like recover() does.
      env.DB.prepare(`UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE job_id=? AND status='started' AND ${won}`).bind(id, id, now),
      env.DB.prepare(`DELETE FROM provider_leases WHERE job_id=? AND ${won}`).bind(id, id, now),
      ...(extract
        ? [env.DB.prepare(
            `UPDATE links SET content_state=${restoredContentStateSql} WHERE id=? AND content_state='queued' AND ${won} AND NOT EXISTS (SELECT 1 FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=links.id AND j.status IN ('queued','running','waiting') AND b.kind='extract')`,
          ).bind(job.link_id, id, now)]
        : []),
      ...(job.link_id ? [promoteWaiting(env.DB, job.link_id)] : []),
    ]);
    // The job moved on meanwhile (queued to running, or settled): look again.
    if (!results[0]!.meta.changes) continue;
    const dependents = extract ? results[1]!.meta.changes : 0;
    console.log(JSON.stringify({ event: "job_cancelled", job_id: id, batch_id: job.batch_id, kind: job.kind, from: job.status, dependents }));
    if (job.link_id && results.at(-1)!.meta.changes) await startNext(env, [job.link_id]);
    return { from: job.status, dependents };
  }
  throw badRequest("The job changed meanwhile. Try again.");
}
export async function enqueue(
  env: Env,
  userId: string,
  ids: string[],
  kind: "extract" | "preview" | "autotag" | "lens",
  lensId?: string,
  extract: Pick<Config, "track" | "step"> = {},
  retryOf?: string,
) {
  const jev = kind === "autotag" || kind === "lens";
  ids = [...new Set(ids)];
  if (!ids.length || ids.length > 100)
    throw badRequest("Select between 1 and 100 links per batch.");
  const unavailable = !jev ? null : jevUnavailable(capabilities(env));
  if (unavailable) {
    console.error(JSON.stringify({ event: "jev_not_configured", kind, provider: capabilities(env).provider, links: ids.length }));
    throw badRequest(unavailable);
  }

  const links = await env.DB.prepare(
    `SELECT id,content_key,EXISTS (SELECT 1 FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=links.id AND j.${busy} AND b.kind='extract') extracting,EXISTS (SELECT 1 FROM jobs j WHERE j.link_id=links.id AND j.${busy}) busy FROM links WHERE user_id=? AND id IN (SELECT value FROM json_each(?))`,
  )
    .bind(userId, JSON.stringify(ids))
    .all<{ id: string; content_key: string | null; extracting: number; busy: number }>();
  if (links.results.length !== ids.length)
    throw badRequest("One of the links no longer exists.");
  // Jev runs on links with content or with an extraction on the way; it never starts an extraction itself.
  const skipped = jev ? links.results.filter((l) => !l.content_key && !l.extracting).map((l) => l.id) : [];
  if (skipped.length === ids.length)
    throw new NothingToRun(ids.length === 1 ? "This link has no content yet. Extract it first." : "None of the selected links have content yet. Extract them first.", skipped);
  if (!jev && links.results.some((l) => l.busy))
    throw badRequest("Some selected links are still processing.");
  ids = ids.filter((id) => !skipped.includes(id));
  let config: Config = {};
  if (kind === "autotag") {
    const tags = await env.DB.prepare(
      "SELECT id,name,description,threshold,version FROM tags WHERE user_id=? ORDER BY name",
    ).bind(userId).all<Tag>();
    if (!tags.results.length) throw badRequest("Create at least one tag.");
    config = { tags: tags.results };
  }
  if (kind === "lens") {
    const row = await env.DB.prepare("SELECT id,name,type,question,options,threshold,version,created_at,scope FROM lenses WHERE id=? AND user_id=?")
      .bind(lensId ?? "", userId)
      .first<Record<string, unknown>>();
    if (!row) throw badRequest("The lens no longer exists.");
    if (row.scope === "browser")
      throw badRequest("Browser lenses evaluate open tabs, not saved links.");
    const lens = {
      ...(row as unknown as Lens),
      ...parseLensDefinition(
        row.type as Lens["type"],
        String(row.options),
      ),
    };
    config = { lens };
  }
  if (kind === "extract") config = { ...(extract.track && { track: extract.track }), ...(extract.step && { step: extract.step }) };
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  // A retry skips links that a later run of the same kind (and lens) already recovered or is still running,
  // checked in each insert, so a repeated or double-clicked Retry never pays for the same link twice.
  const redone = retryOf
    ? " AND NOT EXISTS (SELECT 1 FROM batches ob, jobs r JOIN batches rb ON rb.id=r.batch_id WHERE ob.id=? AND r.link_id=? AND rb.kind=ob.kind AND rb.rowid>ob.rowid AND r.status IN ('queued','running','waiting','done') AND json_extract(rb.config,'$.lens.id') IS json_extract(ob.config,'$.lens.id'))"
    : "";
  const charged = await charge(env.DB, [{ key: `jobs:${userId}`, limit: LIMITS.jobsPerUser, cost: ids.length }]);
  if (!charged) throw new LimitError("Processing limit reached. Try again later.");
  try {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO batches(id,user_id,kind,config,created_at) VALUES(?,?,?,?,?)",
    ).bind(id, userId, kind, JSON.stringify(config), now),
    // Decided inside the transaction, so a concurrent enqueue can't put two active jobs on one link.
    ...ids.map((link_id) =>
      env.DB.prepare(
        `INSERT INTO jobs(id,batch_id,link_id,status,created_at) SELECT ?,?,?,CASE WHEN ${jev ? '1' : '0'} AND EXISTS (SELECT 1 FROM jobs WHERE link_id=? AND ${busy}) THEN 'waiting' ELSE 'queued' END,? WHERE 1${redone}`,
      ).bind(crypto.randomUUID(), id, link_id, link_id, now, ...(retryOf ? [retryOf, link_id] : [])),
    ),
    ...(kind === "extract"
      ? ids.map((link) =>
          env.DB.prepare(
            // The last error and reason stay until the new attempt settles, so a cancel can restore them.
            "UPDATE links SET content_state='queued' WHERE id=? AND user_id=? AND EXISTS (SELECT 1 FROM jobs WHERE batch_id=? AND link_id=links.id)",
          ).bind(link, userId, id),
        )
      : []),
  ]);
  } catch (error) {
    await charged.release();
    if (!jev && await env.DB.prepare("SELECT 1 FROM jobs WHERE link_id IN (SELECT value FROM json_each(?)) AND status IN ('queued','running','waiting') LIMIT 1").bind(JSON.stringify(ids)).first()) throw badRequest("Some selected links are still processing.");
    throw error;
  }
  const actual = await env.DB.prepare("SELECT count(*) n FROM jobs WHERE batch_id=?").bind(id).first<{ n: number }>();
  await charged.release({ [`jobs:${userId}`]: ids.length - (actual?.n ?? 0) });
  if (retryOf && !(await env.DB.prepare("SELECT 1 FROM jobs WHERE batch_id=?").bind(id).first())) {
    await env.DB.prepare("DELETE FROM batches WHERE id=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE batch_id=?)").bind(id, id).run();
    throw badRequest("These links were already retried.");
  }
  // D1 is the durable outbox. If dispatch fails, scheduled recovery resends these IDs.
  const queued = await env.DB.prepare("SELECT id FROM jobs WHERE batch_id=? AND status='queued'").bind(id).all<{ id: string }>();
  try {
    if (queued.results.length) await env.JOBS.sendBatch(queued.results.map((body) => ({ body })));
  } catch {
    console.error("Queue dispatch deferred to outbox recovery");
  }
  return { id, skipped };
}
export async function recover(env: Env) {
  const now = Date.now();
  // Housekeeping for app counters and expired auth verification rows. Better Auth prunes its own
  // rateLimit rows only when some key's window rolls over; rows idle for a day (windows are at
  // most 60 s; lastRequest is epoch milliseconds) are dead and go here too.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_rate_limits WHERE window_start<?").bind(Math.floor(now / 1000) - 2 * 86400),
    env.DB.prepare('DELETE FROM "rateLimit" WHERE "lastRequest"<?').bind(now - 86400_000),
    env.DB.prepare('DELETE FROM "verification" WHERE "expiresAt"<?').bind(new Date(now).toISOString()),
    env.DB.prepare('DELETE FROM "session" WHERE "expiresAt"<?').bind(new Date(now).toISOString()),
  ]);
  await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE status='started' AND job_id IN (SELECT id FROM jobs WHERE status IN ('done','failed'))").run();
  // A waiting job whose predecessor settled without promoting it (a crash in between) starts here.
  await promoteWaiting(env.DB).run();
  const rows = await env.DB.prepare(
    // Unassigned legacy batches stay untouched until adjudicated; they have no owner to run as.
    "SELECT j.id FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE b.user_id IS NOT NULL AND j.status IN ('queued','running') ORDER BY j.created_at LIMIT 100",
  ).all<{ id: string }>();
  if (rows.results.length)
    await env.JOBS.sendBatch(rows.results.map((body) => ({ body })));
}
export async function dispatch(batch: MessageBatch<{ id: string }>, env: Env) {
  for (const m of batch.messages) {
    try {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?")
        .bind(m.body.id)
        .first<JobRow>();
      // A waiting job is started by promotion, never by a stray message.
      if (!job || ["done", "failed", "waiting"].includes(job.status)) {
        m.ack();
        continue;
      }
      try {
        await env.PROCESS_LINK.create({ id: job.id, params: { id: job.id } });
      } catch (error) {
        // A redelivery must never create a second workflow or repeat its paid steps.
        const instance = await env.PROCESS_LINK.get(job.id);
        const status = await instance.status();
        if (!status) throw error;
        if (["errored", "terminated", "complete"].includes(status.status)) {
          // Every write is guarded by this invocation having settled the job as Interrupted: a job cancelled
          // (or settled) while the status was read is left alone, and so is whatever runs on its link now.
          const now = new Date().toISOString();
          const won = "EXISTS (SELECT 1 FROM jobs WHERE id=? AND step='Interrupted' AND completed_at=?)";
          const results = await env.DB.batch([
            env.DB.prepare(
              "UPDATE jobs SET status='failed',step='Interrupted',error=?,completed_at=? WHERE id=? AND status IN ('queued','running')",
            ).bind(
              job.target_id
                ? "The evaluation was interrupted. Retry it explicitly."
                : "Extraction was interrupted. Try again.",
              now,
              job.id,
            ),
            // Not a final failure: the link goes back to how it was, like a cancelled job, unless another
            // extraction owns its queued state.
            env.DB.prepare(
              `UPDATE links SET content_state=${restoredContentStateSql},content_error=CASE WHEN content_key IS NULL THEN content_error ELSE 'Extraction was interrupted. Try again.' END WHERE id=? AND content_state='queued' AND ${won} AND NOT EXISTS (SELECT 1 FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=links.id AND j.${busy} AND b.kind='extract')`,
            ).bind(job.link_id, job.id, now),
            env.DB.prepare(`DELETE FROM provider_leases WHERE job_id=? AND ${won}`).bind(job.id, job.id, now),
            ...(job.link_id ? [promoteWaiting(env.DB, job.link_id, { sql: won, params: [job.id, now] })] : []),
          ]);
          if (results[0]!.meta.changes) await startNext(env, [job.link_id]);
        }
      }
      m.ack();
    } catch {
      m.retry({ delaySeconds: 15 });
    }
  }
}
