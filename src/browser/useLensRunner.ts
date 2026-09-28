import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BROWSER_LIMITS,
  lensFingerprint,
  type Commands,
  type DepositItem,
  type Lens,
  type LensRecord,
  type LensRef,
} from "@linklog/browser-protocol";
import { call, cancelTargets, evaluationStatus, evaluationTargets, OfflineError, postEvaluation } from "./api";
import type { BrowserState } from "./useBrowser";
import { claimRounds } from "./claimRounds";

export const lensRef = (lens: Lens): LensRef => ({ id: lens.id, fingerprint: lensFingerprint(lens) });

type ClaimArgs = Commands["claim"]["args"];
type ClaimResult = Commands["claim"]["result"];

const POLL_BUSY_MS = 1500;
const POLL_IDLE_MS = 5000;

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
  // Fingerprints are computed when the lenses change, not on every render; `refs` stays
  // stable while the active lenses' identities don't change.
  const refsKey = useMemo(() => active.map((l) => `${l.id}:${lensFingerprint(l)}`).join(","), [active]);
  const refs = useMemo<LensRef[]>(
    () =>
      refsKey
        ? refsKey.split(",").map((k) => {
            const [id, fingerprint] = k.split(":") as [string, string];
            return { id, fingerprint };
          })
        : [],
    [refsKey],
  );
  const allRefs = useMemo(() => new Map(allLenses.map((l) => [l.id, lensRef(l)])), [allLenses]);
  const allRefsRef = useRef(allRefs);
  allRefsRef.current = allRefs;

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
  }, [connected, refs, request]);

  useEffect(() => {
    void loadResults();
  }, [loadResults, snapshot?.revision, resultsVersion]);

  /** POSTs one claim; on a lost response the request id stays in the extension for recovery. */
  const submit = useCallback(
    async (ref: LensRef, claim: ClaimResult) => {
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

  /** Claims and POSTs in rounds; an explicit set of tabs is evaluated exactly once per call. */
  const claimAndSubmit = useCallback(
    (ref: LensRef, extra: Omit<ClaimArgs, "lens" | "limit" | "tabInstanceIds"> & { tabInstanceIds?: string[] } = {}) =>
      claimRounds(
        (tabInstanceIds) => request("claim", { ...extra, lens: ref, limit: 20, tabInstanceIds }, 120_000),
        (claim) => submit(ref, claim),
        extra.tabInstanceIds,
      ),
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
  }, [enabled, connected, refs, claimAndSubmit]);

  useEffect(() => {
    const timer = setTimeout(() => void fill(), 350);
    return () => clearTimeout(timer);
  }, [fill, snapshot?.revision, hello?.contentAccess]);

  // Recovery + polling of every request in flight, whichever page started it.
  const polling = useRef(false);
  const poll = useCallback(async () => {
    if (!connected || polling.current) return;
    polling.current = true;
    try {
      await pollOnce();
    } finally {
      polling.current = false;
    }

    async function pollOnce() {
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
          const ref = allRefsRef.current.get(req.lensId);
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
        // The extension reports (and announces) only real changes, so "still queued" is quiet.
        await request("deposit", { requestId: req.requestId, batchId: status.batchId, items });
        // Stored locally (or no longer wanted): the backend may purge the payload.
        const done = items.filter((i) => i.state === "done").map((i) => i.targetKey);
        if (done.length) await call(`/browser/evaluations/${req.requestId}/ack`, "POST", { targetKeys: done }).catch(() => {});
      }
    }
  }, [connected, request, submit]);

  // One self-scheduling loop: faster while work is pending. Result events don't restart it.
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const pendingRef = useRef(pendingCount);
  pendingRef.current = pendingCount;
  useEffect(() => {
    if (!connected) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      await pollRef.current().catch(() => {});
      if (!stopped) timer = setTimeout(() => void tick(), pendingRef.current ? POLL_BUSY_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [connected]);

  return {
    results,
    pendingCount,
    offline,
    notice,
    dismissNotice: () => setNotice(null),
    /**
     * Explicit retry / re-evaluation (never automatic). Every listed tab is evaluated
     * exactly once per call, including ones that already have an answer.
     */
    evaluate: async (lens: Lens, tabInstanceIds: string[], source: "dom" | "metadata" = "dom") => {
      await claimAndSubmit(lensRef(lens), { tabInstanceIds, force: true, source });
      await poll();
    },
    /** Clean: drop results, bump generation, cancel exactly the cleaned targets' queued work. */
    clean: async (lensIds: string[], tabInstanceIds?: string[]) => {
      const { removed, requests } = await request("clean", { lensIds, tabInstanceIds });
      await Promise.all(requests.map((r) => cancelTargets(r.requestId, r.targetKeys).catch(() => {})));
      return removed;
    },
    maxTargets: BROWSER_LIMITS.maxTargets,
  };
}
