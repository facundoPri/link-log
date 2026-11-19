import { useCallback, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "./api";
import { POLL_MS, useWriteLibrary } from "./library";
import type { Batch, Job, Library, Usage, UsageTotals } from "./types";

export const batchJobsKey = (batchId: string) => ["batch", batchId] as const;

const isLive = (job: Job) => ["queued", "running", "waiting"].includes(job.status);

export const batchJobsOptions = (batchId: string) => ({
  queryKey: batchJobsKey(batchId),
  queryFn: async ({ signal }: { signal: AbortSignal }) =>
    (await api<{ jobs: Job[] }>(`/batches/${batchId}`, "GET", undefined, signal)).jobs,
});

/** The jobs of one batch. The cache is the only copy, so every reader of a batch shares one request. */
export function useBatchJobs(batchId: string) {
  return useQuery(batchJobsOptions(batchId));
}

const RUNNING_KINDS = ["extract", "preview", "autotag", "lens", "query"] as const;
type RunningKind = (typeof RUNNING_KINDS)[number];
const isRunningKind = (kind: string): kind is RunningKind => (RUNNING_KINDS as readonly string[]).includes(kind);

export type RunningJob = { kind: RunningKind; status: string; step: string | null };

/**
 * The job each link is waiting on or running, from the jobs of the batches that have active work.
 * This is the one poller of those batches: it keeps polling a batch until the jobs it cached have
 * finished, so a batch that just completed gets its final state before the poll stops.
 */
export function useRunningJobs(batches: Batch[]) {
  const client = useQueryClient();
  // Reading the cache in render is safe: a batch joins the watched set with library data (`active`) and leaves
  // it with its own jobs (a watched query), and both re-render this hook.
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
      if (b.active === 0 || !isRunningKind(b.kind)) return;
      for (const j of jobs[i] ?? [])
        // A waiting job never hides the job it waits for.
        if (j.link_id && isLive(j) && !(j.status === "waiting" && running.has(j.link_id)))
          running.set(j.link_id, { kind: b.kind, status: j.status, step: j.step });
    });
    return running;
    // `watched` is rebuilt every render; its ids and the jobs are what the result depends on.
  }, [jobs, watchedIds]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** After a job or batch is cancelled or retried, every batch's jobs may have changed. */
export function useInvalidateBatches() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: ["batch"] }), [client]);
}

/** Cancels the queued jobs of batches, from Activity or a progress toast, and reports how many with a toast. */
export function useCancelBatches() {
  const writeLibrary = useWriteLibrary();
  const invalidateBatches = useInvalidateBatches();
  return useCallback(
    async (ids: string[]) => {
      try {
        let cancelled = 0, dependents = 0;
        for (const id of ids) {
          const reply = await api<Library & { cancelled?: number; dependents?: number }>(`/batches/${id}`, "DELETE");
          writeLibrary(reply);
          cancelled += reply.cancelled ?? 0;
          dependents += reply.dependents ?? 0;
        }
        void invalidateBatches();
        toast(
          cancelled
            ? `Cancelled ${cancelled} queued ${cancelled === 1 ? "job" : "jobs"}${dependents ? `, and ${dependents} waiting for that extraction` : ""}`
            : "Nothing left to cancel",
        );
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [writeLibrary, invalidateBatches],
  );
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

export const usageTotalsKey = ["usage"] as const;
export const usageSummaryKey = ["usage-summary"] as const;

/** What all work has cost, for Activity. It revalidates each time `enabled` turns on (the sheet opens). */
export function useUsageTotals(enabled: boolean) {
  return useQuery({
    queryKey: usageTotalsKey,
    queryFn: async () => (await api<{ totals: UsageTotals }>("/usage")).totals,
    enabled,
  });
}

/** Settings' usage summary: this hour's quota and this month's links and cost. */
export function useUsageSummary() {
  return useQuery({ queryKey: usageSummaryKey, queryFn: () => api<Usage>("/usage/summary") });
}

/** Cost totals and the usage summary follow the work: call this once a batch has settled. */
export function useInvalidateUsage() {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: usageTotalsKey });
    void client.invalidateQueries({ queryKey: usageSummaryKey });
  }, [client]);
}
