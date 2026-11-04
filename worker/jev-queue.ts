// The Jev queue's consumer (ADR 0001): lens, auto-tag, query and Browser evaluation jobs run here directly, one message per job,
// with no Workflow and no lease. The queue's max_batch_size × max_concurrency caps simultaneous Jev calls.
// Delivery is at-least-once and nothing here is durable, so every step is derived from the job's row:
// the guarded start, the `jev_call` claim inside judge() and the running-status fence on every write.
import { beforeCall, judge, JevFailure, outcomeFailure, uncertain, type JevOutcome, type JevResult } from "./ai/jev";
import { classifyInput, classifySave } from "./handlers/classify";
import { browserInput, browserSave, dropSnapshot, loadTarget } from "./handlers/browser";
import { logJevFailure } from "./handlers/jev-step";
import type { BrowserTargetRow, JobConfig } from "./handlers";
import { accountStop, contentMissing, promoteWaiting, startNext, type JobRow } from "./jobs";
import { parseBatchKind, runsInJevQueue, type BatchKind, type JobMessage } from "./job-routing";
import { logJevBatchProgress, logJevJobStarted } from "./jev-metrics";
import { INTERRUPTED_USAGE } from "./usage";
import type { Link } from "../src/types";

// FAC-54: one automatic retry, only for a known transient storage error before the call, as a message retry.
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_S = 5;
/** A delivery that failed before starting its job is retried after this long. */
const CONSUME_RETRY_DELAY_S = 15;
const ATTEMPT_BUDGET_MS = 120_000;
/** Longer than a consumer invocation can live (the Queues 15-minute wall-clock limit): its runner is gone. */
export const ABANDONED_MS = 15 * 60_000;

/** A job as the consumer reads it, with its batch's kind, config and owner. */
type Job = JobRow & {
  created_at: string;
  attempt: number | null;
  jev_call: string | null;
  jev_outcome: string | null;
  started_at: number | null;
  kind: BatchKind;
  config: string;
  user_id: string;
};
type JobRead = Omit<Job, "kind" | "user_id"> & { kind: string; user_id: string | null };
/** The dead runner claimed no call, so nothing was sent: the job is retried like a transient failure before the call. */
class AbandonedBeforeCall extends JevFailure {
  constructor() {
    super("before_call", "before_call", undefined, { technical: "The job's runner was abandoned before its call" });
  }
  override get retryable() {
    return true;
  }
}
/** What a job evaluates: a saved link, or a Browser tab's temporary snapshot. */
type Subject = { link: Link; target: null } | { link: null; target: BrowserTargetRow };
type Settlement = { done: D1PreparedStatement[]; snapshot: BrowserTargetRow | null } | { failed: Error };

const logError = (event: string, jobId: string, error: unknown) =>
  console.error(JSON.stringify({ event, job_id: jobId, detail: String(error).slice(0, 300) }));

export async function consumeJevJobs(batch: MessageBatch<JobMessage>, env: Env) {
  await Promise.all(batch.messages.map((message) => consume(env, message)));
}

async function consume(env: Env, message: Message<JobMessage>) {
  try {
    const row = await env.DB.prepare(
      "SELECT j.id,j.batch_id,j.link_id,j.target_id,j.status,j.created_at,j.attempt,j.jev_call,j.jev_outcome,j.started_at,b.kind,b.config,b.user_id FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?",
    ).bind(message.body.id).first<JobRead>();
    if (!row || !row.user_id || !(row.link_id || row.target_id)) return message.ack();
    const job: Job = { ...row, user_id: row.user_id, kind: parseBatchKind(row.kind) };
    // Another kind's job is left alone: recovery resends it to the queue its kind belongs to.
    if (!runsInJevQueue(job.kind)) return message.ack();
    const now = Date.now();
    const abandoned = job.status === "running" && job.started_at !== null && now - job.started_at > ABANDONED_MS;
    // Only a queued job starts. A running one belongs to another delivery, unless its runner is long gone.
    if (job.status !== "queued" && !abandoned) return message.ack();
    const started = await (abandoned
      ? env.DB.prepare("UPDATE jobs SET started_at=? WHERE id=? AND status='running' AND started_at=?").bind(now, job.id, job.started_at)
      : env.DB.prepare("UPDATE jobs SET status='running',step='Preparing content',started_at=? WHERE id=? AND status='queued'").bind(now, job.id)
    ).run();
    if (!started.meta.changes) return message.ack();
    // started_at survives a retry: only the job's first start is logged.
    if (job.started_at === null) logJevJobStarted(job);
    if ((await execute(env, job, abandoned)) === "retry") return message.retry({ delaySeconds: RETRY_DELAY_S });
    message.ack();
  } catch (error) {
    // Nothing was started, or the start could not be read back: the job is still queued for the next delivery.
    logError("jev_consume_failed", message.body.id, error);
    message.retry({ delaySeconds: CONSUME_RETRY_DELAY_S });
  }
}

