import { useCallback, useEffect, useEffectEvent, useReducer, useRef } from "react";
import { toast } from "sonner";
import { api } from "./api";
import { BATCH_WORDS } from "./batches";
import { useLibrary, useWriteLibrary } from "./library";
import { plural, tokens, usd } from "./lib/format";
import type { Batch, Library } from "./types";

/** An action this page started. Its batches share one toast, which settles once the run has ended and they all finished. */
export type SessionRun = { add: (batchId: string) => void; end: () => void };
export type StartRun = () => SessionRun;

type Run = { batchIds: string[]; open: boolean };

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
  const { data } = useLibrary();
  const writeLibrary = useWriteLibrary();
  // By toast id.
  const runs = useRef(new Map<string, Run>());
  const [version, changed] = useReducer((n: number) => n + 1, 0);

  const trackBatch = useCallback((batchId: string) => {
    runs.current.set(crypto.randomUUID(), { batchIds: [batchId], open: false });
    changed();
  }, []);
  const startRun = useCallback<StartRun>(() => {
    const run: Run = { batchIds: [], open: true };
    runs.current.set(crypto.randomUUID(), run);
    return {
      add: (batchId) => {
        run.batchIds.push(batchId);
        changed();
      },
      end: () => {
        run.open = false;
        changed();
      },
    };
  }, []);

  const cancelBatches = async (ids: string[]) => {
    try {
      let cancelled = 0, dependents = 0;
      for (const id of ids) {
        const reply = await api<Library & { cancelled?: number; dependents?: number }>(`/batches/${id}`, "DELETE");
        writeLibrary(reply);
        cancelled += reply.cancelled ?? 0;
        dependents += reply.dependents ?? 0;
      }
      toast(
        cancelled
          ? `Cancelled ${cancelled} queued ${cancelled === 1 ? "job" : "jobs"}${dependents ? `, and ${dependents} waiting for that extraction` : ""}`
          : "Nothing left to cancel",
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const showRuns = useEffectEvent(() => {
    const listed = data?.batches ?? [];
    for (const [toastId, run] of runs.current) {
      const batches = listed.filter((batch) => run.batchIds.includes(batch.id));
      if (!batches.length) {
        if (!run.open && !run.batchIds.length) runs.current.delete(toastId);
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
      if (run.open || batches.length < run.batchIds.length || sumOf((batch) => batch.active) > 0) {
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
  useEffect(() => showRuns(), [data?.batches, version]);

  return { trackBatch, startRun };
}
