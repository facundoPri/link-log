import type { JobConfig, Pool } from "./handlers";
import { parseLensDefinition } from "./store";
import { preservedContentStateSql } from "./content-state";
import { consume, LIMITS, LimitError } from "./limits";
import type { Lens, Link, Tag } from "../src/types";
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
/**
 * Creates a batch for `userId`. Links, tags and the lens are loaded with the owner in the WHERE
 * clause, so a foreign or unassigned ID behaves exactly like a missing one. The owner is persisted
 * on the batch; Queue/Workflow/cron later resolve it from D1, never from a request body.
 */
export async function enqueue(
  env: Env,
  userId: string,
  ids: string[],
  kind: "extract" | "autotag" | "lens",
  lensId?: string,
  track?: string,
) {
  ids = [...new Set(ids)];
  if (!ids.length || ids.length > 100)
    throw new Error("Select between 1 and 100 links per batch.");
  const links = await env.DB.prepare(
    `SELECT * FROM links WHERE user_id=? AND id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(userId, ...ids)
    .all<Link>();
  if (links.results.length !== ids.length)
    throw new Error("One of the links no longer exists.");
  if (kind !== "extract" && links.results.some((l) => !l.content_key))
    throw new Error(
      "All selected links need context first.",
    );
  const active = await env.DB.prepare(
    `SELECT id FROM jobs WHERE status IN ('queued','running') AND link_id IN (${ids.map(() => "?").join(",")}) LIMIT 1`,
  )
    .bind(...ids)
    .first();
  if (active)
    throw new Error("Some selected links are still processing.");
  let config: Config = {};
  if (kind === "autotag") {
    const tags = await env.DB.prepare(
      "SELECT id,name,description,threshold,version FROM tags WHERE user_id=? ORDER BY name",
    ).bind(userId).all<Tag>();
    if (!tags.results.length) throw new Error("Create at least one tag.");
    config = { tags: tags.results };
  }
  if (kind === "lens") {
    const row = await env.DB.prepare("SELECT id,name,type,question,options,threshold,version,created_at,scope FROM lenses WHERE id=? AND user_id=?")
      .bind(lensId ?? "", userId)
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
  if (kind === "extract" && track) config = { track };
  if (!(await consume(env.DB, `jobs:${userId}`, LIMITS.jobsPerUser, ids.length)))
    throw new LimitError("Processing limit reached. Try again later.");
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const jobs = ids.map((link_id) => ({ id: crypto.randomUUID(), link_id }));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO batches(id,user_id,kind,config,created_at) VALUES(?,?,?,?,?)",
    ).bind(id, userId, kind, JSON.stringify(config), now),
    ...jobs.map((j) =>
      env.DB.prepare(
        "INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES(?,?,?,?)",
      ).bind(j.id, id, j.link_id, now),
    ),
    ...(kind === "extract"
      ? ids.map((link) =>
          env.DB.prepare(
            "UPDATE links SET content_state='queued',content_error=NULL WHERE id=? AND user_id=?",
          ).bind(link, userId),
        )
      : []),
  ]);
  // D1 is the durable outbox. If dispatch fails, scheduled recovery resends these IDs.
  try {
    await env.JOBS.sendBatch(jobs.map((j) => ({ body: { id: j.id } })));
  } catch {
    console.error("Queue dispatch deferred to outbox recovery");
  }
  return id;
}
export async function recover(env: Env) {
  const now = Date.now();
  // Housekeeping for app counters and expired auth verification rows.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM app_rate_limits WHERE window_start<?").bind(Math.floor(now / 1000) - 2 * 86400),
    env.DB.prepare('DELETE FROM "verification" WHERE "expiresAt"<?').bind(new Date(now).toISOString()),
    env.DB.prepare('DELETE FROM "session" WHERE "expiresAt"<?').bind(new Date(now).toISOString()),
  ]);
  await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE status='started' AND job_id IN (SELECT id FROM jobs WHERE status IN ('done','failed'))").run();
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
      if (!job || ["done", "failed"].includes(job.status)) {
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
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE jobs SET status='failed',step='Interrupted',error=?,completed_at=? WHERE id=? AND status IN ('queued','running')",
            ).bind(
              job.target_id
                ? "The evaluation was interrupted. Retry it explicitly."
                : "Extraction was interrupted. Try again.",
              new Date().toISOString(),
              job.id,
            ),
            env.DB.prepare(
              `UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error='Extraction was interrupted. Try again.' WHERE id=? AND content_state='queued'`,
            ).bind(job.link_id),
            env.DB.prepare("DELETE FROM provider_leases WHERE job_id=?").bind(
              job.id,
            ),
          ]);
        }
      }
      m.ack();
    } catch {
      m.retry({ delaySeconds: 15 });
    }
  }
}
