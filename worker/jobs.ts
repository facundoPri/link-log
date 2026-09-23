import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { handlers, type Pool } from "./handlers";
import { parseLensDefinition } from "./store";
import { preservedContentStateSql } from "./content-state";
import type { Lens, Link, Tag } from "../src/types";
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
  link_id: string;
  status: string;
};
type Config = { tags?: Tag[]; lens?: Lens; track?: string };
export async function enqueue(
  env: Env,
  ids: string[],
  kind: "extract" | "autotag" | "lens",
  lensId?: string,
  track?: string,
) {
  ids = [...new Set(ids)];
  if (!ids.length || ids.length > 100)
    throw new Error("Select between 1 and 100 links per batch.");
  const links = await env.DB.prepare(
    `SELECT * FROM links WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
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
  const id = crypto.randomUUID(),
    now = new Date().toISOString();
  const jobs = ids.map((link_id) => ({ id: crypto.randomUUID(), link_id }));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO batches(id,kind,config,created_at) VALUES(?,?,?,?)",
    ).bind(id, kind, JSON.stringify(config), now),
    ...jobs.map((j) =>
      env.DB.prepare(
        "INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES(?,?,?,?)",
      ).bind(j.id, id, j.link_id, now),
    ),
    ...(kind === "extract"
      ? ids.map((link) =>
          env.DB.prepare(
            "UPDATE links SET content_state='queued',content_error=NULL WHERE id=?",
          ).bind(link),
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
  await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE status='started' AND job_id IN (SELECT id FROM jobs WHERE status IN ('done','failed'))").run();
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
              "UPDATE jobs SET status='failed',step='Interrupted',error='Extraction was interrupted. Try again.',completed_at=? WHERE id=? AND status IN ('queued','running')",
            ).bind(new Date().toISOString(), job.id),
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
      const link = await env.DB.prepare("SELECT * FROM links WHERE id=?")
        .bind(row.link_id)
        .first<Link>();
      if (!link) throw new Error("The link no longer exists.");
      await env.DB.prepare(
        "UPDATE jobs SET status='running',step='Preparing content' WHERE id=? AND status='queued'",
      )
        .bind(row.id)
        .run();
      return { job: row, link };
    });
    const { job, link } = data;
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new Error(`No handler for job kind "${job.kind}".`);
      const ctx = {
        env,
        step,
        job,
        link,
        config: JSON.parse(job.config) as Config,
      };
      const pool = handler.pool(ctx);
      if (pool) {
        const limit = poolLimit(env, pool);
        let lease = false;
        for (let attempt = 0; !lease; attempt++) {
          lease = await step.do(`provider-slot-${attempt}`, async () => {
            const now = Date.now();
            await env.DB.prepare(
              "DELETE FROM provider_leases WHERE expires_at<?",
            )
              .bind(now)
              .run();
            const result = await env.DB.prepare(
              "INSERT OR IGNORE INTO provider_leases(job_id,pool,expires_at) SELECT ?,?,? WHERE (SELECT count(*) FROM provider_leases WHERE pool=?)<?",
            )
              .bind(job.id, pool, now + 300000, pool, limit)
              .run();
            return (
              result.meta.changes > 0 ||
              !!(await env.DB.prepare(
                "SELECT job_id FROM provider_leases WHERE job_id=?",
              )
                .bind(job.id)
                .first())
            );
          });
          if (!lease)
            await step.sleep(`waiting-for-slot-${attempt}`, "2 seconds");
        }
      }
      await handler.run(ctx);
      await step.do("complete", async () => {
        await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion',duration_ms=?-strftime('%s',created_at)*1000 WHERE job_id=? AND status='started'")
          .bind(Date.now(), job.id).run();
        await env.DB.prepare(
          "UPDATE jobs SET status='done',step='Done',completed_at=? WHERE id=?",
        )
          .bind(new Date().toISOString(), job.id)
          .run();
      });
    } catch (error) {
      await step.do("record-failure", async () => {
        await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE job_id=? AND status='started'").bind(job.id).run();
        const message =
          error instanceof Error ? error.message : "Could not process";
        await env.DB.prepare(
          "UPDATE jobs SET status='failed',step='Needs attention',error=?,completed_at=? WHERE id=? AND status='running'",
        )
          .bind(message, new Date().toISOString(), job.id)
          .run();
        if (job.kind === "extract")
          await env.DB.prepare(
            `UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error=?,status=CASE WHEN status='pending' THEN 'failed' ELSE status END WHERE id=?`,
          )
            .bind(message, link.id)
            .run();
      });
    } finally {
      await step.do("release-provider-slot", async () => {
        await env.DB.prepare("DELETE FROM provider_leases WHERE job_id=?")
          .bind(job.id)
          .run();
      });
    }
  }
}
