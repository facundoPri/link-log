import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import {
  browserHandlers,
  handlers,
  type BrowserTargetRow,
  type JobConfig,
  type Pool,
} from "./handlers";
import { capabilities, parseLensDefinition } from "./store";
import { jevUnavailable } from "../src/attention";
import { preservedContentStateSql, restoredContentStateSql } from "./content-state";
import { contentFailureAttentionSql } from "./attention";
import { canUsePreview, previewFallbackOn, previewFallbackSetting, readPreview, storePreview, usePreviewStatement } from "./preview-content";
import { adapterMessage, classify, logResidualFailure, LinkFailure } from "./failures";
import type { Lens, Link, Tag } from "../src/types";
import { JevFailure } from "./ai/jev";
import { JEV_FAILURE_MESSAGES } from "../src/failures";
const POOL_LIMITS = { browser: 2, jev: 16 } as const;
function poolLimit(env: Env, pool: Pool) {
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
  link_id: string | null;
  target_id?: string | null;
  status: string;
};
type Config = JobConfig;
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
  const rows = await env.DB.prepare(`SELECT id FROM jobs WHERE status='queued' AND link_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).all<{ id: string }>();
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
      throw new Error("Could not stop this job. Try again.");
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
export async function cancelJob(env: Env, id: string) {
  for (let round = 0; round < 3; round++) {
    const job = await env.DB.prepare("SELECT j.id,j.batch_id,j.link_id,j.status,b.kind FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?")
      .bind(id).first<JobRow & { kind: string }>();
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
  throw new Error("The job changed meanwhile. Try again.");
}
export async function enqueue(
  env: Env,
  ids: string[],
  kind: "extract" | "preview" | "autotag" | "lens",
  lensId?: string,
  extract: Pick<Config, "track" | "step"> = {},
) {
  const jev = kind === "autotag" || kind === "lens";
  ids = [...new Set(ids)];
  if (!ids.length || ids.length > 100)
    throw new Error("Select between 1 and 100 links per batch.");
  const unavailable = !jev ? null : jevUnavailable(capabilities(env));
  if (unavailable) {
    console.error(JSON.stringify({ event: "jev_not_configured", kind, provider: capabilities(env).provider, links: ids.length }));
    throw new Error(unavailable);
  }
  const marks = ids.map(() => "?").join(",");
  const links = await env.DB.prepare(
    `SELECT id,content_key,EXISTS (SELECT 1 FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=links.id AND j.${busy} AND b.kind='extract') extracting,EXISTS (SELECT 1 FROM jobs j WHERE j.link_id=links.id AND j.${busy}) busy FROM links WHERE id IN (${marks})`,
  )
    .bind(...ids)
    .all<{ id: string; content_key: string | null; extracting: number; busy: number }>();
  if (links.results.length !== ids.length)
    throw new Error("One of the links no longer exists.");
  // Jev runs on links with content or with an extraction on the way; it never starts an extraction itself.
  const skipped = jev ? links.results.filter((l) => !l.content_key && !l.extracting).map((l) => l.id) : [];
  if (skipped.length === ids.length)
    throw new NothingToRun(ids.length === 1 ? "This link has no content yet. Extract it first." : "None of the selected links have content yet. Extract them first.", skipped);
  if (!jev && links.results.some((l) => l.busy))
    throw new Error("Some selected links are still processing.");
  ids = ids.filter((id) => !skipped.includes(id));
  let config: Config = {};
  if (kind === "autotag") {
    const tags = await env.DB.prepare(
      "SELECT * FROM tags ORDER BY name",
    ).all<Tag>();
    if (!tags.results.length) throw new Error("Create at least one tag.");
    config = { tags: tags.results };
  }
  if (kind === "lens") {
    const row = await env.DB.prepare("SELECT * FROM lenses WHERE id=?")
      .bind(lensId)
      .first<Record<string, unknown>>();
    if (!row) throw new Error("The lens no longer exists.");
    if (row.scope === "browser")
      throw new Error("Browser lenses evaluate open tabs, not saved links.");
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
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO batches(id,kind,config,created_at) VALUES(?,?,?,?)",
    ).bind(id, kind, JSON.stringify(config), now),
    // Decided inside the transaction, so a concurrent enqueue can't put two active jobs on one link.
    ...ids.map((link_id) =>
      env.DB.prepare(
        `INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES(?,?,?,CASE WHEN EXISTS (SELECT 1 FROM jobs WHERE link_id=? AND ${busy}) THEN 'waiting' ELSE 'queued' END,?)`,
      ).bind(crypto.randomUUID(), id, link_id, link_id, now),
    ),
    ...(kind === "extract"
      ? ids.map((link) =>
          env.DB.prepare(
            // The last error and reason stay until the new attempt settles, so a cancel can restore them.
            "UPDATE links SET content_state='queued' WHERE id=?",
          ).bind(link),
        )
      : []),
  ]);
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
  await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE status='started' AND job_id IN (SELECT id FROM jobs WHERE status IN ('done','failed'))").run();
  // A waiting job whose predecessor settled without promoting it (a crash in between) starts here.
  await promoteWaiting(env.DB).run();
  const rows = await env.DB.prepare(
    "SELECT id FROM jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100",
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
export class LinkWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    const env = this.env;
    const data = await step.do("load-job", async () => {
      const row = await env.DB.prepare(
        "SELECT j.*,b.kind,b.config FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?",
      )
        .bind(event.payload.id)
        .first<JobRow & { kind: string; config: string }>();
      if (!row) throw new Error("The job no longer exists.");
      if (row.status !== "queued")
        throw new Error("The job was cancelled before it started.");
      // A job targets either a saved link or a browser capture, never both.
      const link = row.link_id
        ? await env.DB.prepare("SELECT * FROM links WHERE id=?")
            .bind(row.link_id)
            .first<Link>()
        : null;
      const target = row.target_id
        ? await env.DB.prepare(
            "SELECT id,request_id,target_key,url,title,capture_key,capture_meta FROM browser_targets WHERE id=?",
          )
            .bind(row.target_id)
            .first<BrowserTargetRow>()
        : null;
      if (!link && !target)
        throw new Error(
          row.target_id
            ? "The browser capture no longer exists."
            : "The link no longer exists.",
        );
      const started = await env.DB.prepare(
        "UPDATE jobs SET status='running',step='Preparing content' WHERE id=? AND status='queued'",
      )
        .bind(row.id)
        .run();
      // Cancelled between the read and the start.
      if (!started.meta.changes) throw new Error("The job was cancelled before it started.");
      return { job: row, link, target };
    });
    const { job, link, target } = data;
    const progress: { preview?: "ok" | "failed" } = {};
    let stoppedLinks: (string | null)[] = [];
    const acquire = async (pool: Pool | null) => {
      if (!pool) return;
      const limit = poolLimit(env, pool);
      let lease: boolean | null = false;
      for (let attempt = 0; !lease; attempt++) {
        lease = await step.do(`provider-slot-${attempt}`, async (): Promise<boolean | null> => {
          const now = Date.now();
          await env.DB.prepare(
            "DELETE FROM provider_leases WHERE expires_at<?",
          )
            .bind(now)
            .run();
          const result = await env.DB.prepare(
            // Only a running job takes a slot: a cancelled one never gets its lease back.
            "INSERT OR IGNORE INTO provider_leases(job_id,pool,expires_at) SELECT ?,?,? WHERE (SELECT count(*) FROM provider_leases WHERE pool=?)<? AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='running')",
          )
            .bind(job.id, pool, now + 300000, pool, limit, job.id)
            .run();
          if (result.meta.changes > 0 || await env.DB.prepare("SELECT job_id FROM provider_leases WHERE job_id=?").bind(job.id).first())
            return true;
          // Stop waiting for a slot once the job is no longer running (cancelled).
          return (await env.DB.prepare("SELECT 1 FROM jobs WHERE id=? AND status='running'").bind(job.id).first()) ? false : null;
        });
        if (lease === null) throw new Error("The job is no longer running.");
        if (!lease)
          await step.sleep(`waiting-for-slot-${attempt}`, "2 seconds");
      }
    };
    try {
      const config = JSON.parse(job.config) as Config;
      if (target) {
        const handler = browserHandlers[job.kind];
        if (!handler) throw new Error(`No handler for job kind "${job.kind}".`);
        const ctx = { env, step, job, target, config };
        await acquire(handler.pool(ctx));
        await handler.run(ctx);
      } else {
        const handler = handlers[job.kind];
        if (!handler) throw new Error(`No handler for job kind "${job.kind}".`);
        const ctx = { env, step, job, link: link!, config, progress };
        const pool = handler.pool(ctx);
        // Jev that waited for an extraction which ended without content fails here, free: no slot, no provider
        // call, no Needs attention, and no extraction started on its behalf.
        if (pool === "jev" && !link!.content_key) throw new Error(contentMissing);
        await acquire(pool);
        await handler.run(ctx);
      }
      await step.do("complete", async () => {
        await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion',duration_ms=?-strftime('%s',created_at)*1000 WHERE job_id=? AND status='started'")
          .bind(Date.now(), job.id).run();
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE jobs SET status='done',step='Done',completed_at=? WHERE id=? AND status='running'",
          ).bind(new Date().toISOString(), job.id),
          ...(job.link_id ? [promoteWaiting(env.DB, job.link_id)] : []),
        ]);
      });
    } catch (error) {
      stoppedLinks = await step.do("record-failure", { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }, async () => {
        await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE job_id=? AND status='started'").bind(job.id).run();
        const raw = error instanceof Error ? error.message : "Could not process";
        // Extraction shows a plain reason, or an adapter message written for users; raw detail goes to the logs.
        const failure = (job.kind === "extract" || job.kind === "preview") && link ? classify(error) : null;
        if (failure && !(error instanceof LinkFailure))
          await logResidualFailure(env, failure, { link_id: link!.id, job_id: job.id, url: link!.url });
        const jev = error instanceof JevFailure ? error : null;
        const reason = failure?.reason ?? jev?.reason ?? null;
        const message = failure ? (adapterMessage(raw) ?? failure.message) : raw;
        // One transaction: the job's terminal status, the link's failure and its Needs attention. Every write is
        // guarded by the job still running, so a repeated callback finishes an unfinished settlement while a
        // cancelled or interrupted job (already settled elsewhere) is left alone.
        const running = "EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='running')";
        const statements: D1PreparedStatement[] = [];
        // A final content failure with no content to show can use the preview instead, when the setting is on.
        // The text is stored first under this job's key; it only becomes the content if the same transaction
        // still finds the setting on, the job running and the row without content and with that preview.
        // Anything that ends extraction for good without content (a login wall too) settles here.
        const fallbackKey = `links/${link?.id}/${job.id}-preview.md`;
        let usedPreview = false;
        // The preview axis is owned by save-preview: a preview that never ran stays neutral.
        if (job.kind === "extract" && link) {
          const set = contentFailureAttentionSql(reason, progress.preview === "ok");
          statements.push(env.DB.prepare(
            `UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error=?,content_reason=?,${set.sql} WHERE id=? AND ${running}`,
          ).bind(message, reason, ...set.params, link!.id, job.id));
          const preview = await readPreview(env.DB, link.id);
          // The fallback is optional: if its text can't be stored, the original failure still settles as usual.
          if (preview && canUsePreview(preview) && await previewFallbackOn(env.DB) && await storePreview(env, fallbackKey, preview, { link_id: link.id, job_id: job.id })) {
            statements.push(usePreviewStatement(env.DB, link.id, fallbackKey, preview, `${previewFallbackSetting} AND ${running}`, job.id));
            usedPreview = true;
          }
        }
        // Activity keeps the original failure; the step notes when the preview was used instead.
        // Jev, lens and browser failures never put a link in Needs attention.
        const failedStep = job.kind === "extract" || job.kind === "preview" ? "'Needs attention'" : "'Failed'";
        const now = new Date().toISOString();
        statements.push(env.DB.prepare(
          `UPDATE jobs SET status='failed',step=${usedPreview ? `CASE WHEN EXISTS (SELECT 1 FROM links WHERE id=? AND content_key=?) THEN 'Used the preview' ELSE ${failedStep} END` : failedStep},error=?,reason=?,completed_at=? WHERE id=? AND status='running'`,
        ).bind(...(usedPreview ? [link!.id, fallbackKey] : []), message, reason, now, job.id));
        // The link's next waiting job starts in the same transaction that settles this one.
        if (job.link_id) statements.push(promoteWaiting(env.DB, job.link_id));
        // Jev refused the account: the rest of the batch would fail the same way, so it stops without calling.
        // Running jobs see this job's reason before they send (see judge).
        let stopped: (string | null)[] = [];
        if (jev?.reason === "account") {
          stopped = (await env.DB.prepare("SELECT link_id FROM jobs WHERE batch_id=? AND id<>? AND status IN ('queued','waiting')")
            .bind(job.batch_id, job.id).all<{ link_id: string | null }>()).results.map((r) => r.link_id);
          statements.push(
            env.DB.prepare(
              `UPDATE jobs SET status='failed',step='Stopped',error=?,reason='account_stopped',completed_at=? WHERE batch_id=? AND id<>? AND status IN ('queued','waiting') AND EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='failed' AND reason='account')`,
            ).bind(JEV_FAILURE_MESSAGES.account_stopped, now, job.batch_id, job.id, job.id),
            // Jobs of other batches waiting behind a stopped one start now.
            promoteWaiting(env.DB),
          );
          console.log(JSON.stringify({ event: "jev_batch_stopped", batch_id: job.batch_id, job_id: job.id, http_status: jev.detail.http_status ?? null, stopped: stopped.length }));
        }
        await env.DB.batch(statements);
        return stopped;
      });
    } finally {
      await step.do("release-provider-slot", async () => {
        await env.DB.prepare("DELETE FROM provider_leases WHERE job_id=?")
          .bind(job.id)
          .run();
      });
      const next = [job.link_id, ...stoppedLinks];
      if (next.some(Boolean)) await step.do("start-next", () => startNext(env, next));
    }
  }
}
