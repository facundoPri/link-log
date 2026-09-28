import {
  cacheKey,
  IN_FLIGHT,
  parseTargetKey,
  targetKey,
  type Capture,
  type CaptureSummary,
  type DepositItem,
  type LensRecord,
  type LensRef,
  type PendingRequest,
} from "@linklog/browser-protocol";
import { QuotaError, type KV, type Mutex } from "./kv";

type TabResults = { gens: Record<string, number>; entries: Record<string, LensRecord> };
type RequestRecord = {
  requestId: string;
  scope: string;
  session: string;
  lensId: string;
  fingerprint: string;
  createdAt: number;
  batchId: string | null;
  targets: { targetKey: string; tabInstanceId: string }[];
};
type CaptureEntry = { documentRevision: number; source: "dom" | "metadata"; capture: Capture; bytes: number; at: number };

export type Candidate = { tabInstanceId: string; documentRevision: number; eligible: boolean };
export type Claimed = { tabInstanceId: string; documentRevision: number; generation: number; targetKey: string };

const RES = "res:";
const REQ = "req:";
const CAP = "cap:";
const CAP_INDEX = "capIndex";
/** Captures are evicted separately from results so results are never silently re-bought. */
export const CAPTURE_BUDGET = 3 * 1024 * 1024;
const CAPTURE_MAX = 1024 * 1024;
const FINAL = new Set(["done", "failed", "unavailable", "expired"]);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Whether a backend status differs from what is stored (state, answer, error, job). */
export function changed(rec: LensRecord, item: DepositItem): boolean {
  return (
    rec.state !== item.state ||
    !same(rec.answer, item.answer) ||
    (rec.error ?? null) !== (item.error ?? null) ||
    (item.jobId !== undefined && item.jobId !== rec.jobId)
  );
}

/**
 * Lens results per tab opening in chrome.storage.session. Logical key:
 * libraryScope / browserSessionId / tabInstanceId / documentRevision / lens / version / generation.
 */
export class ResultCache {
  constructor(
    private kv: KV,
    private mutex: Mutex,
    private now: () => number = Date.now,
    private uuid: () => string = () => crypto.randomUUID(),
  ) {}

  private async tabs(ids: string[]): Promise<Map<string, TabResults>> {
    const raw = await this.kv.getMany(ids.map((id) => RES + id));
    return new Map(
      ids.map((id) => [id, (raw[RES + id] as TabResults | undefined) ?? { gens: {}, entries: {} }]),
    );
  }

  private key(scope: string, session: string, tabInstanceId: string, documentRevision: number, lens: LensRef, generation: number) {
    return cacheKey(scope, session, {
      tabInstanceId,
      documentRevision,
      lensId: lens.id,
      fingerprint: lens.fingerprint,
      generation,
    });
  }

  async read(scope: string, session: string, tabs: { tabInstanceId: string; documentRevision: number }[], lenses: LensRef[]) {
    const stored = await this.tabs(tabs.map((t) => t.tabInstanceId));
    const out: Record<string, Record<string, LensRecord>> = {};
    for (const t of tabs) {
      const tr = stored.get(t.tabInstanceId)!;
      for (const lens of lenses) {
        const rec = tr.entries[this.key(scope, session, t.tabInstanceId, t.documentRevision, lens, tr.gens[lens.id] ?? 0)];
        if (rec) (out[t.tabInstanceId] ??= {})[lens.id] = rec;
      }
    }
    return out;
  }

