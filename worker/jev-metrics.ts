// Timing events for Jev work (FAC-190), one JSON console line each, for Workers Logs. Ids and numbers only:
// never content, URLs or secrets. Logging never fails a job. They are called from where a Jev job starts,
// calls Jev and settles, so both runners of Jev jobs (the Jev queue's consumer, and the Workflow for jobs it
// started before that queue existed) use the same helpers.
import { runsInJevQueue, type BatchKind } from "./job-routing";

const emit = (event: string, fields: Record<string, unknown>) => {
  try { console.log(JSON.stringify({ event, ...fields })); } catch { /* metrics must never fail a job */ }
};
const since = (iso: string | null | undefined, now = Date.now()) => {
  const at = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
};

type Ids = { id: string; batch_id: string; created_at?: string };

/** A Jev job left the queue and began running. `queue_wait_ms` runs from the job's creation (a job behind another on the same link waits for it too). */
export function logJevJobStarted(job: Ids & { kind: BatchKind }) {
  if (!runsInJevQueue(job.kind)) return;
  emit("jev_job_started", { job_id: job.id, batch_id: job.batch_id, kind: job.kind, queue_wait_ms: since(job.created_at) });
}

/** One sent Jev call. `waited_ms` is the job's age when the call was sent (queue wait plus any slot wait). */
export function logJevCall(job: Ids, call: { provider: string; latency_ms: number; waited_ms?: number | null; ok: boolean; http_status: number | null; reason: string | null }) {
  emit("jev_call", { job_id: job.id, batch_id: job.batch_id, ...call, waited_ms: call.waited_ms ?? since(job.created_at) });
}

/** Jev answered 429. Count these events for the number of rate limits. */
export function logJevRateLimited(job: Ids, retryAfter: string | null) {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  emit("jev_rate_limited", { job_id: job.id, batch_id: job.batch_id, retry_after_s: Number.isFinite(seconds) ? seconds : null });
}

/**
 * Call after a Jev job settles (done or failed). Logs `jev_batch_first_result` from the job that settled the
 * batch's first success, and `jev_batch_done` when no job of the batch is left. Two jobs settling together may
 * both log the done event: read it as the latest line per batch.
 */
export async function logJevBatchProgress(env: Env, job: { id: string; kind: BatchKind }) {
  const { id: jobId, kind } = job;
  if (!runsInJevQueue(kind)) return;
  try {
    const row = await env.DB.prepare(
      `SELECT j.batch_id,j.status,j.completed_at,b.created_at,
        EXISTS (SELECT 1 FROM jobs WHERE batch_id=j.batch_id AND status IN ('queued','running','waiting')) AS open,
        EXISTS (SELECT 1 FROM jobs WHERE batch_id=j.batch_id AND status='done' AND id<>j.id AND completed_at<j.completed_at) AS earlier
       FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?`,
    ).bind(jobId).first<{ batch_id: string; status: string; completed_at: string | null; created_at: string; open: number; earlier: number }>();
    if (!row || !row.completed_at) return;
    let firstMs: number | null = null;
    if (row.status === "done" && !row.earlier) {
      firstMs = since(row.created_at, Date.parse(row.completed_at));
      emit("jev_batch_first_result", { batch_id: row.batch_id, kind, job_id: jobId, ms: firstMs });
    }
    if (row.open) return;
    const total = await env.DB.prepare(
      `SELECT count(*) AS jobs,sum(status='done') AS done,sum(status='failed') AS failed,max(completed_at) AS last,
        min(CASE WHEN status='done' THEN completed_at END) AS first
       FROM jobs WHERE batch_id=?`,
    ).bind(row.batch_id).first<{ jobs: number; done: number; failed: number; last: string | null; first: string | null }>();
    if (!total) return;
    const start = Date.parse(row.created_at);
    emit("jev_batch_done", {
      batch_id: row.batch_id,
      kind,
      jobs: total.jobs,
      done: total.done,
      failed: total.failed,
      first_result_ms: total.first ? Date.parse(total.first) - start : null,
      duration_ms: total.last ? Date.parse(total.last) - start : null,
    });
  } catch { /* metrics must never fail a job */ }
}
