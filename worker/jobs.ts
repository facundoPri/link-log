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
import { adapterMessage, classify, logResidualFailure, LinkFailure } from "./failures";
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
  link_id: string | null;
  target_id?: string | null;
  status: string;
};
type Config = JobConfig;
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
  const links = await env.DB.prepare(
    `SELECT * FROM links WHERE id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(...ids)
    .all<Link>();
  if (links.results.length !== ids.length)
    throw new Error("One of the links no longer exists.");
  if (jev && links.results.some((l) => !l.content_key))
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
            // The last error and reason stay until the new attempt settles, so a cancel can restore them.
            "UPDATE links SET content_state='queued' WHERE id=?",
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
              "UPDATE jobs SET status='failed',step='Interrupted',error=?,completed_at=? WHERE id=? AND status IN ('queued','running')",
            ).bind(
              job.target_id
                ? "The evaluation was interrupted. Retry it explicitly."
                : "Extraction was interrupted. Try again.",
              new Date().toISOString(),
              job.id,
            ),
            // Not a final failure: the link goes back to how it was, like a cancelled job.
            env.DB.prepare(
              `UPDATE links SET content_state=${restoredContentStateSql},content_error=CASE WHEN content_key IS NULL THEN content_error ELSE 'Extraction was interrupted. Try again.' END WHERE id=? AND content_state='queued'`,
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
      await env.DB.prepare(
        "UPDATE jobs SET status='running',step='Preparing content' WHERE id=? AND status='queued'",
      )
        .bind(row.id)
        .run();
      return { job: row, link, target };
    });
    const { job, link, target } = data;
    const progress: { preview?: "ok" | "failed" } = {};
    const acquire = async (pool: Pool | null) => {
      if (!pool) return;
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
        await acquire(handler.pool(ctx));
        await handler.run(ctx);
      }
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
      await step.do("record-failure", { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } }, async () => {
        await env.DB.prepare("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion' WHERE job_id=? AND status='started'").bind(job.id).run();
        const raw = error instanceof Error ? error.message : "Could not process";
        // Extraction shows a plain reason, or an adapter message written for users; raw detail goes to the logs.
        const failure = (job.kind === "extract" || job.kind === "preview") && link ? classify(error) : null;
        if (failure && !(error instanceof LinkFailure))
          await logResidualFailure(env, failure, { link_id: link!.id, job_id: job.id, url: link!.url });
        const reason = failure?.reason ?? null;
        const message = failure ? (adapterMessage(raw) ?? failure.message) : raw;
        // One transaction: the job's terminal status, the link's failure and its Needs attention. Every write is
        // guarded by the job still running, so a repeated callback finishes an unfinished settlement while a
        // cancelled or interrupted job (already settled elsewhere) is left alone.
        const running = "EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='running')";
        const statements: D1PreparedStatement[] = [];
        // The preview axis is owned by save-preview: a preview that never ran stays neutral.
        if (job.kind === "extract" && link) {
          const set = contentFailureAttentionSql(reason, progress.preview === "ok");
          statements.push(env.DB.prepare(
            `UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error=?,content_reason=?,${set.sql} WHERE id=? AND ${running}`,
          ).bind(message, reason, ...set.params, link!.id, job.id));
        }
        statements.push(env.DB.prepare(
          "UPDATE jobs SET status='failed',step='Needs attention',error=?,reason=?,completed_at=? WHERE id=? AND status='running'",
        ).bind(message, reason, new Date().toISOString(), job.id));
        await env.DB.batch(statements);
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