  /** Atomically marks missing (or explicitly retried) targets as submitting under a new request id. */
  claim(input: {
    scope: string;
    session: string;
    lens: LensRef;
    candidates: Candidate[];
    force?: Set<string>;
    limit: number;
    resumeRequestId?: string;
  }): Promise<{ requestId: string | null; claimed: Claimed[]; skipped: number }> {
    return this.mutex.run(async () => {
      const { scope, session, lens } = input;
      if (input.resumeRequestId) {
        const req = await this.kv.get<RequestRecord>(REQ + input.resumeRequestId);
        if (!req || req.batchId) return { requestId: null, claimed: [], skipped: 0 };
        const stored = await this.tabs(req.targets.map((t) => t.tabInstanceId));
        const claimed: Claimed[] = [];
        for (const t of req.targets) {
          const parts = parseTargetKey(t.targetKey)!;
          const c = input.candidates.find((x) => x.tabInstanceId === t.tabInstanceId);
          const rec = stored.get(t.tabInstanceId)!.entries[cacheKey(scope, session, parts)];
          if (c?.eligible && c.documentRevision === parts.documentRevision && rec?.state === "submitting" && rec.requestId === req.requestId)
            claimed.push({ tabInstanceId: t.tabInstanceId, documentRevision: parts.documentRevision, generation: parts.generation, targetKey: t.targetKey });
        }
        return { requestId: req.requestId, claimed, skipped: 0 };
      }
      const requestId = this.uuid();
      const eligible = input.candidates.filter((c) => c.eligible);
      const stored = await this.tabs(eligible.map((c) => c.tabInstanceId));
      const claimed: Claimed[] = [];
      let skipped = 0;
      const writes: Record<string, unknown> = {};
      for (const c of eligible) {
        const tr = stored.get(c.tabInstanceId)!;
        const generation = tr.gens[lens.id] ?? 0;
        const key = this.key(scope, session, c.tabInstanceId, c.documentRevision, lens, generation);
        const rec = tr.entries[key];
        const wanted =
          !rec ||
          rec.state === "missing" ||
          (!!input.force?.has(c.tabInstanceId) && !IN_FLIGHT.includes(rec.state));
        if (!wanted) continue;
        if (claimed.length >= input.limit) {
          skipped++;
          continue;
        }
        tr.entries[key] = { state: "submitting", requestId, updatedAt: this.now() };
        writes[RES + c.tabInstanceId] = tr;
        claimed.push({
          tabInstanceId: c.tabInstanceId,
          documentRevision: c.documentRevision,
          generation,
          targetKey: targetKey({ tabInstanceId: c.tabInstanceId, documentRevision: c.documentRevision, lensId: lens.id, fingerprint: lens.fingerprint, generation }),
        });
      }
      if (!claimed.length) return { requestId: null, claimed, skipped };
      // The request id is stored before the page POSTs, so a lost response is reconciled, never re-bought.
      const req: RequestRecord = {
        requestId,
        scope,
        session,
        lensId: lens.id,
        fingerprint: lens.fingerprint,
        createdAt: this.now(),
        batchId: null,
        targets: claimed.map((c) => ({ targetKey: c.targetKey, tabInstanceId: c.tabInstanceId })),
      };
      writes[REQ + requestId] = req;
      await this.guardedSet(writes);
      return { requestId, claimed, skipped };
    });
  }

  /** Updates records of a request that still belong to it. */
  private async update(
    requestId: string,
    fn: (rec: LensRecord, target: { targetKey: string; tabInstanceId: string }) => LensRecord | null | undefined,
    only?: Set<string>,
    scope?: string,
  ) {
    const found = await this.kv.get<RequestRecord>(REQ + requestId);
    // A page only touches requests of its own library scope.
    const req = found && (!scope || found.scope === scope) ? found : null;
    if (!req) return { req: null, stored: [] as string[], dropped: [...(only ?? [])] };
    const targets = req.targets.filter((t) => !only || only.has(t.targetKey));
    const stored = await this.tabs(targets.map((t) => t.tabInstanceId));
    const writes: Record<string, unknown> = {};
    const done: string[] = [];
    const dropped: string[] = [...(only ?? [])].filter((k) => !targets.some((t) => t.targetKey === k));
    for (const t of targets) {
      const parts = parseTargetKey(t.targetKey)!;
      const tr = stored.get(t.tabInstanceId)!;
      const key = cacheKey(req.scope, req.session, parts);
      const rec = tr.entries[key];
      if (!rec || rec.requestId !== requestId || (tr.gens[parts.lensId] ?? 0) !== parts.generation) {
        dropped.push(t.targetKey);
        continue;
      }
      const next = fn(rec, t);
      if (next === undefined) continue;
      if (next === null) delete tr.entries[key];
      else tr.entries[key] = next;
      writes[RES + t.tabInstanceId] = tr;
      done.push(t.targetKey);
    }
    return { req, writes, stored: done, dropped };
  }

