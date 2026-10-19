import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { browserHandlers, handlers, type BrowserTargetRow, type Pool } from "./handlers";
import { preservedContentStateSql } from "./content-state";
import { poolLimit, contentMissing, promoteWaiting, startNext, type Config, type JobRow } from "./jobs";
import type { Link } from "../src/types";

import { contentPrefix } from "./store";
import { contentFailureAttentionSql } from "./attention";
import { canUsePreview, dropUnusedPreview, readPreview, storePreview, usePreviewStatement } from "./preview-content";
import { adapterMessage, classify, logResidualFailure, LinkFailure } from "./failures";
import { JevFailure } from "./ai/jev";
import { JEV_FAILURE_MESSAGES } from "../src/failures";

export type LoadedJob = JobRow & { kind: string; config: string; user_id: string };
/**
 * Resolves the job owner from the persisted batch and loads its link or browser capture only for
 * that owner. Exported for tests: a job whose target belongs to someone else, or whose batch has
 * no owner, never runs.
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
  // A job targets either a saved link or a browser capture, never both.
  const link = row.link_id
    ? await db.prepare("SELECT * FROM links WHERE id=? AND user_id=?")
        .bind(row.link_id, row.user_id)
        .first<Link>()
    : null;
  const target = row.target_id
    ? await db.prepare(
        "SELECT bt.id,bt.request_id,bt.target_key,bt.url,bt.title,bt.capture_key,bt.capture_meta FROM browser_targets bt JOIN browser_requests r ON r.request_id=bt.request_id WHERE bt.id=? AND r.user_id=?",
      )
        .bind(row.target_id, row.user_id)
        .first<BrowserTargetRow>()
    : null;
  if (!link && !target)
    throw new Error(row.target_id ? "The browser capture no longer exists." : "The link no longer exists.");
  return { job: row as LoadedJob, link, target };
}


export class LinkWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    const env = this.env;
    const data = await step.do("load-job", async () => {
      const { job: row, link, target } = await loadOwnedJob(env.DB, event.payload.id);
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
        if (!lease) await step.do(`waiting-label-${attempt}`, async () => { await env.DB.prepare("UPDATE jobs SET step=? WHERE id=? AND status='running'").bind(pool === "browser" ? "Waiting for Browser slot" : "Waiting for Jev slot", job.id).run(); });
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
        // A final content failure with no valid content uses genuine title/description metadata automatically.
        // The text is stored first under this job's key; it only becomes the content if the same transaction
        // still finds the job running and the row without content and with that same metadata.
        // Anything that ends extraction for good without content (a login wall too) settles here.
        const fallbackKey = `${contentPrefix(job.user_id, link?.id ?? "")}${job.id}-preview.md`;
        let usedPreview = false;
        // The preview axis is owned by save-preview: a preview that never ran stays neutral.
        if (job.kind === "extract" && link) {
          const set = contentFailureAttentionSql(reason, progress.preview === "ok");
          statements.push(env.DB.prepare(
            `UPDATE links SET content_state=${preservedContentStateSql("failed")},content_error=?,content_reason=?,${set.sql} WHERE id=? AND ${running}`,
          ).bind(message, reason, ...set.params, link!.id, job.id));
          const preview = await readPreview(env.DB, job.user_id, link.id);
          // The fallback is optional: if its text can't be stored, the original failure still settles as usual.
          if (preview && canUsePreview(preview) && await storePreview(env, fallbackKey, preview, { link_id: link.id, job_id: job.id })) {
            statements.push(usePreviewStatement(env.DB, link.id, fallbackKey, preview, running, job.id));
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
        try {
          await env.DB.batch(statements);
        } finally {
          if (usedPreview) await dropUnusedPreview(env, link!.id, fallbackKey);
        }
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
