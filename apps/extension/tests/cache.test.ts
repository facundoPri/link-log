import { describe, expect, test } from "bun:test";
import { parseTargetKey, type Capture } from "@linklog/browser-protocol";
import { CAPTURE_BUDGET, ResultCache, type Candidate } from "../src/background/cache";
import { memoryKV, Mutex, QuotaError } from "../src/background/kv";
import { TabRegistry } from "../src/background/registry";
import { isBridgeSender, isExtensionPage } from "../src/background/sender";
import { contentAccess } from "../src/background/hub";

const scope = "local:lib";
const session = "s1";
const lensA = { id: "lensA", fingerprint: "fa" };
const lensB = { id: "lensB", fingerprint: "fb" };
let n = 0;
const uuid = () => `id${++n}`;

function setup() {
  const kv = memoryKV();
  const cache = new ResultCache(kv, new Mutex(), () => 1000, uuid);
  return { kv, cache };
}
const tabs = (count: number, from = 0): Candidate[] =>
  Array.from({ length: count }, (_, i) => ({ tabInstanceId: `t${from + i}`, documentRevision: 0, eligible: true }));
const claim = (cache: ResultCache, lens = lensA, candidates = tabs(20), extra = {}) =>
  cache.claim({ scope, session, lens, candidates, limit: 100, ...extra });
async function finish(cache: ResultCache, requestId: string, keys: string[], rev = () => 0) {
  await cache.accepted(requestId, "batch", keys.map((k, i) => ({ targetKey: k, jobId: `job${i}` })));
  return cache.deposit(
    requestId,
    "batch",
    keys.map((k) => ({ targetKey: k, state: "done" as const, answer: { type: "noul" as const, noul: 0.9 }, model: "m" })),
    rev,
  );
}