  recordCapture(requestId: string, summaries: Map<string, CaptureSummary>, failures: Map<string, string>) {
    return this.mutex.run(async () => {
      const { req, writes } = await this.update(requestId, (rec, t) => {
        const failure = failures.get(t.targetKey);
        if (failure !== undefined)
          return { ...rec, state: "unavailable", error: failure, updatedAt: this.now() };
        const summary = summaries.get(t.targetKey);
        return summary ? { ...rec, capture: summary, updatedAt: this.now() } : undefined;
      });
      if (!req) return;
      req.targets = req.targets.filter((t) => !failures.has(t.targetKey));
      if (req.targets.length) (writes as Record<string, unknown>)[REQ + requestId] = req;
      await this.guardedSet(writes ?? {});
      if (!req.targets.length) await this.kv.remove([REQ + requestId]);
    });
  }

  /** Hands claimed targets back (e.g. over the request size budget); they are missing again. */
  unclaim(requestId: string, keys: Set<string>) {
    return this.mutex.run(async () => {
      const { req, writes } = await this.update(requestId, (rec) => (rec.state === "submitting" ? null : undefined), keys);
      if (!req) return;
      req.targets = req.targets.filter((t) => !keys.has(t.targetKey));
      await this.guardedSet(writes ?? {});
      if (req.targets.length) await this.kv.set({ [REQ + requestId]: req });
      else await this.kv.remove([REQ + requestId]);
    });
  }

  accepted(requestId: string, batchId: string, jobs: { targetKey: string; jobId: string }[], scope?: string) {
    return this.mutex.run(async () => {
      const byKey = new Map(jobs.map((j) => [j.targetKey, j.jobId]));
      const { req, writes } = await this.update(requestId, (rec, t) =>
        rec.state === "submitting"
          ? { ...rec, state: "queued", batchId, jobId: byKey.get(t.targetKey), updatedAt: this.now() }
          : undefined,
        undefined,
        scope,
      );
      if (!req) return;
      req.batchId = batchId;
      await this.guardedSet({ ...writes, [REQ + requestId]: req });
    });
  }

  release(requestId: string, error: string, state: "failed" | "missing", scope?: string) {
    return this.mutex.run(async () => {
      const { req, writes } = await this.update(requestId, (rec) =>
        IN_FLIGHT.includes(rec.state)
          ? state === "missing"
            ? null
            : { ...rec, state: "failed", error, updatedAt: this.now() }
          : undefined,
        undefined,
        scope,
      );
      if (!req) return;
      await this.guardedSet(writes ?? {});
      await this.kv.remove([REQ + requestId]);
    });
  }

  /**
   * Stores backend results. A result is dropped when its tab closed, navigated,
   * was cleaned (generation) or re-claimed since: late responses never resurrect.
   */
  deposit(
    requestId: string,
    batchId: string | undefined,
    items: DepositItem[],
    currentRevision: (tabInstanceId: string) => number | undefined,
    scope?: string,
  ) {
    return this.mutex.run(async () => {
      const byKey = new Map(items.map((i) => [i.targetKey, i]));
      const navigated: string[] = [];
      const { req, writes, stored, dropped } = await this.update(
        requestId,
        (rec, t) => {
          const item = byKey.get(t.targetKey)!;
          if (currentRevision(t.tabInstanceId) !== parseTargetKey(t.targetKey)!.documentRevision) {
            navigated.push(t.targetKey);
            return null;
          }
          if (FINAL.has(rec.state)) return undefined;
          // Only real changes are written and reported: a poll that sees "still queued"
          // must not announce new results (the page would poll again right away).
          if (!changed(rec, item)) return undefined;
          return {
            ...rec,
            state: item.state,
            answer: item.answer,
            model: item.model,
            evaluatedAt: item.evaluatedAt,
            error: item.error,
            jobId: item.jobId ?? rec.jobId,
            batchId: batchId ?? rec.batchId,
            updatedAt: this.now(),
          };
        },
        new Set(byKey.keys()),
        scope,
      );
      if (!req) return { stored: [], dropped };
      await this.guardedSet(writes ?? {});
      // Forget the request once no target is in flight any more.
      const still = await this.tabs(req.targets.map((t) => t.tabInstanceId));
      const open = req.targets.filter((t) => {
        const rec = still.get(t.tabInstanceId)!.entries[cacheKey(req.scope, req.session, parseTargetKey(t.targetKey)!)];
        return rec?.requestId === requestId && IN_FLIGHT.includes(rec.state);
      });
      if (!open.length) await this.kv.remove([REQ + requestId]);
      else if (open.length !== req.targets.length)
        await this.kv.set({ [REQ + requestId]: { ...req, batchId: batchId ?? req.batchId, targets: open } });
      return {
        stored: stored.filter((k) => !navigated.includes(k)),
        dropped: [...dropped, ...navigated],
      };
    });
  }

