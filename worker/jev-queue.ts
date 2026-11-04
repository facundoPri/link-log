// The Jev queue's consumer (ADR 0001): lens, auto-tag, query and Browser evaluation jobs run here directly, one message per job,
// with no Workflow and no lease. The queue's max_batch_size × max_concurrency caps simultaneous Jev calls.
// Delivery is at-least-once and nothing here is durable, so every step is derived from the job's row:
// the guarded start, the `jev_call` claim inside judge() and the running-status fence on every write.
import { beforeCall, judge, JevFailure, outcomeFailure, uncertain, type JevOutcome, type JevResult } from "./ai/jev";
import { classifyInput, classifySave } from "./handlers/classify";
import { browserInput, browserSave, dropSnapshot, loadTarget } from "./handlers/browser";
import { logJevFailure } from "./handlers/jev-step";
import type { BrowserTargetRow, JobConfig } from "./handlers";
import { accountStop, contentMissing, promoteWaiting, startNext } from "./jobs";
import { runsInJevQueue, type JobMessage } from "./job-routing";
import { logJevBatchProgress, logJevJobStarted } from "./jev-metrics";
import { INTERRUPTED_USAGE } from "./usage";
import type { Link } from "../src/types";

// FAC-54: one automatic retry, only for a known transient storage error before the call, as a message retry.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_S = 5;
const ATTEMPT_BUDGET_MS = 120_000;
/** Longer than a consumer invocation can live (the Queues 15-minute wall-clock limit): its runner is gone. */
export const ABANDONED_MS = 15 * 60_000;

type Run = {
  id: string;
  batch_id: string;
  link_id: string | null;
  target_id: string | null;
  status: string;
  created_at: string;
  attempt: number | null;
  jev_call: string | null;
  jev_outcome: string | null;
  started_at: number | null;
  kind: string;
  config: string;
  user_id: string;
};
/** The dead runner claimed no call, so nothing was sent: the job is retried like a transient failure before the call. */
class AbandonedBeforeCall extends JevFailure {
  constructor() {
    super("before_call", "before_call", undefined, { technical: "The run was abandoned before its call" });
  }
  override get retryable() {
    return true;
  }
}
/** What a job evaluates: a saved link, or a Browser tab's temporary snapshot. */
type Subject = { link: Link; target: null } | { link: null; target: BrowserTargetRow };
type Settlement = { done: D1PreparedStatement[]; snapshot: BrowserTargetRow | null } | { failed: Error };

export async function consumeJevJobs(batch: MessageBatch<JobMessage>, env: Env) {
  await Promise.all(batch.messages.map((message) => consume(env, message)));
}

async function consume(env: Env, message: Message<JobMessage>) {
  try {
    const run = await env.DB.prepare(
      "SELECT j.id,j.batch_id,j.link_id,j.target_id,j.status,j.created_at,j.attempt,j.jev_call,j.jev_outcome,j.started_at,b.kind,b.config,b.user_id FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?",
    ).bind(message.body.id).first<Run>();
    // Another kind's job is left alone: recovery resends it to the queue its kind belongs to.
    if (!run || !run.user_id || !(run.link_id || run.target_id) || !runsInJevQueue(run.kind)) return message.ack();
    const now = Date.now();
    const abandoned = run.status === "running" && run.started_at !== null && now - run.started_at > ABANDONED_MS;
    // Only a queued job starts. A running one belongs to another delivery, unless its runner is long gone.
    if (run.status !== "queued" && !abandoned) return message.ack();
    const started = await (abandoned
      ? env.DB.prepare("UPDATE jobs SET started_at=? WHERE id=? AND status='running' AND started_at=?").bind(now, run.id, run.started_at)
      : env.DB.prepare("UPDATE jobs SET status='running',step='Preparing content',started_at=? WHERE id=? AND status='queued'").bind(now, run.id)
    ).run();
    if (!started.meta.changes) return message.ack();
    if (!abandoned) logJevJobStarted(run, run.kind);
    if ((await execute(env, run, abandoned)) === "retry") return message.retry({ delaySeconds: RETRY_DELAY_S });
    message.ack();
  } catch (error) {
    // Nothing was started, or the start could not be read back: the job is still queued for the next delivery.
    console.error(JSON.stringify({ event: "jev_consume_failed", job_id: message.body.id, detail: String(error).slice(0, 300) }));
    message.retry({ delaySeconds: 15 });
  }
}

async function execute(env: Env, run: Run, abandoned: boolean): Promise<"retry" | "settled"> {
  const attempt = run.attempt ?? 1;
  let settlement: Settlement;
  try {
    const { subject, config, result } = await evaluate(env, run, attempt, abandoned);
    settlement = subject.target
      ? { done: browserSave({ env, job: run, target: subject.target, config }, result), snapshot: subject.target }
      : { done: classifySave({ env, job: run, link: subject.link, config }, result), snapshot: null };
  } catch (error) {
    const failure = error instanceof JevFailure ? error : null;
    if (failure) {
      const final = !failure.retryable || attempt >= MAX_ATTEMPTS;
      logJevFailure(env, failure, run, attempt, MAX_ATTEMPTS, final);
      if (!final && (await requeue(env, run.id, failure, attempt + 1))) return "retry";
    }
    settlement = { failed: error instanceof Error ? error : new Error("Could not process") };
  }
  try {
    await settle(env, run, settlement);
  } catch (error) {
    // The job stays running; once abandoned, a later delivery settles it from its recorded call.
    console.error(JSON.stringify({ event: "jev_settle_failed", job_id: run.id, detail: String(error).slice(0, 300) }));
    return "settled";
  }
  // The snapshot is only needed until its answer is saved. If this fails, the retention sweep drops it.
  if ("done" in settlement && settlement.snapshot)
    await dropSnapshot(env, settlement.snapshot).catch((error: unknown) =>
      console.error(JSON.stringify({ event: "jev_snapshot_drop_failed", job_id: run.id, detail: String(error).slice(0, 300) })));
  return "settled";
}

