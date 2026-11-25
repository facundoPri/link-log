import { beforeEach, describe, expect, test } from "bun:test";
import { documentKey, LOADING_BOUND_MS, type BrowserTab, type PageRequest, type WindowSnapshot } from "@linklog/browser-protocol";
import { fakeChrome } from "./fake-chrome";
import { ResultCache } from "../src/background/cache";
import { handle, type Services } from "../src/background/commands";
import { GroupMetaStore } from "../src/background/groups";
import { Hub, type Connection } from "../src/background/hub";
import { memoryKV, Mutex, QuotaError } from "../src/background/kv";
import { LoadQueue } from "../src/background/loader";
import { OpenLedger } from "../src/background/opens";
import { TabRegistry } from "../src/background/registry";

const LINKLOG_TAB = 99;
const N = 3;
let fake: ReturnType<typeof fakeChrome>;
let kv: ReturnType<typeof memoryKV>;
/** storage.local: survives a worker restart like storage.session (`kv`) does here. */
let local: ReturnType<typeof memoryKV>;
let s: Services;
let c: Connection;
let seq = 0;

/** One service-worker lifetime over the same storage and browser. */
async function boot() {
  const mutex = new Mutex();
  const registry = new TabRegistry(kv, () => `inst${++seq}`, () => 0);
  await registry.load();
  const groups = new GroupMetaStore(kv, mutex);
  const hub = new Hub(kv, registry, groups);
  hub.grants = ["http://*/*", "https://*/*"];
  const cache = new ResultCache(kv, mutex);
  const loader = new LoadQueue(kv, mutex, registry, cache, hub, { concurrency: N, readyTimeoutMs: 150, settleMs: 0, pollMs: 2 }, local);
  hub.cache = cache;
  hub.loader = loader;
  s = { registry, cache, groups, hub, opens: new OpenLedger(kv), loader, ids: { installationId: "inst", browserSessionId: "sess" } };
  c = { id: "c1", port: { postMessage() {} } as unknown as chrome.runtime.Port, tabId: LINKLOG_TAB, windowId: null, scope: null, last: null };
  hub.connections.set(c.id, c);
  await loader.resume();
  await run("hello", { libraryScope: "local:lib" });
}

async function setup() {
  fake = fakeChrome();
  kv = memoryKV();
  local = memoryKV();
  fake.addTab(LINKLOG_TAB, "http://localhost:4321/", 1, { active: true });
  await boot();
}

const run = <K extends PageRequest["command"]>(command: K, args: Extract<PageRequest, { command: K }>["args"]) =>
  handle({ id: `r${++seq}`, command, args } as PageRequest, c, s) as Promise<any>;
const snapshot = (): Promise<WindowSnapshot> => run("snapshot", {});
const tabOf = async (id: number) => (await snapshot()).tabs.find((t) => t.tabId === id)!;
const ref = (t: BrowserTab) => ({ tabId: t.tabId, tabInstanceId: t.tabInstanceId, documentRevision: t.documentRevision });
const refs = async (ids: number[]) => {
  const snap = await snapshot();
  return ids.map((id) => ref(snap.tabs.find((t) => t.tabId === id)!));
};
async function settled(status: string[] = ["done"], timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const snap = await snapshot();
    if (snap.loadRun && status.includes(snap.loadRun.status)) return snap;
    await Bun.sleep(5);
  }
  throw new Error(`run never reached ${status.join("/")}: ${JSON.stringify((await snapshot()).loadRun)}`);
}
async function until(what: string, fn: () => Promise<boolean> | boolean, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await Bun.sleep(2);
  }
  throw new Error(`timed out: ${what}`);
}
const site = (i: number) => `https://site.dev/${i}`;
function sleepingTabs(count: number, reason: "unloaded" | "frozen" | "not-loaded" = "unloaded") {
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  for (const id of ids) fake.addSleeping(id, site(id), reason);
  return ids;
}

beforeEach(() => {
  seq = 0;
});