async function execute(env: Env, job: Job, abandoned: boolean): Promise<"retry" | "settled"> {
  const attempt = job.attempt ?? 1;
  let settlement: Settlement;
  try {
    const { subject, config, result } = await evaluate({ env, job, attempt, abandoned });
    settlement = subject.target
      ? { done: browserSave({ env, job, target: subject.target, config }, result), snapshot: subject.target }
      : { done: classifySave({ env, job, link: subject.link, config }, result), snapshot: null };
  } catch (error) {
    const failure = error instanceof JevFailure ? error : null;
    if (failure) {
      const final = !failure.retryable || attempt >= MAX_ATTEMPTS;
      logJevFailure({ env, failure, job, attempt, maxAttempts: MAX_ATTEMPTS, final });
      if (!final && (await requeue(env, job.id, failure, attempt + 1))) return "retry";
    }
    settlement = { failed: error instanceof Error ? error : new Error("Could not process") };
  }
  try {
    await settle(env, job, settlement);
  } catch (error) {
    // The job stays running; once abandoned, a later delivery settles it from its recorded call.
    logError("jev_settle_failed", job.id, error);
    return "settled";
  }
  // The snapshot is only needed until its answer is saved. If this fails, the retention sweep drops it.
  if ("done" in settlement && settlement.snapshot)
    await dropSnapshot(env, settlement.snapshot).catch((error: unknown) => logError("jev_snapshot_drop_failed", job.id, error));
  return "settled";
}

/**
 * The job's one Jev call. A call this job already claimed is never sent again: its recorded outcome stands, and
 * without one it may have been billed. A job taken over from an abandoned runner never sends a new call.
 */
async function evaluate({ env, job, attempt, abandoned }: { env: Env; job: Job; attempt: number; abandoned: boolean }) {
  let subject: Subject | null = null;
  const config = parseJobConfig(job.config);
  try {
    subject = await load(env, job);
    const recorded = recordedCall(job);
    if (recorded) return { subject, config, result: recorded };
    if (abandoned) throw new AbandonedBeforeCall();
    // Jev that waited for an extraction which ended without content fails here, free.
    if (subject.link && !subject.link.content_key) throw new JevFailure("before_call", "before_call", contentMissing);
    await env.DB.prepare(`UPDATE jobs SET step='Evaluating with Jev',attempt=?,max_attempts=?,attempt_started_at=?,attempt_budget_ms=?${attempt === 1 ? ",reason=NULL" : ""} WHERE id=? AND status='running'`)
      .bind(attempt, attempt > 1 ? MAX_ATTEMPTS : null, attempt > 1 ? Date.now() : null, attempt > 1 ? ATTEMPT_BUDGET_MS : null, job.id).run();
    const { state, questions } = subject.target
      ? await browserInput({ env, job, target: subject.target, config })
      : await classifyInput({ env, job, link: subject.link, config });
    return { subject, config, result: await judge(env, state, questions, job) };
  } catch (error) {
    const failure = beforeCall(error);
    if (failure.phase === "sent") throw failure;
    // A failure outside the provider's answer (metering, or loading a taken-over job) may come after the claim: the claim decides.
    const row = await env.DB.prepare("SELECT jev_call,jev_outcome FROM jobs WHERE id=?").bind(job.id)
      .first<Pick<Job, "jev_call" | "jev_outcome">>().catch((e: unknown) => { throw uncertain(e); });
    const recorded = row ? recordedCall(row) : null;
    if (!recorded) throw failure;
    if (!subject) throw uncertain(failure.detail.technical ?? failure.message);
    return { subject, config, result: recorded };
  }
}

