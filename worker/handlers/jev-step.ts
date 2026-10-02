import type { WorkflowStep } from "cloudflare:workers";
import { beforeCall, judge, JevFailure, type JevPhase, type Question } from "../ai/jev";

// Owner decision (FAC-54): one automatic retry, only for known border cases before the call (a transient
// R2 read or D1 conflict/timeout). Once the request may have been sent, Jev is never retried automatically.
const JEV_RETRIES = { limit: 1, delay: "5 seconds" } as const;
type Failed = { failed: { phase: JevPhase; reason: JevFailure["reason"]; message: string; http_status: number | null } };
type Job = { id: string; batch_id: string; link_id: string | null; kind: string };

/** Reads saved text from R2. A thrown read is a transient storage error; a missing object is not. */
export async function readSaved(env: Env, key: string | null, missing: string) {
  let object: R2ObjectBody | null;
  try {
    object = key ? await env.CONTENT.get(key) : null;
    if (object) return await object.text();
  } catch (e) {
    throw new JevFailure("before_call", "storage_busy", undefined, { technical: e instanceof Error ? e.message : String(e) });
  }
  throw new JevFailure("before_call", "before_call", missing);
}

/** One structured line per failed Jev attempt, for Workers Logs. */
function logJevFailure(env: Env, failure: JevFailure, job: Job, attempt: number, final: boolean) {
  console.log(JSON.stringify({
    event: "jev_step_failed",
    job_id: job.id,
    batch_id: job.batch_id,
    link_id: job.link_id,
    kind: job.kind,
    provider: env.JEV_PROVIDER || "cloudflare",
    attempt,
    max_attempts: JEV_RETRIES.limit + 1,
    final,
    phase: failure.phase,
    reason: failure.reason,
    retryable: failure.retryable,
    http_status: failure.detail.http_status ?? null,
    detail: failure.detail.technical?.replace(/https?:\/\/\S+/g, "<url>").slice(0, 300) ?? null,
  }));
}

/**
 * The Jev call of a job, as its own step. `prepare` loads what Jev needs (no provider call). A pre-call border
 * case is retried once; any other failure is final and returned as data, then thrown as a JevFailure, so the
 * failure path can tell its phase and reason.
 */
export async function evaluateWithJev(
  env: Env,
  step: WorkflowStep,
  job: Job,
  prepare: () => Promise<{ state: unknown; questions: Record<string, Question> }>,
) {
  const max = JEV_RETRIES.limit + 1;
  const result = await step.do("evaluate-jev", { retries: JEV_RETRIES, timeout: "2 minutes" }, async (ctx) => {
    let failure: JevFailure;
    try {
      // A previous attempt that wrote a usage row may have reached the provider before the engine ended it.
      if (ctx.attempt > 1 && await env.DB.prepare("SELECT 1 FROM usage_events WHERE job_id=? AND service='jev'").bind(job.id).first())
        failure = new JevFailure("sent", "interrupted", undefined, { technical: "A previous attempt sent the request" });
      else {
        await env.DB.batch([
          // Activity only counts attempts once a retry happens.
          env.DB.prepare(`UPDATE jobs SET step='Evaluating with Jev',attempt=?,max_attempts=?,attempt_started_at=?,attempt_budget_ms=?${ctx.attempt === 1 ? ",reason=NULL" : ""} WHERE id=?`)
            .bind(ctx.attempt, ctx.attempt > 1 ? max : null, ctx.attempt > 1 ? Date.now() : null, ctx.attempt > 1 ? 120_000 : null, job.id),
          env.DB.prepare("UPDATE provider_leases SET expires_at=? WHERE job_id=?").bind(Date.now() + 300000, job.id),
        ]);
        const { state, questions } = await prepare();
        return await judge(env, state, questions, job);
      }
    } catch (e) {
      failure = beforeCall(e);
    }
    const final = !failure.retryable || ctx.attempt >= max;
    logJevFailure(env, failure, job, ctx.attempt, final);
    if (!final) {
      await env.DB.prepare("UPDATE jobs SET reason=?,attempt=?,max_attempts=?,attempt_started_at=NULL WHERE id=?")
        .bind(failure.reason, ctx.attempt + 1, max, job.id).run().catch(() => {});
      throw failure;
    }
    return { failed: { phase: failure.phase, reason: failure.reason, message: failure.message, http_status: failure.detail.http_status ?? null } } satisfies Failed;
  });
  if ("failed" in result) {
    const f = result.failed;
    throw new JevFailure(f.phase, f.reason, f.message, f.http_status ? { http_status: f.http_status } : {});
  }
  return result;
}
