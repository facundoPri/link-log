const BATCH_KINDS = ["extract", "preview", "autotag", "lens", "query", "browser-lens", "browser-autogroup"] as const;
/** The kind of the batch a job belongs to (`batches.kind`). */
export type BatchKind = (typeof BATCH_KINDS)[number];
/** A `batches.kind` read from D1. Throws on a kind this code does not know. */
export function parseBatchKind(value: unknown): BatchKind {
  const kind = BATCH_KINDS.find((k) => k === value);
  if (!kind) throw new Error(`Unknown batch kind: ${String(value)}`);
  return kind;
}

export type JobMessage = { id: string };

// Jobs of these kinds call Jev. They run directly in the Jev queue's consumer, with no Workflow (ADR 0001).
const JEV_KINDS = new Set<BatchKind>(["autotag", "lens", "query", "browser-lens", "browser-autogroup"]);
export const runsInJevQueue = (kind: BatchKind) => JEV_KINDS.has(kind);

/** Whether a consumer batch comes from the Jev queue (`linklog-jev`, `linklog-jev-production`). */
export const isJevQueue = (name: string) => /-jev(-production)?$/.test(name);

/**
 * A job to send. `inWorkflow`: it is running in a Workflow started before the Jev queue (the consumer never
 * started it), so it stays with the jobs queue, whose dispatch reconciles that Workflow. FAC-196 drops it.
 */
export type JobToSend = { id: string; kind: BatchKind; inWorkflow?: boolean };

/** The queue a job runs from. The only place that maps a job to a queue binding. */
export function queueFor(env: Env, job: Omit<JobToSend, "id">): Queue<JobMessage> {
  return runsInJevQueue(job.kind) && !job.inWorkflow ? env.JEV_JOBS : env.JOBS;
}

/**
 * Sends jobs to the queue each belongs to. Every send of a job goes through here.
 * Callers keep their own failure handling: D1 is the outbox and recover() resends a lost send.
 */
export async function sendJobs(env: Env, jobs: JobToSend[]) {
  const byQueue = new Map<Queue<JobMessage>, JobMessage[]>();
  for (const job of jobs) {
    const queue = queueFor(env, job);
    byQueue.set(queue, [...(byQueue.get(queue) ?? []), { id: job.id }]);
  }
  for (const [queue, ids] of byQueue) await queue.sendBatch(ids.map((body) => ({ body })));
}