describe("result cache", () => {
  test("20 + 3: existing results are reused and only the new tabs are claimed", async () => {
    const { cache } = setup();
    const first = await claim(cache);
    expect(first.claimed).toHaveLength(20);
    await finish(cache, first.requestId!, first.claimed.map((c) => c.targetKey));
    const again = await claim(cache, lensA, tabs(23));
    expect(again.claimed.map((c) => c.tabInstanceId)).toEqual(["t20", "t21", "t22"]);
    // toggling a lens off/on reads the cache; nothing new to claim
    await finish(cache, again.requestId!, again.claimed.map((c) => c.targetKey));
    expect((await claim(cache, lensA, tabs(23))).claimed).toHaveLength(0);
    const read = await cache.read(scope, session, tabs(23), [lensA, lensB]);
    expect(Object.keys(read)).toHaveLength(23);
    expect(read.t0!.lensA!.state).toBe("done");
    expect(read.t0!.lensB).toBeUndefined(); // inactive lens B waits for activation
  });

  test("two concurrent activations never claim the same tab twice", async () => {
    const { cache } = setup();
    const [a, b] = await Promise.all([claim(cache), claim(cache)]);
    expect(a.claimed.length + b.claimed.length).toBe(20);
    expect(new Set([...a.claimed, ...b.claimed].map((c) => c.tabInstanceId)).size).toBe(20);
  });

  test("in-flight requests are listed for recovery and can be resumed with the same id", async () => {
    const { cache } = setup();
    const c = await claim(cache, lensA, tabs(2));
    const pending = await cache.pending(scope);
    expect(pending.map((p) => p.requestId)).toEqual([c.requestId!]);
    expect(pending[0]!.targets.every((t) => t.state === "submitting")).toBe(true);
    const resumed = await cache.claim({ scope, session, lens: lensA, candidates: tabs(2), limit: 20, resumeRequestId: c.requestId! });
    expect(resumed.requestId).toBe(c.requestId);
    expect(resumed.claimed).toHaveLength(2);
    // no other page can claim them meanwhile
    expect((await claim(cache, lensA, tabs(2))).claimed).toHaveLength(0);
  });

  test("late results after close, navigation or clean never resurrect", async () => {
    const { cache } = setup();
    const c = await claim(cache, lensA, tabs(3));
    await cache.accepted(c.requestId!, "batch", c.claimed.map((x, i) => ({ targetKey: x.targetKey, jobId: `j${i}` })));
    await cache.dropTab("t0"); // closed
    await cache.dropStaleRevisions("t1", 1); // navigated
    const result = await cache.deposit(
      c.requestId!,
      "batch",
      c.claimed.map((x) => ({ targetKey: x.targetKey, state: "done" as const, answer: { type: "noul" as const, noul: 1 } })),
      (id) => (id === "t1" ? 1 : id === "t0" ? undefined : 0),
    );
    expect(result.stored).toEqual([c.claimed[2]!.targetKey]);
    const read = await cache.read(scope, session, tabs(3), [lensA]);
    expect(read.t0).toBeUndefined();
    expect(read.t1).toBeUndefined();

    const d = await claim(cache, lensB, tabs(1));
    const { requestIds } = await cache.clean(["lensB"], ["t0"]);
    expect(requestIds).toEqual([d.requestId!]);
    const late = await cache.deposit(d.requestId!, "b", [{ targetKey: d.claimed[0]!.targetKey, state: "done", answer: { type: "noul", noul: 1 } }], () => 0);
    expect(late.stored).toEqual([]);
    // clean bumped the generation: a fresh claim uses a new key
    const again = await claim(cache, lensB, tabs(1));
    expect(parseTargetKey(again.claimed[0]!.targetKey)!.generation).toBe(1);
  });

  test("failures stay failures (not No) and only an explicit retry re-claims them", async () => {
    const { cache } = setup();
    const c = await claim(cache, lensA, tabs(1));
    await cache.deposit(c.requestId!, "b", [{ targetKey: c.claimed[0]!.targetKey, state: "failed", error: "boom" }], () => 0);
    expect((await cache.read(scope, session, tabs(1), [lensA])).t0!.lensA!.state).toBe("failed");
    expect((await claim(cache, lensA, tabs(1))).claimed).toHaveLength(0);
    expect((await claim(cache, lensA, tabs(1), { force: new Set(["t0"]) })).claimed).toHaveLength(1);
  });

  test("lens version is part of the key; unrelated lenses are independent", async () => {
    const { cache } = setup();
    const c = await claim(cache, lensA, tabs(1));
    await finish(cache, c.requestId!, [c.claimed[0]!.targetKey]);
    expect((await claim(cache, { id: "lensA", fingerprint: "changed" }, tabs(1))).claimed).toHaveLength(1);
  });

  test("captures are evicted within their own budget and quota errors surface", async () => {
    const { kv, cache } = setup();
    const capture = (size: number): Capture => ({
      source: "dom",
      capturedAt: "t",
      completeness: "complete",
      reasons: [],
      chars: size,
      facts: [],
      url: "u",
      title: "t",
      description: "",
      siteName: "",
      markdown: "x".repeat(size),
    });
    for (let i = 0; i < 8; i++) await cache.putCapture(`c${i}`, 0, "dom", capture(240_000));
    const usage = await cache.usage();
    expect(usage.captureBytes).toBeLessThanOrEqual(CAPTURE_BUDGET);
    expect(await cache.getCapture("c0", 0, "dom")).toBeNull(); // oldest evicted
    expect(await cache.getCapture("c7", 0, "dom")).not.toBeNull();
    const tiny = memoryKV(2000);
    const small = new ResultCache(tiny, new Mutex(), () => 1, uuid);
    await expect(small.claim({ scope, session, lens: lensA, candidates: tabs(30), limit: 30 })).rejects.toBeInstanceOf(QuotaError);
    void kv;
  });
});

