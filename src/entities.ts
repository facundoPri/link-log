import { useCallback, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { Batch, Job } from "./types";

const POLL_MS = 1800;

export const batchJobsKey = (batchId: string) => ["batch", batchId] as const;

const isLive = (job: Job) => ["queued", "running", "waiting"].includes(job.status);

export const batchJobsOptions = (batchId: string) => ({
  queryKey: batchJobsKey(batchId),
  queryFn: async () => (await api<{ jobs: Job[] }>(`/batches/${batchId}`)).jobs,
});

/** The jobs of one batch. The cache is the only copy, so every reader of a batch shares one request. */
export function useBatchJobs(batchId: string) {
  return useQuery(batchJobsOptions(batchId));
}

export type RunningJob = { kind: "extract" | "preview" | "autotag" | "lens" | "query"; status: string; step: string | null };

const RUNNING_KINDS = new Set(["extract", "preview", "autotag", "lens", "query"]);

/**
 * The job each link is waiting on or running, from the jobs of the batches that have active work.
 * This is the one poller of those batches: it keeps polling a batch until the jobs it cached have
 * finished, so a batch that just completed gets its final state before the poll stops.
 */
export function useRunningJobs(batches: Batch[]) {
  const client = useQueryClient();
  const watched = batches.filter(
    (b) => b.active > 0 || client.getQueryData<Job[]>(batchJobsKey(b.id))?.some(isLive),
  );
  const jobs = useQueries({
    queries: watched.map((b) => ({
      ...batchJobsOptions(b.id),
      refetchInterval: (query: { state: { data: Job[] | undefined } }) =>
        b.active > 0 || query.state.data?.some(isLive) ? POLL_MS : false,
    })),
    combine: (results) => results.map((r) => r.data),
  });
  const watchedIds = watched.map((b) => b.id).join();
  return useMemo(() => {
    const running = new Map<string, RunningJob>();
    watched.forEach((b, i) => {
      if (b.active === 0 || !RUNNING_KINDS.has(b.kind)) return;
      for (const j of jobs[i] ?? [])
        // A waiting job never hides the job it waits for.
        if (j.link_id && isLive(j) && !(j.status === "waiting" && running.has(j.link_id)))
          running.set(j.link_id, { kind: b.kind as RunningJob["kind"], status: j.status, step: j.step });
    });
    return running;
  }, [jobs, watchedIds]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** After a job or batch is cancelled or retried, every batch's jobs may have changed. */
export function useInvalidateBatches() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: ["batch"] }), [client]);
}

/** A link's content at one version. A new version loads in place of the old text of the same link, not a blank. */
export function useLinkContent(linkId: string, version: number) {
  return useQuery({
    queryKey: ["link-content", linkId, version],
    queryFn: async () => (await api<{ markdown: string }>(`/links/${linkId}/content`)).markdown,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === linkId ? previous : undefined,
  });
}
