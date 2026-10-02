import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { handlers } from "./handlers";
import { preservedContentStateSql } from "./content-state";
import { poolLimit, type Config, type JobRow } from "./jobs";
import type { Link } from "../src/types";

export type LoadedJob = JobRow & { kind: string; config: string; user_id: string };
/**
 * Resolves the job owner from the persisted batch and loads the link only for that owner.
 * Exported for tests: a job whose link and batch disagree, or whose batch has no owner, never runs.
 */
export async function loadOwnedJob(db: D1Database, jobId: string) {
  const row = await db.prepare(
    "SELECT j.*,b.kind,b.config,b.user_id FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?",
  )
    .bind(jobId)
    .first<JobRow & { kind: string; config: string; user_id: string | null }>();
  if (!row) throw new Error("The job no longer exists.");
  if (!row.user_id) throw new Error("The job has no owner.");
  if (row.status !== "queued")
    throw new Error("The job was cancelled before it started.");
  const link = await db.prepare("SELECT * FROM links WHERE id=? AND user_id=?")
    .bind(row.link_id, row.user_id)
    .first<Link>();
  if (!link) throw new Error("The link no longer exists.");
  return { job: row as LoadedJob, link };
}
export class LinkWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    const env = this.env;
    const data = await step.do("load-job", async () => {
      const { job: row, link } = await loadOwnedJob(env.DB, event.payload.id);
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
            `UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error=?,status=CASE WHEN status='pending' THEN 'failed' ELSE status END WHERE id=? AND user_id=?`,
          )
            .bind(message, link.id, job.user_id)
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
