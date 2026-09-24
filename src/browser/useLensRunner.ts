import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_LIMITS,
  lensFingerprint,
  type DepositItem,
  type Lens,
  type LensRecord,
  type LensRef,
} from "@linklog/browser-protocol";
import { call, evaluationStatus, evaluationTargets, OfflineError, postEvaluation } from "./api";
import type { BrowserState } from "./useBrowser";

export const lensRef = (lens: Lens): LensRef => ({ id: lens.id, fingerprint: lensFingerprint(lens) });

/**
 * Drives lens evaluation for the connected window: claims missing tabs in the
 * extension (which stores the request id first), POSTs them, polls, deposits
 * results back into the extension cache and confirms them to the backend.
 */
export function useLensRunner(browser: BrowserState, active: Lens[], allLenses: Lens[], enabled: boolean) {
  const { request, connection, snapshot, catalog, hello, resultsVersion } = browser;
  const [results, setResults] = useState<Record<string, Record<string, LensRecord>>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const [offline, setOffline] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connected = connection === "connected" && !!catalog && !!hello;
  const refs = useMemo(() => active.map(lensRef), [active]);
  const refsKey = refs.map((r) => `${r.id}:${r.fingerprint}`).join(",");
  const allRefs = useRef(new Map<string, LensRef>());
  allRefs.current = new Map(allLenses.map((l) => [l.id, lensRef(l)]));

  const loadResults = useCallback(async () => {
    if (!connected || !refs.length) {
      setResults({});
      return;
    }
    try {
      setResults((await request("results", { lenses: refs })).results);
    } catch {
      /* stale results stay visible */
    }
  }, [connected, refsKey, request]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadResults();
  }, [loadResults, snapshot?.revision, resultsVersion]);

  /** POSTs one claim; on a lost response the request id stays in the extension for recovery. */
  const submit = useCallback(
    async (ref: LensRef, claim: Awaited<ReturnType<typeof request<"claim">>>) => {
      if (!claim.requestId || !claim.targets.length || !catalog || !hello) return;
      const body = {
        kind: "lens" as const,
        requestId: claim.requestId,
        libraryId: catalog.libraryId,
        sessionId: hello.browserSessionId,
        lens: ref,
        targets: evaluationTargets(claim.targets),
      };
      let res;
      try {
        res = await postEvaluation(body);
        setOffline(null);
      } catch (error) {
        if (error instanceof OfflineError) setOffline(error.message);
        return; // still "submitting": recovery reconciles by request id, never re-buys blindly
      }
      if (res.status === 409 && res.data.code === "conflict") {
        const existing = await evaluationStatus(claim.requestId).catch(() => null);
        if (existing?.status === 200)
          await request("accepted", { requestId: claim.requestId, batchId: existing.data.batchId, jobs: existing.data.targets.map((t) => ({ targetKey: t.targetKey, jobId: t.jobId })) });
        return;
      }
      if (res.status >= 400) {
        await request("release", { requestId: claim.requestId, error: res.data.error || "The evaluation was rejected.", state: "failed" });
        if (res.data.code === "lens-changed") setNotice("A lens changed on another page. Reload to use its current question.");
        return;
      }
      await request("accepted", {
        requestId: claim.requestId,
        batchId: res.data.batchId,
        jobs: res.data.targets.map((t) => ({ targetKey: t.targetKey, jobId: t.jobId })),
      });
    },
    [catalog, hello, request],
  );

  const claimAndSubmit = useCallback(
    async (ref: LensRef, extra: Partial<Parameters<typeof request<"claim">>[1]> = {}) => {
      // Stays under the Worker's request cap and the backend's per-request target limit.
      for (let round = 0; round < 50; round++) {
        const claim = await request("claim", { lens: ref, limit: 20, ...extra }, 120_000);
        if (claim.requestId) await submit(ref, claim);
        if (!claim.skipped) return;
      }
    },
    [request, submit],
  );

  // Auto-complete: every active lens covers every eligible tab of the window.
  const running = useRef(false);
  const again = useRef(false);
  const fill = useCallback(async () => {
    if (!enabled || !connected || !refs.length) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        for (const ref of refs) await claimAndSubmit(ref);
      } while (again.current);
    } catch {
      /* surfaced through record states */
    } finally {
      running.current = false;
    }
  }, [enabled, connected, refsKey, claimAndSubmit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setTimeout(() => void fill(), 350);
    return () => clearTimeout(timer);
  }, [fill, snapshot?.revision, hello?.contentAccess]);

  // Recovery + polling of every request in flight, whichever page started it.
  const poll = useCallback(async () => {
    if (!connected) return;
    let pending;
    try {
      pending = (await request("pending", {})).requests;
    } catch {
      return;
    }
    setPendingCount(pending.reduce((n, r) => n + r.targets.length, 0));
    for (const req of pending) {
      let res;
      try {
        res = await evaluationStatus(req.requestId);
        setOffline(null);
      } catch (error) {
        if (error instanceof OfflineError) setOffline(error.message);
        return;
      }
      if (res.status === 404) {
        // Never accepted. Wait out a POST that may still be in flight, then resend
        // the same request id with a fresh capture of the same targets.
        if (Date.now() - req.createdAt < 15_000) continue;
        const ref = allRefs.current.get(req.lensId);
        if (!ref || ref.fingerprint !== req.fingerprint) {
          await request("release", { requestId: req.requestId, error: "The lens changed before this evaluation was sent.", state: "missing" });
          continue;
        }
        const claim = await request("claim", { lens: ref, resumeRequestId: req.requestId }, 120_000).catch(() => null);
        if (claim?.requestId && claim.targets.length) await submit(ref, claim);
        else await request("release", { requestId: req.requestId, error: "The tabs changed before this evaluation was sent.", state: "missing" });
        continue;
      }
      if (res.status !== 200) continue;
      const status = res.data;
      if (!req.batchId)
        await request("accepted", { requestId: req.requestId, batchId: status.batchId, jobs: status.targets.map((t) => ({ targetKey: t.targetKey, jobId: t.jobId })) });
      const items: DepositItem[] = status.targets
        .filter((t) => t.state !== "acked")
        .map((t) => ({
          targetKey: t.targetKey,
          state: t.state as DepositItem["state"],
          answer: t.answer,
          model: t.model,
          evaluatedAt: t.evaluatedAt,
          error: t.error,
          jobId: t.jobId,
        }));
      if (!items.length) continue;
      await request("deposit", { requestId: req.requestId, batchId: status.batchId, items });
      // Stored locally (or no longer wanted): the backend may purge the payload.
      const done = items.filter((i) => i.state === "done").map((i) => i.targetKey);
      if (done.length) await call(`/browser/evaluations/${req.requestId}/ack`, "POST", { targetKeys: done }).catch(() => {});
    }
  }, [connected, request, submit]);

  useEffect(() => {
    if (!connected) return;
    void poll();
    const timer = setInterval(() => void poll(), pendingCount ? 1500 : 5000);
    return () => clearInterval(timer);
  }, [connected, poll, pendingCount, resultsVersion]);

  return {
    results,
    pendingCount,
    offline,
    notice,
    dismissNotice: () => setNotice(null),
    /** Explicit retry / re-evaluation of specific tabs (never automatic). */
    evaluate: async (lens: Lens, tabInstanceIds: string[], source: "dom" | "metadata" = "dom") => {
      await claimAndSubmit(lensRef(lens), { tabInstanceIds, force: true, source });
      await poll();
    },
    /** Clean: drop results, bump generation, cancel queued backend work. */
    clean: async (lensIds: string[], tabInstanceIds?: string[]) => {
      const { removed, requestIds } = await request("clean", { lensIds, tabInstanceIds });
      await Promise.all(requestIds.map((id) => call(`/browser/evaluations/${id}`, "DELETE", {}).catch(() => {})));
      return removed;
    },
    maxTargets: BROWSER_LIMITS.maxTargets,
  };
}