/**
 * The job's one Jev call. A call this job already claimed is never sent again: its recorded outcome stands, and
 * without one it may have been billed. A run taken over from an abandoned runner never sends a new call.
 */
async function evaluate(env: Env, run: Run, attempt: number, abandoned: boolean) {
  let subject: Subject | null = null;
  const config = JSON.parse(run.config) as JobConfig;
  try {
    subject = await load(env, run);
    const recorded = recordedCall(run);
    if (recorded) return { subject, config, result: recorded };
    if (abandoned) throw new AbandonedBeforeCall();
    // Jev that waited for an extraction which ended without content fails here, free.
    if (subject.link && !subject.link.content_key) throw new JevFailure("before_call", "before_call", contentMissing);
    await env.DB.prepare(`UPDATE jobs SET step='Evaluating with Jev',attempt=?,max_attempts=?,attempt_started_at=?,attempt_budget_ms=?${attempt === 1 ? ",reason=NULL" : ""} WHERE id=? AND status='running'`)
      .bind(attempt, attempt > 1 ? MAX_ATTEMPTS : null, attempt > 1 ? Date.now() : null, attempt > 1 ? ATTEMPT_BUDGET_MS : null, run.id).run();
    const { state, questions } = subject.target
      ? await browserInput({ env, job: run, target: subject.target, config })
      : await classifyInput({ env, job: run, link: subject.link, config });
    return { subject, config, result: await judge(env, state, questions, run) };
  } catch (error) {
    const failure = beforeCall(error);
    if (failure.phase === "sent" || !subject) throw failure;
    // A failure outside the provider's answer (metering, say) may still come after the claim: the claim decides.
    const row = await env.DB.prepare("SELECT jev_call,jev_outcome FROM jobs WHERE id=?").bind(run.id)
      .first<Pick<Run, "jev_call" | "jev_outcome">>().catch((e: unknown) => { throw uncertain(e); });
    const recorded = row ? recordedCall(row) : null;
    if (!recorded) throw failure;
    return { subject, config, result: recorded };
  }
}

async function load(env: Env, run: Run): Promise<Subject> {
  if (run.target_id) {
    const target = await loadTarget(env.DB, run.target_id, run.user_id);
    if (!target) throw new JevFailure("before_call", "before_call", "The browser capture no longer exists.");
    return { link: null, target };
  }
  const link = await env.DB.prepare("SELECT * FROM links WHERE id=? AND user_id=?").bind(run.link_id, run.user_id).first<Link>();
  if (!link) throw new JevFailure("before_call", "before_call", "The link no longer exists.");
  return { link, target: null };
}

/** The answer of a call this job claimed, or null if it claimed none. Throws the call's recorded failure. */
function recordedCall(row: Pick<Run, "jev_call" | "jev_outcome">): JevResult | null {
  if (!row.jev_call) return null;
  const outcome = row.jev_outcome ? (JSON.parse(row.jev_outcome) as JevOutcome) : null;
  if (outcome?.ok) return outcome.result;
  throw outcome ? outcomeFailure(outcome) : new JevFailure("sent", "interrupted", undefined, { technical: "An earlier run claimed the call" });
}

/** Puts the job back in the queue for its retry, with the attempt Activity shows. Never once its call was claimed. */
async function requeue(env: Env, id: string, failure: JevFailure, next: number) {
  const result = await env.DB.prepare(
    "UPDATE jobs SET status='queued',reason=?,attempt=?,max_attempts=?,attempt_started_at=NULL WHERE id=? AND status='running' AND jev_call IS NULL",
  ).bind(failure.reason, next, MAX_ATTEMPTS, id).run().catch(() => null);
  return !!result?.meta.changes;
}

/**
 * One transaction: what the job publishes, its terminal status, its unfinished usage row and the promotion of its
 * link's next waiting job, which is then sent to the queue its kind belongs to. Every write is fenced on the job
 * still running, so a job cancelled meanwhile is left as the cancel settled it.
 */
async function settle(env: Env, run: Run, settlement: Settlement) {
  const now = new Date().toISOString();
  const running = "AND status='running'";
  let stopped: (string | null)[] = [];
  const statements = [
    env.DB.prepare(`UPDATE usage_events SET ${INTERRUPTED_USAGE},duration_ms=?-strftime('%s',created_at)*1000 WHERE job_id=? AND status='started'`).bind(Date.now(), run.id),
  ];
  if ("done" in settlement) {
    statements.unshift(...settlement.done);
    statements.push(env.DB.prepare(`UPDATE jobs SET status='done',step='Done',completed_at=? WHERE id=? ${running}`).bind(now, run.id));
  } else {
    const jev = settlement.failed instanceof JevFailure ? settlement.failed : null;
    statements.push(
      env.DB.prepare(`UPDATE jobs SET status='failed',step='Failed',error=?,reason=?,completed_at=? WHERE id=? ${running}`)
        .bind(settlement.failed.message, jev?.reason ?? null, now, run.id),
    );
    if (jev?.reason === "account") {
      const stop = await accountStop(env.DB, run, now, jev.detail.http_status ?? null);
      stopped = stop.links;
      statements.push(...stop.statements);
    }
  }
  if (run.link_id) statements.push(promoteWaiting(env.DB, run.link_id));
  await env.DB.batch(statements);
  await logJevBatchProgress(env, run.id, run.kind);
  await startNext(env, [run.link_id, ...stopped]);
}
