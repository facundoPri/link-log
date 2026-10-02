import type { WorkflowStep } from "cloudflare:workers";
import { beforeCall, judge, JevFailure, outcomeFailure, R2_TRANSIENT, uncertain, type JevOutcome, type JevPhase, type Question } from "../ai/jev";

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
    // Only R2's known transient answers are retried; a permanent or unknown error is final.
    throw beforeCall(e, "Failed before calling Jev (no cost): the saved content could not be read.", R2_TRANSIENT);
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
      // A previous attempt that claimed the call may have reached the provider before the engine ended it:
      // its recorded answer is used as is, and without one it may have been billed. Not knowing (the read
      // failed) is treated the same way: never send again.
      const previous = ctx.attempt > 1
        ? await env.DB.prepare("SELECT jev_call,jev_outcome FROM jobs WHERE id=?").bind(job.id).first<{ jev_call: string | null; jev_outcome: string | null }>()
          .catch((e: unknown) => { throw uncertain(e); })
        : null;
      const recorded = previous?.jev_outcome ? JSON.parse(previous.jev_outcome) as JevOutcome : null;
      if (recorded?.ok) return recorded.result;
      if (recorded) failure = outcomeFailure(recorded);
      else if (previous?.jev_call)
        failure = new JevFailure("sent", "interrupted", undefined, { technical: "A previous attempt claimed the call" });
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
    // On a later attempt, "no cost" holds only if no earlier callback has claimed the call meanwhile.
    if (failure.phase === "before_call" && ctx.attempt > 1) {
      const claimed = await env.DB.prepare("SELECT jev_call FROM jobs WHERE id=?").bind(job.id).first<{ jev_call: string | null }>()
        .then((row) => !!row?.jev_call, () => true);
      if (claimed) failure = new JevFailure("sent", "interrupted", undefined, failure.detail);
    }
    const final = !failure.retryable || ctx.attempt >= max;
    logJevFailure(env, failure, job, ctx.attempt, final);
    if (!final) {
      await env.DB.prepare("UPDATE jobs SET reason=?,attempt=?,max_attempts=?,attempt_started_at=NULL WHERE id=?")
        .bind(failure.reason, ctx.attempt + 1, max, job.id).run().catch(() => {});
      throw failure;
    }
    return { failed: { phase: failure.phase, reason: failure.reason, message: failure.message, http_status: failure.detail.http_status ?? null } } satisfies Failed;
  }).catch((e: unknown) => {
    // An error the engine raised (step timeout, eviction) says nothing about whether the call was sent.
    if (e instanceof JevFailure) throw e;
    const failure = uncertain(e);
    logJevFailure(env, failure, job, max, true);
    throw failure;
  });
  if ("failed" in result) {
    const f = result.failed;
    throw new JevFailure(f.phase, f.reason, f.message, f.http_status ? { http_status: f.http_status } : {});
  }
  return result;
}