describe("Sleeping tabs", () => {
  test("discarded, frozen and restored-but-never-loaded tabs are sleeping, with the reason", async () => {
    await setup();
    fake.addSleeping(1, site(1), "unloaded");
    fake.addSleeping(2, site(2), "frozen");
    fake.addSleeping(3, site(3), "not-loaded");
    fake.addTab(4, site(4));
    const tabs = (await snapshot()).tabs;
    expect(tabs.map((t) => [t.tabId, t.content, t.sleep])).toEqual([
      [1, "sleeping", "unloaded"],
      [2, "sleeping", "frozen"],
      [3, "sleeping", "not-loaded"],
      [4, "available", null],
    ]);
    expect(tabs.find((t) => t.tabId === 3)!.status).toBe("unloaded");
  });

  test("loading is bounded: past the bound the tab is stalled, not loading", async () => {
    await setup();
    fake.addTab(1, site(1), 1, { status: "loading" });
    let now = 1_000_000;
    s.hub.now = () => now;
    expect((await tabOf(1)).content).toBe("loading");
    now += LOADING_BOUND_MS + 1;
    expect((await tabOf(1)).content).toBe("stalled");
  });

  test("a page sees a tab turn stalled when the loading bound passes, without another browser event", async () => {
    await setup();
    const timers: { fn: () => void; ms: number }[] = [];
    s.hub.later = (fn, ms) => timers.push({ fn, ms });
    const sent: { snapshot?: WindowSnapshot; patch?: { tabs?: BrowserTab[] } }[] = [];
    c.port = { postMessage: (m: never) => void sent.push(m) } as unknown as chrome.runtime.Port;
    fake.addTab(1, site(1), 1, { status: "loading" });
    let now = 1_000_000;
    s.hub.now = () => now;
    expect((await tabOf(1)).content).toBe("loading");
    const bound = timers.find((t) => t.ms >= LOADING_BOUND_MS);
    expect(bound).toBeDefined();
    now += LOADING_BOUND_MS + 1;
    bound!.fn();
    await until("a pushed update with the tab stalled", () => JSON.stringify(sent).includes('"stalled"'));
  });

  test("connecting, snapshots, lenses and previews never wake a tab", async () => {
    await setup();
    sleepingTabs(3, "not-loaded");
    const snap = await snapshot();
    await run("claim", { lens: { id: "lens", fingerprint: "fp" }, limit: 20 });
    await run("previews", { tabs: snap.tabs.map(ref) });
    await run("capture", { tabs: snap.tabs.map(ref) });
    expect(fake.count("reload")).toBe(0);
  });
});