  /**
   * Clean: drop results in scope and bump the generation so in-flight answers are
   * rejected. Definitions and groups are untouched. Returns requests to cancel.
   */
  clean(lensIds: string[], tabInstanceIds: string[]) {
    return this.mutex.run(async () => {
      const stored = await this.tabs(tabInstanceIds);
      const writes: Record<string, unknown> = {};
      const cancel = new Map<string, string[]>();
      let removed = 0;
      for (const [id, tr] of stored) {
        for (const lensId of lensIds) tr.gens[lensId] = (tr.gens[lensId] ?? 0) + 1;
        for (const [key, rec] of Object.entries(tr.entries)) {
          const target = key.split("/").pop()!;
          const parts = parseTargetKey(target);
          if (!parts || !lensIds.includes(parts.lensId)) continue;
          if (rec.requestId && IN_FLIGHT.includes(rec.state))
            cancel.set(rec.requestId, [...(cancel.get(rec.requestId) ?? []), target]);
          delete tr.entries[key];
          removed++;
        }
        writes[RES + id] = tr;
      }
      await this.kv.set(writes);
      await this.pruneRequests((t) => tabInstanceIds.includes(t.tabInstanceId) && lensIds.includes(parseTargetKey(t.targetKey)!.lensId));
      return { removed, requests: [...cancel].map(([requestId, targetKeys]) => ({ requestId, targetKeys })) };
    });
  }

  private async pruneRequests(drop: (t: { targetKey: string; tabInstanceId: string }) => boolean) {
    const keys = await this.kv.keys(REQ);
    const reqs = await this.kv.getMany(keys);
    const writes: Record<string, unknown> = {};
    const removes: string[] = [];
    for (const [key, raw] of Object.entries(reqs)) {
      const req = raw as RequestRecord;
      const targets = req.targets.filter((t) => !drop(t));
      if (targets.length === req.targets.length) continue;
      if (targets.length) writes[key] = { ...req, targets };
      else removes.push(key);
    }
    await this.kv.set(writes);
    await this.kv.remove(removes);
  }

  /** Tab closed: its association disappears, whatever is still in flight. */
  dropTab(tabInstanceId: string) {
    return this.mutex.run(async () => {
      await this.kv.remove([RES + tabInstanceId, CAP + tabInstanceId]);
      await this.dropCaptureIndex([tabInstanceId]);
      await this.pruneRequests((t) => t.tabInstanceId === tabInstanceId);
    });
  }

  /** Navigation: results and captures of earlier documents are invalid. */
  dropStaleRevisions(tabInstanceId: string, documentRevision: number) {
    return this.mutex.run(async () => {
      const tr = (await this.tabs([tabInstanceId])).get(tabInstanceId)!;
      let changed = false;
      for (const key of Object.keys(tr.entries)) {
        const parts = parseTargetKey(key.split("/").pop()!);
        if (parts && parts.documentRevision < documentRevision) {
          delete tr.entries[key];
          changed = true;
        }
      }
      if (changed) await this.kv.set({ [RES + tabInstanceId]: tr });
      const cap = await this.kv.get<CaptureEntry>(CAP + tabInstanceId);
      if (cap && cap.documentRevision < documentRevision) {
        await this.kv.remove([CAP + tabInstanceId]);
        await this.dropCaptureIndex([tabInstanceId]);
      }
      await this.pruneRequests(
        (t) => t.tabInstanceId === tabInstanceId && parseTargetKey(t.targetKey)!.documentRevision < documentRevision,
      );
    });
  }

