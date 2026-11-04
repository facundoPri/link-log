/** The kind of the batch a job belongs to (`batches.kind`). */
export type BatchKind = "extract" | "preview" | "autotag" | "lens" | "query" | "browser-lens" | "browser-autogroup";

export type JobMessage = { id: string };

// Jobs of these kinds run directly in the Jev queue's consumer, with no Workflow (ADR 0001).
const JEV_QUEUE_KINDS = new Set<string>(["autotag", "lens", "query", "browser-lens", "browser-autogroup"] satisfies BatchKind[]);
export const runsInJevQueue = (kind: string) => JEV_QUEUE_KINDS.has(kind);

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