describe("Load content", () => {
  test("wakes at most N at a time, replaces each as soon as it is back asleep, and captures every tab", async () => {
    await setup();
    const ids = sleepingTabs(10);
    fake.loadMs = 15;
    const result = await run("loadContent", { tabs: await refs(ids) });
    expect(result.items.every((i: { ok: boolean }) => i.ok)).toBe(true);
    const snap = await settled();
    expect(fake.maxAwakeByReload()).toBe(N);
    expect(ids.map((id) => fake.count("reload", id))).toEqual(ids.map(() => 1));
    expect(fake.ops.filter((o) => o.startsWith("reload")).map((o) => Number(o.split(":")[1]))).toEqual(ids);
    expect(ids.every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
    expect(snap.loadRun).toMatchObject({ status: "done", total: 10, done: 10, failed: 0, awake: 0 });
    expect(snap.tabs.filter((t) => ids.includes(t.tabId)).every((t) => t.content === "sleeping" && !!t.capturedAt && t.load?.state === "done")).toBe(true);
  });

  test("captured content stays readable and lenses can use it while the tab sleeps", async () => {
    await setup();
    sleepingTabs(1);
    fake.pages.get(1)!.markdown = "# Captured while awake";
    await run("loadContent", { tabs: await refs([1]) });
    const snap = await settled();
    const tab = snap.tabs.find((t) => t.tabId === 1)!;
    expect(tab.content).toBe("sleeping");
    const read = await run("capture", { tabs: [ref(tab)] });
    expect(read.captures[0].capture.markdown).toBe("# Captured while awake");
    const claim = await run("claim", { lens: { id: "lens", fingerprint: "fp" }, limit: 20 });
    expect(claim.targets.map((t: { tabId: number }) => t.tabId)).toEqual([1]);
    expect(fake.count("reload", 1)).toBe(1);
  });

  test("a lens waits for a tab Load content is still on, then reads its capture", async () => {
    await setup();
    sleepingTabs(1);
    // Hold the run's read of the page: the tab is awake and readable while the run is still on it.
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    const exec = chrome.scripting.executeScript;
    (chrome.scripting as { executeScript: unknown }).executeScript = async (args: never) => {
      await held;
      return exec(args);
    };
    await run("loadContent", { tabs: await refs([1]) });
    await until("the run is reading the awake tab", async () => (await tabOf(1)).load?.state === "capturing");
    expect((await tabOf(1)).content).toBe("available");
    const during = await run("claim", { lens: { id: "lens", fingerprint: "fp" }, limit: 20 });
    expect(during.targets).toEqual([]);
    release();
    await settled();
    const after = await run("claim", { lens: { id: "lens", fingerprint: "fp" }, limit: 20 });
    expect(after.targets.map((t: { tabId: number }) => t.tabId)).toEqual([1]);
    expect(fake.count("reload", 1)).toBe(1);
  });

  test("a restored-but-never-loaded tab is woken and put to sleep; a frozen one ends up asleep and says so", async () => {
    await setup();
    fake.addSleeping(1, site(1), "not-loaded");
    fake.addSleeping(2, site(2), "frozen");
    await run("loadContent", { tabs: await refs([1, 2]) });
    const snap = await settled();
    const [one, two] = [1, 2].map((id) => snap.tabs.find((t) => t.tabId === id)!);
    expect([one!.load?.state, two!.load?.state]).toEqual(["done", "done"]);
    expect([fake.tabs.get(1)!.discarded, fake.tabs.get(2)!.discarded, fake.tabs.get(2)!.frozen]).toEqual([true, true, false]);
    expect(two!.sleep).toBe("unloaded");
    expect(two!.load?.note).toMatch(/frozen/i);
  });

  test("a tab that doesn't load in time fails with the reason and goes back to sleep", async () => {
    await setup();
    sleepingTabs(2);
    fake.loadPlans.set(1, { hang: true });
    await run("loadContent", { tabs: await refs([1, 2]) });
    const snap = await settled();
    expect(snap.loadRun).toMatchObject({ done: 1, failed: 1 });
    const failed = snap.tabs.find((t) => t.tabId === 1)!;
    expect(failed.load).toMatchObject({ state: "failed" });
    expect(failed.load!.error).toMatch(/didn't finish loading/);
    expect(fake.tabs.get(1)!.discarded).toBe(true);
    expect(failed.capturedAt).toBeNull();
  });

  test("a tab that redirects (e.g. to a sign-in page) fails instead of capturing that page, and stays awake", async () => {
    await setup();
    sleepingTabs(1);
    fake.loadPlans.set(1, { redirectTo: "https://site.dev/login?next=/1" });
    await run("loadContent", { tabs: await refs([1]) });
    const snap = await settled();
    const tab = snap.tabs.find((t) => t.tabId === 1)!;
    expect(tab.load).toMatchObject({ state: "failed" });
    expect(tab.load!.error).toMatch(/sign-in|another address/);
    expect(tab.capturedAt).toBeNull();
    expect(fake.count("discard", 1)).toBe(0);
  });

  test("pause stops new wakes; resume finishes the rest", async () => {
    await setup();
    const ids = sleepingTabs(8);
    fake.loadMs = 20;
    await run("loadContent", { tabs: await refs(ids) });
    await until("first wake", () => fake.count("reload") > 0);
    await run("loadControl", { action: "pause" });
    const paused = await settled(["paused"]);
    await Bun.sleep(80);
    const woken = fake.count("reload");
    expect(woken).toBeLessThan(8);
    expect((await snapshot()).loadRun).toMatchObject({ status: "paused", awake: 0 });
    expect(fake.count("reload")).toBe(woken);
    expect(paused.loadRun!.queued).toBe(8 - woken);
    await run("loadControl", { action: "resume" });
    await settled();
    expect(ids.map((id) => fake.count("reload", id))).toEqual(ids.map(() => 1));
  });

  test("cancel puts the tabs it woke back to sleep, skips the rest and keeps finished results", async () => {
    await setup();
    const ids = sleepingTabs(8);
    fake.loadMs = 30;
    await run("loadContent", { tabs: await refs(ids) });
    await until("one done", async () => ((await snapshot()).loadRun?.done ?? 0) >= 1);
    await run("loadControl", { action: "cancel" });
    const snap = await settled(["cancelled"]);
    await until("everything asleep", () => ids.every((id) => fake.tabs.get(id)!.discarded));
    const final = await snapshot();
    expect(final.loadRun!.awake).toBe(0);
    expect(final.loadRun!.done).toBeGreaterThanOrEqual(1);
    expect(final.loadRun!.skipped).toBeGreaterThan(0);
    const done = final.tabs.filter((t) => t.load?.state === "done");
    expect(done.every((t) => !!t.capturedAt)).toBe(true);
    expect(snap.loadRun!.status).toBe("cancelled");
  });

  test("retry requeues only the failed tabs", async () => {
    await setup();
    sleepingTabs(3);
    fake.loadPlans.set(2, { hang: true });
    await run("loadContent", { tabs: await refs([1, 2, 3]) });
    await settled();
    fake.loadPlans.delete(2);
    await run("loadControl", { action: "retry" });
    const snap = await settled();
    expect(snap.loadRun).toMatchObject({ done: 3, failed: 0 });
    expect([1, 2, 3].map((id) => fake.count("reload", id))).toEqual([1, 2, 1]);
  });

  test("retry after a failed put-back-to-sleep puts the tab back to sleep", async () => {
    await setup();
    sleepingTabs(1);
    fake.discardErrors.set(1, "Cannot discard tab");
    await run("loadContent", { tabs: await refs([1]) });
    await settled(["paused"]);
    expect(fake.tabs.get(1)!.discarded).toBe(false);
    fake.discardErrors.delete(1);
    await run("loadControl", { action: "retry" });
    const snap = await settled();
    expect(snap.tabs.find((t) => t.tabId === 1)!.load?.state).toBe("done");
    expect(fake.tabs.get(1)!.discarded).toBe(true);
    expect(fake.count("reload", 1)).toBe(1);
  });

  test("a tab a cancelled run couldn't put back to sleep goes back to sleep in the next run, keeping its failure", async () => {
    await setup();
    sleepingTabs(2);
    fake.discardErrors.set(1, "Cannot discard tab");
    await run("loadContent", { tabs: await refs([1]) });
    await settled(["paused"]);
    await run("loadControl", { action: "cancel" });
    fake.discardErrors.delete(1);
    await run("loadContent", { tabs: await refs([2]) });
    const snap = await settled();
    expect([1, 2].map((id) => fake.tabs.get(id)!.discarded)).toEqual([true, true]);
    expect(fake.count("reload", 1)).toBe(1);
    expect(snap.tabs.find((t) => t.tabId === 1)!.load?.state).toBe("failed");
    expect(snap.tabs.find((t) => t.tabId === 2)!.load?.state).toBe("done");
  });

  test("a tab is not woken when the run can't save that it woke it", async () => {
    await setup();
    sleepingTabs(1);
    const set = kv.set.bind(kv);
    kv.set = async (items) => {
      const pending = (items as { loadRun?: { items: { woke: boolean }[] } }).loadRun;
      if (pending?.items.some((i) => i.woke)) throw new Error("storage unavailable");
      return set(items);
    };
    await run("loadContent", { tabs: await refs([1]) });
    const snap = await settled();
    expect(fake.count("reload", 1)).toBe(0);
    expect(snap.tabs.find((t) => t.tabId === 1)!.load).toMatchObject({ state: "failed", error: expect.stringMatching(/couldn't save/) });
  });

  test("a page too large to keep (storage full) fails instead of reporting a capture, and goes back to sleep", async () => {
    await setup();
    sleepingTabs(1);
    const set = kv.set.bind(kv);
    kv.set = async (items) => {
      if (Object.keys(items).some((k) => k.startsWith("cap:"))) throw new QuotaError();
      return set(items);
    };
    await run("loadContent", { tabs: await refs([1]) });
    const snap = await settled();
    const tab = snap.tabs.find((t) => t.tabId === 1)!;
    expect(tab.load).toMatchObject({ state: "failed", error: expect.stringMatching(/no room to keep/) });
    expect(tab.capturedAt ?? null).toBeNull();
    expect(fake.tabs.get(1)!.discarded).toBe(true);
  });

  for (const restart of [false, true])
    test(`Load content right after cancel wakes no tab twice and every woken tab ends asleep${restart ? ", across a worker restart" : ""}`, async () => {
      await setup();
      const ids = sleepingTabs(8);
      fake.loadMs = 30;
      await run("loadContent", { tabs: await refs(ids) });
      await until("slots full", () => fake.count("reload") === N);
      await run("loadControl", { action: "cancel" });
      await run("loadContent", { tabs: await refs(ids) });
      if (restart) {
        s.loader.stop();
        await boot();
      }
      const snap = await settled();
      await until("everything asleep", () => ids.every((id) => fake.tabs.get(id)!.discarded));
      expect(ids.map((id) => fake.count("reload", id))).toEqual(ids.map(() => 1));
      expect(fake.maxAwakeByReload()).toBeLessThanOrEqual(N);
      expect(snap.tabs.filter((t) => ids.includes(t.tabId)).every((t) => t.load !== null)).toBe(true);
    });

  test("a tab the user opens while it loads stays awake", async () => {
    await setup();
    sleepingTabs(1);
    fake.loadMs = 30;
    await run("loadContent", { tabs: await refs([1]) });
    await until("woken", () => fake.count("reload", 1) === 1);
    fake.tabs.get(1)!.active = true;
    const snap = await settled();
    const tab = snap.tabs.find((t) => t.tabId === 1)!;
    expect(tab.load?.state).toBe("done");
    expect(tab.capturedAt).not.toBeNull();
    expect(fake.count("discard", 1)).toBe(0);
    expect(tab.load?.note).toMatch(/awake/);
  });

  test("a tab the user opens while it is queued is captured without waking it and left awake", async () => {
    await setup();
    const ids = sleepingTabs(4);
    fake.loadMs = 40;
    await run("loadContent", { tabs: await refs(ids) });
    await until("slots full", () => fake.count("reload") === N);
    Object.assign(fake.tabs.get(4)!, { discarded: false, status: "complete", active: true });
    const snap = await settled();
    expect(snap.tabs.find((t) => t.tabId === 4)!.load?.state).toBe("done");
    expect(snap.tabs.find((t) => t.tabId === 4)!.capturedAt).not.toBeNull();
    expect([fake.count("reload", 4), fake.count("discard", 4)]).toEqual([0, 0]);
  });

  test("closed, moved and navigated tabs are skipped while the run continues", async () => {
    await setup();
    const ids = sleepingTabs(4);
    fake.loadMs = 20;
    const r = await refs(ids);
    fake.tabs.delete(2);
    fake.tabs.get(3)!.windowId = 2;
    await s.registry.observe(4, "https://site.dev/elsewhere");
    fake.tabs.get(4)!.url = "https://site.dev/elsewhere";
    const added = await run("loadContent", { tabs: r });
    expect(added.items.filter((i: { ok: boolean }) => i.ok).map((i: { tabId: number }) => i.tabId)).toEqual([1]);
    const snap = await settled();
    expect(snap.loadRun).toMatchObject({ done: 1 });
    expect([2, 3, 4].map((id) => fake.count("reload", id))).toEqual([0, 0, 0]);
  });

  test("a tab closed or moved while queued is skipped", async () => {
    await setup();
    const ids = sleepingTabs(5);
    fake.loadMs = 25;
    await run("loadContent", { tabs: await refs(ids) });
    fake.tabs.delete(5);
    await s.registry.remove(5);
    fake.tabs.get(4)!.windowId = 2;
    const snap = await settled();
    expect(snap.loadRun).toMatchObject({ done: 3, skipped: 2 });
    expect([fake.count("reload", 4), fake.count("reload", 5)]).toEqual([0, 0]);
  });

  test("if a tab can't be put back to sleep the run pauses and says why", async () => {
    await setup();
    const ids = sleepingTabs(6);
    fake.discardErrors.set(1, "Cannot discard tab");
    await run("loadContent", { tabs: await refs(ids) });
    const snap = await settled(["paused"]);
    await Bun.sleep(40);
    expect(snap.loadRun!.pauseReason).toMatch(/put a tab back to sleep/);
    expect(snap.tabs.find((t) => t.tabId === 1)!.load).toMatchObject({ state: "failed" });
    expect(fake.count("reload")).toBeLessThan(6);
  });

  test("a tab Chrome kept awake after a failed put-back counts against the awake limit after Resume", async () => {
    await setup();
    const ids = sleepingTabs(6);
    fake.discardErrors.set(1, "Cannot discard tab");
    await run("loadContent", { tabs: await refs(ids) });
    await settled(["paused"]);
    fake.loadMs = 30;
    await run("loadControl", { action: "resume" });
    await until("run finished or paused", async () => ["done", "paused"].includes((await snapshot()).loadRun!.status));
    const awake = () => ids.filter((id) => !fake.tabs.get(id)!.discarded).length;
    expect(fake.maxAwakeByReload()).toBeLessThanOrEqual(N);
    expect((await snapshot()).loadRun!.awake).toBe(awake());
  });

  for (const cancel of [false, true])
    test(`a page that never answers the read ${cancel ? "is skipped on cancel" : "fails after the bound"} and goes back to sleep`, async () => {
      await setup();
      sleepingTabs(1);
      const exec = chrome.scripting.executeScript;
      (chrome.scripting as { executeScript: unknown }).executeScript = async (args: { target: { tabId: number } }) =>
        args.target.tabId === 1 ? new Promise(() => {}) : exec(args as never);
      await run("loadContent", { tabs: await refs([1]) });
      if (cancel) {
        await until("reading", async () => (await tabOf(1)).load?.state === "capturing");
        await run("loadControl", { action: "cancel" });
      }
      const snap = await settled(cancel ? ["cancelled"] : ["done"]);
      await until("asleep again", () => !!fake.tabs.get(1)!.discarded);
      const load = snap.tabs.find((t) => t.tabId === 1)!.load;
      if (cancel) expect((await tabOf(1)).load).toMatchObject({ state: "skipped" });
      else expect(load).toMatchObject({ state: "failed", error: expect.stringMatching(/didn't answer/) });
    });

  test("Resume after the user puts a kept-awake tab to sleep frees its slot", async () => {
    await setup();
    const ids = sleepingTabs(6);
    for (const id of [1, 2, 3]) fake.discardErrors.set(id, "Cannot discard tab");
    await run("loadContent", { tabs: await refs(ids) });
    await settled(["paused"]);
    await until("three stuck", async () => (await snapshot()).loadRun!.failed === 3);
    for (const id of [1, 2, 3]) {
      fake.discardErrors.delete(id);
      await chrome.tabs.discard(id);
    }
    await run("loadControl", { action: "resume" });
    const snap = await settled();
    expect(snap.loadRun).toMatchObject({ status: "done", done: 3, failed: 3, awake: 0 });
    expect(ids.every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
  });

  test("Retry of a kept-awake tab doesn't wake another past the limit, nor wake it twice", async () => {
    await setup();
    fake.loadMs = 20;
    const ids = sleepingTabs(9);
    fake.discardErrors.set(3, "Cannot discard tab");
    await run("loadContent", { tabs: await refs(ids) });
    await settled(["paused"]);
    fake.discardErrors.delete(3);
    // Retry while new tabs are also asked for: the woken tab 3 must take its slot before any new wake.
    await run("loadControl", { action: "retry" });
    await run("loadContent", { tabs: await refs(ids) });
    const snap = await settled();
    expect(fake.maxAwakeByReload()).toBeLessThanOrEqual(N);
    expect(fake.count("reload", 3)).toBe(1);
    expect(snap.loadRun).toMatchObject({ awake: 0, failed: 0 });
    expect(ids.every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
  });

  test("a woken requeued tab takes a slot before an unwoken one is woken", async () => {
    await setup();
    fake.addTab(1, site(1));
    fake.addTab(2, site(2));
    fake.addSleeping(3, site(3));
    fake.addTab(4, site(4));
    const [x, y, a, b] = await refs([1, 2, 3, 4]);
    // A previous worker left: 1 and 2 mid-way (awake), 3 queued (asleep), then 4 queued but already woken.
    const item = (r: typeof x, state: string, woke: boolean) => ({ tabInstanceId: r!.tabInstanceId, windowId: 1, documentRevision: r!.documentRevision, docKey: documentKey(site(r!.tabId)), reason: null, state, woke });
    await kv.set({ loadRun: { status: "running", items: [item(x, "loading", true), item(y, "loading", true), item(a, "queued", false), item(b, "queued", true)] } });
    let awakeAtWake = 0;
    const reload = chrome.tabs.reload;
    (chrome.tabs as { reload: unknown }).reload = async (id: number) => {
      if (id === 3) awakeAtWake = [1, 2, 4].filter((t) => !fake.tabs.get(t)!.discarded).length + 1;
      return reload(id);
    };
    s.loader.stop();
    await boot();
    await settled();
    expect(awakeAtWake).toBeGreaterThan(0);
    expect(awakeAtWake).toBeLessThanOrEqual(N);
    expect([1, 2, 3, 4].every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
  });

  test("the concurrency chosen in Settings bounds the awake tabs and survives a worker restart", async () => {
    await setup();
    expect(await run("loadSettings", {})).toEqual({ concurrency: N });
    expect(await run("loadSettings", { concurrency: 1 })).toEqual({ concurrency: 1 });
    s.loader.stop();
    await boot();
    expect(await run("loadSettings", {})).toEqual({ concurrency: 1 });
    const ids = sleepingTabs(5);
    fake.loadMs = 10;
    await run("loadContent", { tabs: await refs(ids) });
    await settled();
    expect(fake.maxAwakeByReload()).toBe(1);
    expect(ids.every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
  });

  test("raising the concurrency during a run wakes more tabs at once", async () => {
    await setup();
    await run("loadSettings", { concurrency: 1 });
    const ids = sleepingTabs(8);
    fake.loadMs = 30;
    await run("loadContent", { tabs: await refs(ids) });
    await until("one awake", () => fake.count("reload") >= 1);
    await run("loadSettings", { concurrency: 4 });
    await settled();
    expect(fake.maxAwakeByReload()).toBe(4);
  });

  test("a second request, from another Linklog page too, joins the running run", async () => {
    await setup();
    const ids = sleepingTabs(6);
    fake.loadMs = 15;
    const r = await refs(ids);
    await run("loadContent", { tabs: r.slice(0, 4) });
    const other: Connection = { id: "c2", port: { postMessage() {} } as unknown as chrome.runtime.Port, tabId: LINKLOG_TAB, windowId: null, scope: "local:lib", last: null };
    s.hub.connections.set(other.id, other);
    const again = (await handle({ id: "x", command: "loadContent", args: { tabs: r } } as PageRequest, other, s)) as any;
    expect(again.loadRun.total).toBe(6);
    await settled();
    expect(fake.maxAwakeByReload()).toBeLessThanOrEqual(N);
    expect(ids.map((id) => fake.count("reload", id))).toEqual(ids.map(() => 1));
  });

  test("survives the worker restarting mid-run without waking a tab twice or leaking one", async () => {
    await setup();
    const ids = sleepingTabs(6);
    fake.loadMs = 40;
    await run("loadContent", { tabs: await refs(ids) });
    await until("three awake", () => fake.count("reload") === 3);
    s.loader.stop();
    await boot();
    const snap = await settled();
    expect(snap.loadRun).toMatchObject({ done: 6, awake: 0 });
    expect(ids.map((id) => fake.count("reload", id))).toEqual(ids.map(() => 1));
    expect(ids.every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
  });

  test("only tabs that need it are added; awake and unreadable ones are reported", async () => {
    await setup();
    sleepingTabs(1);
    fake.addTab(2, site(2));
    fake.addSleeping(3, "chrome://settings", "unloaded");
    const result = await run("loadContent", { tabs: await refs([1, 2, 3]) });
    expect(result.items.map((i: { ok: boolean }) => i.ok)).toEqual([true, false, false]);
    expect(result.items[1].error).toMatch(/already loaded/i);
    // The admitted tab finishes here, not in the next test's browser.
    await settled();
  });

  test("wakes and sleeps keep pin, pinned order, group and window", async () => {
    await setup();
    fake.addSleeping(1, site(1), "unloaded", { pinned: true, index: 1 });
    fake.addSleeping(2, site(2), "unloaded", { groupId: 7, index: 2 });
    await run("loadContent", { tabs: await refs([1, 2]) });
    await settled();
    const [one, two] = [fake.tabs.get(1)!, fake.tabs.get(2)!];
    expect([one.pinned, one.index, one.windowId, two.groupId, two.index]).toEqual([true, 1, 1, 7, 2]);
  });
});

describe("Put to sleep", () => {
  test("puts eligible tabs to sleep and reports each skipped one with its reason", async () => {
    await setup();
    fake.addTab(1, site(1));
    fake.addTab(2, site(2), 1, { audible: true });
    fake.addSleeping(3, site(3));
    fake.addTab(4, "chrome://settings");
    fake.addTab(5, site(5), 1, { pinned: true });
    const t6 = fake.addTab(6, site(6));
    const r = await refs([1, 2, 3, 4, 5, 6]);
    t6.active = true;
    const result = await run("sleepTabs", { tabs: r });
    const byId = Object.fromEntries(result.items.map((i: { tabId: number }) => [i.tabId, i]));
    expect([1, 5].map((id) => byId[id].ok)).toEqual([true, true]);
    expect(byId[2].error).toMatch(/audio/i);
    expect(byId[3].error).toMatch(/already asleep/i);
    expect(byId[4].error).toMatch(/Chrome/);
    expect(byId[6].error).toMatch(/active/i);
    expect([1, 5].every((id) => fake.tabs.get(id)!.discarded)).toBe(true);
    expect([2, 4, 6].map((id) => fake.count("discard", id))).toEqual([0, 0, 0]);
    expect(fake.tabs.get(5)!.pinned).toBe(true);
    expect((await tabOf(1)).content).toBe("sleeping");
  });

  test("a tab moved to another window after it was checked is not put to sleep", async () => {
    await setup();
    fake.addTab(1, site(1));
    const r = await refs([1]);
    // The tab moves between the selection check and the read right before the discard.
    const get = chrome.tabs.get;
    let reads = 0;
    (chrome.tabs as { get: unknown }).get = async (id: number) => {
      if (id === 1 && ++reads === 2) fake.tabs.get(1)!.windowId = 2;
      return get(id);
    };
    const result = await run("sleepTabs", { tabs: r });
    expect(result.items[0]).toMatchObject({ ok: false, error: "The tab is no longer in this window." });
    expect(fake.count("discard", 1)).toBe(0);
  });

  test("a tab Chrome refuses to put to sleep is reported, not hidden", async () => {
    await setup();
    fake.addTab(1, site(1));
    fake.discardErrors.set(1, "Cannot discard tab");
    const result = await run("sleepTabs", { tabs: await refs([1]) });
    expect(result.items[0]).toMatchObject({ ok: false });
    expect(result.items[0].error).toMatch(/Chrome kept this tab awake/);
  });
});

describe("Pinned tabs", () => {
  test("Move to group keeps pinned tabs in place, even one pinned after it was selected", async () => {
    await setup();
    fake.addTab(1, site(1), 1, { pinned: true });
    fake.addTab(2, site(2));
    fake.addTab(3, site(3));
    const r = await refs([1, 2, 3]);
    fake.tabs.get(3)!.pinned = true;
    const result = await run("moveToGroup", { tabs: r, target: { kind: "new", title: "Research", color: "blue", description: "" } });
    expect(result.items.map((i: { ok: boolean }) => i.ok)).toEqual([false, true, false]);
    expect(result.items[0].error).toMatch(/Pinned/);
    expect([1, 3].map((id) => fake.tabs.get(id)!.pinned)).toEqual([true, true]);
    expect(fake.count("group")).toBe(1);
  });

  test("Autogroup keeps a tab the user grouped after it was checked", async () => {
    await setup();
    fake.addTab(1, site(1));
    fake.addTab(2, site(2));
    const r = await refs([1, 2]);
    const get = chrome.tabs.get;
    let reads = 0;
    (chrome.tabs as { get: unknown }).get = async (id: number) => {
      if (id === 2 && ++reads === 2) fake.tabs.get(2)!.groupId = 42;
      return get(id);
    };
    const result = await run("moveToGroup", { tabs: r, onlyIfUngrouped: true, target: { kind: "new", title: "Research", color: "blue", description: "" } });
    expect(result.items.map((i: { ok: boolean }) => i.ok)).toEqual([true, false]);
    expect(fake.tabs.get(2)!.groupId).toBe(42);
  });

  test("a selection of only pinned tabs creates no group", async () => {
    await setup();
    fake.addTab(1, site(1), 1, { pinned: true });
    const result = await run("moveToGroup", { tabs: await refs([1]), target: { kind: "new", title: "X", color: "red", description: "" } });
    expect(result.groupId).toBeNull();
    expect(fake.count("group")).toBe(0);
  });
});

describe("Captured content budget", () => {
  test("the oldest captures are evicted first and their tabs no longer claim content", async () => {
    await setup();
    const ids = sleepingTabs(12);
    for (const id of ids) fake.pages.get(id)!.markdown = "x".repeat(150_000);
    await run("loadContent", { tabs: await refs(ids) });
    const snap = await settled();
    const kept = snap.tabs.filter((t) => ids.includes(t.tabId) && t.capturedAt).map((t) => t.tabId);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(12);
    // The first slots (tabs 1–3, in any order) captured first, so the oldest evicted is one of them; the last tab stays.
    expect([[1, 2, 3].some((id) => !kept.includes(id)), kept.includes(12)]).toEqual([true, true]);
    expect((await s.cache.usage()).captureBytes).toBeLessThanOrEqual(3 * 1024 * 1024);
  });
});