  async pending(scope: string): Promise<PendingRequest[]> {
    const keys = await this.kv.keys(REQ);
    const reqs = Object.values(await this.kv.getMany(keys)) as RequestRecord[];
    const out: PendingRequest[] = [];
    for (const req of reqs.filter((r) => r.scope === scope)) {
      const stored = await this.tabs(req.targets.map((t) => t.tabInstanceId));
      out.push({
        requestId: req.requestId,
        lensId: req.lensId,
        fingerprint: req.fingerprint,
        batchId: req.batchId,
        createdAt: req.createdAt,
        targets: req.targets.map((t) => ({
          targetKey: t.targetKey,
          state: stored.get(t.tabInstanceId)!.entries[cacheKey(req.scope, req.session, parseTargetKey(t.targetKey)!)]?.state ?? "missing",
        })),
      });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async getCapture(tabInstanceId: string, documentRevision: number, source: "dom" | "metadata") {
    const entry = await this.kv.get<CaptureEntry>(CAP + tabInstanceId);
    return entry && entry.documentRevision === documentRevision && entry.source === source ? entry.capture : null;
  }

  /** Captures live in their own LRU budget; oversized ones are used once and not kept. */
  putCapture(tabInstanceId: string, documentRevision: number, source: "dom" | "metadata", capture: Capture) {
    return this.mutex.run(async () => {
      const bytes = JSON.stringify(capture).length * 2;
      if (bytes > CAPTURE_MAX) return;
      const index = (await this.kv.get<Record<string, { bytes: number; at: number }>>(CAP_INDEX)) ?? {};
      // The previous capture of this tab is replaced (or dropped if the new one doesn't fit).
      const evict = [tabInstanceId];
      delete index[tabInstanceId];
      let total = Object.values(index).reduce((n, e) => n + e.bytes, 0);
      for (const [id, e] of Object.entries(index).sort((a, b) => a[1].at - b[1].at)) {
        if (total + bytes <= CAPTURE_BUDGET) break;
        evict.push(id);
        total -= e.bytes;
        delete index[id];
      }
      // Index first, then data: whatever fails below, the index never lists a missing capture.
      await this.kv.set({ [CAP_INDEX]: index });
      await this.kv.remove(evict.map((id) => CAP + id));
      try {
        await this.kv.set({ [CAP + tabInstanceId]: { documentRevision, source, capture, bytes, at: this.now() } });
      } catch (error) {
        if (!(error instanceof QuotaError)) throw error;
        return; // A capture that doesn't fit is simply not cached.
      }
      index[tabInstanceId] = { bytes, at: this.now() };
      await this.kv.set({ [CAP_INDEX]: index }).catch(async (error) => {
        if (!(error instanceof QuotaError)) throw error;
        await this.kv.remove([CAP + tabInstanceId]); // unindexed data would never be evicted
      });
    });
  }

  private async dropCaptureIndex(ids: string[]) {
    const index = (await this.kv.get<Record<string, unknown>>(CAP_INDEX)) ?? {};
    let changed = false;
    for (const id of ids) if (id in index) (delete index[id], (changed = true));
    if (changed) await this.kv.set({ [CAP_INDEX]: index });
  }

  /** Makes room by evicting captures only; results are never evicted silently. */
  private async guardedSet(writes: Record<string, unknown>) {
    if (!Object.keys(writes).length) return;
    const incoming = JSON.stringify(writes).length * 2;
    if ((await this.kv.bytesInUse()) + incoming > this.kv.quota * 0.95) {
      const index = (await this.kv.get<Record<string, unknown>>(CAP_INDEX)) ?? {};
      await this.kv.remove([...Object.keys(index).map((id) => CAP + id), CAP_INDEX]);
    }
    await this.kv.set(writes);
  }

  async usage() {
    const index = (await this.kv.get<Record<string, { bytes: number }>>(CAP_INDEX)) ?? {};
    return {
      bytes: await this.kv.bytesInUse(),
      quota: this.kv.quota,
      captureBytes: Object.values(index).reduce((n, e) => n + e.bytes, 0),
    };
  }
}