describe("tab registry", () => {
  test("instances, revisions, reopen and replacement", async () => {
    const reg = new TabRegistry(memoryKV(), uuid, () => 5);
    const created = await reg.observe(1, "https://a.dev/x");
    const id = created!.instance.tabInstanceId;
    expect(await reg.observe(1, "https://a.dev/x#section")).toBeNull(); // fragment only
    const nav = await reg.observe(1, "https://a.dev/y");
    expect(nav).toMatchObject({ kind: "navigated", previousRevision: 0 });
    expect(reg.get(1)!.documentRevision).toBe(1);
    expect(reg.get(1)!.tabInstanceId).toBe(id);
    await reg.remove(1);
    const reopened = await reg.observe(2, "https://a.dev/y");
    expect(reopened!.instance.tabInstanceId).not.toBe(id);
    const changes = await reg.replace(3, 2, "https://a.dev/y");
    expect(changes).toEqual([]);
    expect(reg.get(3)!.tabInstanceId).toBe(reopened!.instance.tabInstanceId);
    const gone = await reg.reconcile([{ id: 3, url: "https://a.dev/z" }, { id: 9, url: "https://b.dev" }]);
    expect(gone.map((c) => c.kind).sort()).toEqual(["created", "navigated"]);
    expect((await reg.reconcile([])).map((c) => c.kind)).toEqual(["removed", "removed"]);
  });
});

describe("bridge sender validation", () => {
  const origins = ["http://127.0.0.1:3000"];
  const ok = { id: "ext", tab: { id: 4, url: "http://127.0.0.1:3000/" }, frameId: 0, origin: "http://127.0.0.1:3000" };
  test("accepts only this extension's top-frame script on a Linklog origin", () => {
    expect(isBridgeSender(ok, "ext", origins)).toBe(true);
    expect(isBridgeSender({ ...ok, id: "other" }, "ext", origins)).toBe(false);
    expect(isBridgeSender({ ...ok, frameId: 3 }, "ext", origins)).toBe(false);
    expect(isBridgeSender({ ...ok, origin: "https://evil.example" }, "ext", origins)).toBe(false);
    expect(isBridgeSender({ ...ok, origin: "http://127.0.0.1:3001" }, "ext", origins)).toBe(false);
    expect(isBridgeSender({ ...ok, tab: undefined }, "ext", origins)).toBe(false);
    expect(isBridgeSender({ ...ok, documentLifecycle: "prerender" }, "ext", origins)).toBe(false);
    expect(isBridgeSender({ ...ok, tab: { id: 4, url: "https://evil.example/" } }, "ext", origins)).toBe(false);
  });
  test("status channel is for extension pages only", () => {
    expect(isExtensionPage({ id: "ext", url: "chrome-extension://ext/popup.html" }, "ext", "chrome-extension://ext/")).toBe(true);
    expect(isExtensionPage({ id: "ext", url: "http://127.0.0.1:3000/" }, "ext", "chrome-extension://ext/")).toBe(false);
  });
});

describe("content access states", () => {
  const tab = (p: Partial<chrome.tabs.Tab>) => ({ url: "https://a.dev/x", status: "complete", discarded: false, ...p }) as chrome.tabs.Tab;
  const inst = { tabInstanceId: "i", documentRevision: 0, docKey: "", openedAt: 0, changedAt: 0 };
  const grants = ["https://*/*"];
  test("each unreadable case has its own state, never an answer", () => {
    expect(contentAccess(tab({}), inst, grants, 10_000)).toBe("available");
    expect(contentAccess(tab({ discarded: true, status: "unloaded" }), inst, grants, 10_000)).toBe("discarded");
    expect(contentAccess(tab({ frozen: true } as Partial<chrome.tabs.Tab>), inst, grants, 10_000)).toBe("frozen");
    expect(contentAccess(tab({ url: "chrome://settings" }), inst, grants, 10_000)).toBe("restricted");
    expect(contentAccess(tab({ url: "http://a.dev/" }), inst, grants, 10_000)).toBe("no-permission");
    expect(contentAccess(tab({ status: "loading" }), inst, grants, 10_000)).toBe("loading");
    // a navigation that just happened (SPA) settles before it is read
    expect(contentAccess(tab({}), { ...inst, changedAt: 9_500 }, grants, 10_000)).toBe("loading");
  });
});