async function load(env: Env, job: Job): Promise<Subject> {
  if (job.target_id) {
    const target = await loadTarget(env.DB, job.target_id, job.user_id);
    if (!target) throw new JevFailure("before_call", "before_call", "The browser capture no longer exists.");
    return { link: null, target };
  }
  const link = await env.DB.prepare("SELECT * FROM links WHERE id=? AND user_id=?").bind(job.link_id, job.user_id).first<Link>();
  if (!link) throw new JevFailure("before_call", "before_call", "The link no longer exists.");
  return { link, target: null };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isJobConfig = (value: unknown): value is JobConfig =>
  isRecord(value)
  && (value.tags === undefined || Array.isArray(value.tags))
  && (value.lens === undefined || isRecord(value.lens))
  && (value.destinations === undefined || isRecord(value.destinations));

/** The batch's stored config (`batches.config`). Throws on a malformed one. */
function parseJobConfig(raw: string): JobConfig {
  const value: unknown = JSON.parse(raw);
  if (!isJobConfig(value)) throw new Error("The batch's config is malformed.");
  return value;
}

const isJevOutcome = (value: unknown): value is JevOutcome =>
  isRecord(value) && (value.ok === true
    ? isRecord(value.result) && isRecord(value.result.answers) && typeof value.result.model === "string"
    : value.ok === false && typeof value.reason === "string" && typeof value.message === "string");

/** The outcome recorded under the job's claim (`jobs.jev_outcome`), or null when it is missing or unreadable. */
function parseJevOutcome(raw: string | null): JevOutcome | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isJevOutcome(value) ? value : null;
  } catch {
    return null;
  }
}

/** The answer of a call this job claimed, or null if it claimed none. Throws the call's recorded failure. */
function recordedCall(row: Pick<Job, "jev_call" | "jev_outcome">): JevResult | null {
  if (!row.jev_call) return null;
  const outcome = parseJevOutcome(row.jev_outcome);
  if (outcome?.ok) return outcome.result;
  // Claimed with no readable outcome: the call may have been sent.
  throw outcome ? outcomeFailure(outcome) : new JevFailure("sent", "interrupted", undefined, { technical: "An earlier attempt claimed the call" });
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
async function settle(env: Env, job: Job, settlement: Settlement) {
  const now = new Date().toISOString();
  const running = "AND status='running'";
  let stopped: (string | null)[] = [];
  const statements = [
    env.DB.prepare(`UPDATE usage_events SET ${INTERRUPTED_USAGE},duration_ms=?-strftime('%s',created_at)*1000 WHERE job_id=? AND status='started'`).bind(Date.now(), job.id),
  ];
  if ("done" in settlement) {
    statements.unshift(...settlement.done);
    statements.push(env.DB.prepare(`UPDATE jobs SET status='done',step='Done',completed_at=? WHERE id=? ${running}`).bind(now, job.id));
  } else {
    const jev = settlement.failed instanceof JevFailure ? settlement.failed : null;
    statements.push(
      env.DB.prepare(`UPDATE jobs SET status='failed',step='Failed',error=?,reason=?,completed_at=? WHERE id=? ${running}`)
        .bind(settlement.failed.message, jev?.reason ?? null, now, job.id),
    );
    if (jev?.reason === "account") {
      const stop = await accountStop({ db: env.DB, job, now, httpStatus: jev.detail.http_status ?? null });
      stopped = stop.links;
      statements.push(...stop.statements);
    }
  }
  if (job.link_id) statements.push(promoteWaiting(env.DB, job.link_id));
  await env.DB.batch(statements);
  await logJevBatchProgress(env, job);
  await startNext(env, [job.link_id, ...stopped]);
}
