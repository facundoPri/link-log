import { useCallback, useEffect, useEffectEvent, useReducer, useRef } from "react";
import { toast } from "sonner";
import { BATCH_WORDS } from "./batches";
import { runningBatchToast } from "./bulkActions";
import { useCancelBatches } from "./entities";
import { useInvalidateLibrary, useLibrary } from "./library";
import { plural, tokens, usd } from "./lib/format";
import type { Batch } from "./types";

/**
 * An action this page started. Its batches share one toast, which settles once the run has ended and they all
 * finished. `cancelled` turns true when the user cancels it from that toast: whoever drives the run stops starting
 * more work.
 */
export type SessionRun = { add: (batchId: string) => void; end: () => void; readonly cancelled: boolean };
export type StartRun = () => SessionRun;

type Run = {
  batchIds: string[];
  open: boolean;
  cancelled: boolean;
  /** Cancels every batch of the run, and from then on each batch that joins it (its request was in flight). */
  cancel: () => void;
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

  const cancelBatches = useCancelBatches();
  const cancel = useCallback((ids: string[]) => void cancelBatches(ids), [cancelBatches]);

  /** Called once the library that answered the batch's request is in the cache. */
  const trackBatch = useCallback(
    (batchId: string) => {
      const { run, session } = createRun({ cancelBatches: cancel, changed, invalidateLibrary });
      session.add(batchId);
      Object.assign(run, { open: false, listedAfter: 0 });
      runs.current.set(crypto.randomUUID(), run);
      changed();
    },
    [cancel, invalidateLibrary],
  );
  const startRun = useCallback<StartRun>(() => {
    const { run, session } = createRun({ cancelBatches: cancel, changed, invalidateLibrary });
    runs.current.set(crypto.randomUUID(), run);
    return session;
  }, [cancel, invalidateLibrary]);

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
          ...runningBatchToast({
            batch: { total, done: finished - failed - cancelled, failed, cancelled },
            onCancel: run.cancel,
            onActivity,
          }),
        });
        continue;
      }
      runs.current.delete(toastId);
      const activity = { label: "Activity", onClick: onActivity };
      // Sonner merges updates into the running toast, so clear its Cancel button explicitly.
      if (cancelled === total) toast("Cancelled", { id: toastId, description: undefined, action: undefined, cancel: undefined });
      else if (failed === 0)
        toast.success(`${words.done} ${plural(total - cancelled, words.noun)}`, {
          id: toastId,
          description: usage ? `${usd(usage.usd)} · ${tokens(usage.tokens)} tokens` : undefined,
          action: activity,
          cancel: undefined,
        });
      else
        toast[failed === total ? "error" : "success"](`${words.done} ${plural(total, words.noun)}`, {
          id: toastId,
          description: `${failed} failed — see Activity`,
          action: activity,
          cancel: undefined,
        });
      onSettled(batches, failed > 0);
    }
  });
  useEffect(() => showRuns(), [data?.batches, dataUpdatedAt, version]);

  return { trackBatch, startRun };
}

/** A run's bookkeeping and the handle its driver gets. Exported for tests. */
export function createRun({
  cancelBatches,
  changed,
  invalidateLibrary = () => {},
}: {
  cancelBatches: (ids: string[]) => void;
  /** Re-renders the run's toast. */
  changed: () => void;
  invalidateLibrary?: () => unknown;
}) {
  const run: Run = {
    batchIds: [],
    open: true,
    listedAfter: Infinity,
    cancelled: false,
    cancel: () => {
      run.cancelled = true;
      cancelBatches([...run.batchIds]);
    },
  };
  const session: SessionRun = {
    add: (batchId) => {
      run.batchIds.push(batchId);
      if (run.cancelled) cancelBatches([batchId]);
      changed();
    },
    end: () => {
      run.open = false;
      run.listedAfter = Date.now();
      if (run.batchIds.length) void invalidateLibrary();
      changed();
    },
    get cancelled() {
      return run.cancelled;
    },
  };
  return { run, session };
}
