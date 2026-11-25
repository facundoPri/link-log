import { useCallback, useEffect, useEffectEvent, useReducer, useRef } from "react";
import { toast } from "sonner";
import { BATCH_WORDS } from "./batches";
import { useCancelBatches } from "./entities";
import { useInvalidateLibrary, useLibrary } from "./library";
import { plural, tokens, usd } from "./lib/format";
import type { Batch } from "./types";

/** An action this page started. Its batches share one toast, which settles once the run has ended and they all finished. */
export type SessionRun = { add: (batchId: string) => void; end: () => void };
export type StartRun = () => SessionRun;

type Run = {
  batchIds: string[];
  open: boolean;
  /**
   * Library data from after this time lists every batch of the run that the library's 30-batch window holds. A batch
   * it doesn't list then has left the window (or never got a job): it can't be followed, so it stops holding the toast.
   */
  listedAfter: number;
};

/**
 * Progress toasts for the actions this page started. A library action tracks each of its batches as a run of
 * its own; a browser run reports all of its batches (one per 20 tabs) on one toast.
 */
export function useSessionRuns({
  onActivity,
  onSettled,
}: {
  onActivity: () => void;
  /** A run's batches once they all finished; `failed` when some of their jobs failed. */
  onSettled: (batches: Batch[], failed: boolean) => void;
}) {
  const { data, dataUpdatedAt } = useLibrary();
  const invalidateLibrary = useInvalidateLibrary();
  // By toast id.
  const runs = useRef(new Map<string, Run>());
  const [version, changed] = useReducer((n: number) => n + 1, 0);

  /** Called once the library that answered the batch's request is in the cache. */
  const trackBatch = useCallback((batchId: string) => {
    runs.current.set(crypto.randomUUID(), { batchIds: [batchId], open: false, listedAfter: 0 });
    changed();
  }, []);
  const startRun = useCallback<StartRun>(() => {
    const run: Run = { batchIds: [], open: true, listedAfter: Infinity };
    runs.current.set(crypto.randomUUID(), run);
    return {
      add: (batchId) => {
        run.batchIds.push(batchId);
        changed();
      },
      end: () => {
        run.open = false;
        run.listedAfter = Date.now();
        if (run.batchIds.length) void invalidateLibrary();
        changed();
      },
    };
  }, [invalidateLibrary]);

  const cancelBatches = useCancelBatches();

  const showRuns = useEffectEvent(() => {
    const listed = new Map(data?.batches.map((batch) => [batch.id, batch]));
    for (const [toastId, run] of runs.current) {
      const batches = run.batchIds.flatMap((id) => listed.get(id) ?? []);
      const awaitingListing = batches.length < run.batchIds.length && dataUpdatedAt <= run.listedAfter;
      if (!batches.length) {
        if (!run.open && !awaitingListing) {
          runs.current.delete(toastId);
          toast.dismiss(toastId);
        }
        continue;
      }
      const sumOf = (count: (batch: Batch) => number) => batches.reduce((n, batch) => n + count(batch), 0);
      const total = sumOf((batch) => batch.total);
      const failed = sumOf((batch) => batch.failed);
      const cancelled = sumOf((batch) => batch.cancelled);
      const finished = sumOf((batch) => batch.done) + failed + cancelled;
      const usage = batches.every((batch) => batch.usage?.usd != null)
        ? { usd: sumOf((batch) => batch.usage!.usd!), tokens: sumOf((batch) => batch.usage!.input_tokens + batch.usage!.output_tokens) }
        : null;
      const words = BATCH_WORDS[batches[0]!.kind];
      if (run.open || awaitingListing || sumOf((batch) => batch.active) > 0) {
        toast.loading(`${words.verb} ${plural(total, words.noun)}…`, {
          id: toastId,
          description: `${finished} of ${total} done`,
          action: { label: "Cancel", onClick: () => void cancelBatches(run.batchIds) },
        });
        continue;
      }
      runs.current.delete(toastId);
      const activity = { label: "Activity", onClick: onActivity };
      if (cancelled === total) toast("Cancelled", { id: toastId });
      else if (failed === 0)
        toast.success(`${words.done} ${plural(total - cancelled, words.noun)}`, {
          id: toastId,
          description: usage ? `${usd(usage.usd)} · ${tokens(usage.tokens)} tokens` : undefined,
          action: activity,
        });
      else
        toast[failed === total ? "error" : "success"](`${words.done} ${plural(total, words.noun)}`, {
          id: toastId,
          description: `${failed} failed — see Activity`,
          action: activity,
        });
      onSettled(batches, failed > 0);
    }
  });
  useEffect(() => showRuns(), [data?.batches, dataUpdatedAt, version]);

  return { trackBatch, startRun };
}
