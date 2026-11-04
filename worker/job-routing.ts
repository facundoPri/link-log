/** The kind of the batch a job belongs to (`batches.kind`). */
export type BatchKind = "extract" | "preview" | "autotag" | "lens" | "query" | "browser-lens" | "browser-autogroup";

export type JobMessage = { id: string };

/** The queue a job of this batch kind runs from. The only place that maps a kind to a queue binding. */
export function queueFor(env: Env, _kind: BatchKind): Queue<JobMessage> {
  return env.JOBS;
}

/**
 * Sends jobs to the queue their batch's kind belongs to. Every send of a job goes through here.
 * Callers keep their own failure handling: D1 is the outbox and recover() resends a lost send.
 */
export async function sendJobs(env: Env, jobs: { id: string; kind: BatchKind }[]) {
  const byQueue = new Map<Queue<JobMessage>, JobMessage[]>();
  for (const { id, kind } of jobs) {
    const queue = queueFor(env, kind);
    byQueue.set(queue, [...(byQueue.get(queue) ?? []), { id }]);
  }
  for (const [queue, ids] of byQueue) await queue.sendBatch(ids.map((body) => ({ body })));
}
