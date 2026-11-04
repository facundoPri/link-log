/// <reference types="chrome" />
// FAC-163 native feasibility probe: isolated Chromium, extension built from this worktree,
// synthetic pages only. `bun planning/fac-163/probe.ts` → planning/fac-163/probe.json.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(import.meta.dir, "../..");
const OUT = resolve(ROOT, ".cache/fac163-probe");
const EXT = resolve(OUT, "extension");
const SITE_PORT = 3197;
const APP_PORT = 3196;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const EXE = process.env.CHROME_PATH ?? chromium.executablePath();
const HEADED = !!process.env.HEADED;
const BENCH_ONLY = !!process.env.PROBE_BENCH;
const RESULT_FILE = BENCH_ONLY ? "probe-bench.json" : "probe.json";
const results: Record<string, unknown> = { headed: HEADED };
const log = (k: string, v: unknown) => {
  results[k] = v;
  console.log(`${k}:`, JSON.stringify(v));
  void writeFile(resolve(import.meta.dir, RESULT_FILE), JSON.stringify(results, null, 2));
};
const step = (name: string) => console.log(`-- ${name}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
{
  const p = Bun.spawn(["bun", "apps/extension/scripts/build.ts"], {
    cwd: ROOT,
    env: { ...process.env, LINKLOG_EXTENSION_OUT: EXT, LINKLOG_EXTRA_HOSTS: `${SITE}/*` },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
}
results.build = (await Bun.$`git -C ${ROOT} rev-parse --short HEAD`.text()).trim() + (/\S/.test(await Bun.$`git -C ${ROOT} status --porcelain apps packages`.text()) ? "+dirty" : "");

Bun.serve({
  port: SITE_PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const delay = Number(url.searchParams.get("delay") ?? 0);
    if (delay) await Bun.sleep(delay);
    if (url.pathname === "/redirect") return Response.redirect(`${SITE}/login?next=${encodeURIComponent(url.pathname)}`, 302);
    const mb = Number(url.searchParams.get("mb") ?? 0);
    const heavy = mb ? `<script>window.__ballast=[];for(let i=0;i<${mb};i++)window.__ballast.push(new Array(131072).fill(i));</script>` : "";
    const title = url.pathname === "/login" ? "Sign in" : `Probe ${url.pathname}`;
    return new Response(
      `<!doctype html><html><head><title>${title}</title>${heavy}</head><body><main><h1>${title}</h1><p>${"Synthetic paragraph for the lifecycle probe. ".repeat(40)}</p></main></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
Bun.serve({
  port: APP_PORT,
  hostname: "127.0.0.1",
  fetch: () => new Response(`<!doctype html><html><head><meta name="linklog-app" content="1"><title>App</title></head><body>app</body></html>`, { headers: { "content-type": "text/html" } }),
});

const PROFILE = resolve(OUT, "profile");
const CDP_PORT = 9339;

/** Minimal CDP client. Attaches only to the targets it is told to: never to tabs being discarded. */
class Cdp {
  private ws!: WebSocket;
  private seq = 0;
  private pending = new Map<number, (m: any) => void>();
  async open(url: string) {
    this.ws = new WebSocket(url);
    await new Promise((r, j) => ((this.ws.onopen = r), (this.ws.onerror = j)));
    this.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== undefined) this.pending.get(m.id)?.(m), this.pending.delete(m.id);
    };
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => (this.pending.delete(id), reject(new Error(`${method}: no answer in 60s`))), 60000);
      this.pending.set(id, (m) => (clearTimeout(timer), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    });
  }
  close() {
    this.ws.close();
  }
}
type Sw = { cdp: Cdp; session: string };
let proc: ReturnType<typeof Bun.spawn> | null = null;
async function launch(extraArgs: string[] = []) {
  proc = Bun.spawn(
    [EXE, `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${CDP_PORT}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      "--no-first-run", "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", ...(HEADED ? [] : ["--headless=new"]), ...extraArgs, "about:blank"],
    { stdout: "ignore", stderr: Bun.file(resolve(OUT, "chrome.log")) },
  );
  let version: any;
  for (let i = 0; i < 100 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then((r) => r.json()).catch(() => null);
    if (!version) await Bun.sleep(100);
  }
  const cdp = new Cdp();
  await cdp.open(version.webSocketDebuggerUrl);
  let target: any;
  let sessionId = "";
  for (let i = 0; i < 100 && !target; i++) {
    for (const t of (await cdp.send("Target.getTargets")).targetInfos.filter((t: any) => t.type === "service_worker" && t.url.endsWith("/background.js"))) {
      const attached = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      const name = await cdp.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, attached.sessionId);
      if (name.result?.value === "Linklog") ((target = t), (sessionId = attached.sessionId));
      else await cdp.send("Target.detachFromTarget", { sessionId: attached.sessionId });
    }
    if (!target) await Bun.sleep(100);
  }
  return { cdp, sw: { cdp, session: sessionId } as Sw, version: version.Browser as string, extensionId: new URL(target.url).host };
}
async function shutdown(cdp: Cdp) {
  await cdp.send("Browser.close").catch(() => {});
  cdp.close();
  await proc?.exited;
}
async function inSw<R, A>(sw: Sw, fn: (a: A) => Promise<R>, arg: A): Promise<R> {
  const r = await sw.cdp.send("Runtime.evaluate", { expression: `(${fn.toString()})(${JSON.stringify(arg)})`, awaitPromise: true, returnByValue: true }, sw.session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value as R;
}
/** Attaches to one page target (never one that will be discarded while attached). */
async function onPage<R>(cdp: Cdp, urlPart: string, expression: string): Promise<R> {
  const target = (await cdp.send("Target.getTargets")).targetInfos.find((t: any) => t.type === "page" && t.url.includes(urlPart));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  try {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as R;
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
}
const tabsState = (sw: Sw, ids: number[]) =>
  inSw(sw, async (ids: number[]) => Promise.all(ids.map((id) => chrome.tabs.get(id).then(
    (t) => ({ id: t.id, status: t.status, discarded: t.discarded, frozen: (t as { frozen?: boolean }).frozen, active: t.active, url: t.url, pendingUrl: t.pendingUrl }),
    () => ({ id, gone: true }),
  ))), ids);

/** Snapshot through the real bridge from a page carrying the Linklog marker. */
async function bridgeSnapshot(cdp: Cdp, sw: Sw) {
  const has = (await cdp.send("Target.getTargets")).targetInfos.some((t: any) => t.type === "page" && t.url.startsWith(`http://127.0.0.1:${APP_PORT}`));
  if (!has) {
    await inSw(sw, async (url: string) => void (await chrome.tabs.create({ url, active: true })), `http://127.0.0.1:${APP_PORT}/`);
    await Bun.sleep(1500);
  }
  return onPage<any[]>(cdp, `127.0.0.1:${APP_PORT}`, `(async () => {
    const call = (command, args) => new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const on = (e) => { const r = e.data?.response; if (r?.id !== id) return; removeEventListener("message", on); r.ok ? resolve(r.result) : reject(new Error(r.error)); };
      addEventListener("message", on);
      postMessage({ channel: "linklog-bridge", from: "page", request: { id, command, args } }, location.origin);
    });
    for (let i = 0; i < 50 && !document.documentElement.dataset.linklogBridge; i++) await new Promise((r) => setTimeout(r, 100));
    await call("hello", { libraryScope: "local:probe" });
    const snap = await call("snapshot", {});
    return snap.tabs.map((t) => ({ tabId: t.tabId, status: t.status, discarded: t.discarded, frozen: t.frozen, content: t.content }));
  })()`);
}

async function chromeRssAll(): Promise<number> {
  // Renderer processes don't carry the profile path; count every process of this Chromium build.
  const app = EXE.split("/Contents/")[0]!;
  const out = await Bun.$`ps -axo rss=,command=`.text();
  return out.split("\n").filter((l) => l.includes(app)).reduce((n, l) => n + Number(l.trim().split(/\s+/)[0] || 0), 0) / 1024;
}

// ---------- 1. restored-but-never-loaded tabs ----------
let { cdp, sw, version, extensionId } = await launch();
log("chromium", version);
log("extensionId", extensionId);
if (!BENCH_ONLY) {
const restoreUrls = Array.from({ length: 30 }, (_, i) => `${SITE}/restore/${i}`);
await inSw(sw, async (urls: string[]) => {
  for (const url of urls) await chrome.tabs.create({ url, active: false });
}, restoreUrls);
await Bun.sleep(2000);
await shutdown(cdp);
// Restore the previous session the way Chrome does at startup.
({ cdp, sw } = await launch(["--restore-last-session"]));
await Bun.sleep(3000);
const restored = await inSw(sw, async (prefix: string) =>
  (await chrome.tabs.query({})).filter((t) => (t.url || t.pendingUrl || "").startsWith(prefix)).map((t) => ({ id: t.id, status: t.status, discarded: t.discarded, frozen: (t as { frozen?: boolean }).frozen, active: t.active })),
  `${SITE}/restore/`);
log("restoredTabs", restored);
const restoredSnap = await bridgeSnapshot(cdp, sw);
log("restoredBridgeSnapshot", restoredSnap.filter((t: any) => restored.some((r) => r.id === t.tabId)));
await Bun.sleep(20000);
log("restoredBridgeSnapshotAfter20s", (await bridgeSnapshot(cdp, sw)).filter((t: any) => restored.some((r) => r.id === t.tabId)));

// ---------- 2. discard, background wake, readiness, capture, re-discard ----------
const focusState = () => inSw(sw, async () => {
  const w = await chrome.windows.getLastFocused();
  const [active] = await chrome.tabs.query({ active: true, windowId: w.id });
  return { windowId: w.id, focused: w.focused, activeTabId: active?.id };
}, null);
const [probeTab] = await inSw(sw, async (url: string) => [(await chrome.tabs.create({ url, active: false })).id!], `${SITE}/wake/1`);
await Bun.sleep(1500);
let discardError: string | null = null;
const discarded = await inSw(sw, async (id: number) => {
  const t = await chrome.tabs.discard(id);
  return { returnedId: t?.id, status: t?.status, discarded: t?.discarded };
}, probeTab!).catch((e) => ((discardError = String(e)), null));
log("discard", { requested: probeTab, discarded, discardError });
log("discardedState", await tabsState(sw, [discarded?.returnedId ?? probeTab!]));
log("discardedBridgeSnapshot", (await bridgeSnapshot(cdp, sw)).filter((t: any) => t.tabId === (discarded?.returnedId ?? probeTab)));

async function wakeCaptureSleep(sw: Sw, id: number, timeoutMs = 30000) {
  return inSw(sw, async ([id, timeoutMs]: [number, number]) => {
    const t0 = performance.now();
    const before = await chrome.tabs.get(id);
    let activations = 0;
    const onAct = () => void activations++;
    chrome.tabs.onActivated.addListener(onAct);
    let replaced: number | null = null;
    const onRep = (added: number, removed: number) => void (removed === id && (replaced = added));
    chrome.tabs.onReplaced.addListener(onRep);
    await chrome.tabs.reload(id);
    let tab = await chrome.tabs.get(id);
    while (tab.status !== "complete" && performance.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
      tab = await chrome.tabs.get(replaced ?? id);
    }
    const tComplete = performance.now() - t0;
    let capture: { ok: boolean; chars?: number; url?: string; error?: string };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ["extract.js"] });
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: () => (globalThis as any).__linklogExtract?.(160000) });
      const r = inj?.result as any;
      capture = { ok: r?.ok === true, chars: r?.markdown?.length, url: r?.url };
    } catch (e) {
      capture = { ok: false, error: String(e) };
    }
    const tCaptured = performance.now() - t0;
    const slept = await chrome.tabs.discard(tab.id!).catch((e) => ({ error: String(e) }) as any);
    const tSlept = performance.now() - t0;
    chrome.tabs.onActivated.removeListener(onAct);
    chrome.tabs.onReplaced.removeListener(onRep);
    const after = await chrome.tabs.get(slept?.id ?? tab.id!).catch(() => null);
    return {
      before: { status: before.status, discarded: before.discarded, frozen: (before as any).frozen, active: before.active },
      replaced,
      ms: { complete: Math.round(tComplete), captured: Math.round(tCaptured), slept: Math.round(tSlept) },
      capture,
      sleptId: slept?.id ?? null,
      sleepError: slept?.error ?? null,
      after: after && { id: after.id, status: after.status, discarded: after.discarded, active: after.active, pinned: after.pinned, index: after.index, groupId: after.groupId, windowId: after.windowId },
      activations,
    };
  }, [id, timeoutMs] as [number, number]);
}
const focusBefore = await focusState();
log("wakeDiscarded", await wakeCaptureSleep(sw, discarded?.returnedId ?? probeTab!));
log("focusUnchanged", { before: focusBefore, after: await focusState() });
const neverLoaded = restored.find((t) => t.status === "unloaded" && !t.discarded);
if (neverLoaded) log("wakeRestoredUnloaded", await wakeCaptureSleep(sw, neverLoaded.id!));

// Pinned, grouped tab keeps pin/order/group/window through wake and sleep.
const pinnedSetup = await inSw(sw, async (url: string) => {
  const t = await chrome.tabs.create({ url, active: false, pinned: true });
  const u = await chrome.tabs.create({ url: url + "?g", active: false });
  const g = await chrome.tabs.group({ tabIds: [u.id!] });
  return { pinned: t.id!, grouped: u.id!, group: g };
}, `${SITE}/pinned/1`);
await Bun.sleep(1500);
const pinBefore = await inSw(sw, async (ids: number[]) => Promise.all(ids.map(async (id) => { const t = await chrome.tabs.get(id); return { id, pinned: t.pinned, index: t.index, groupId: t.groupId, windowId: t.windowId }; })), [pinnedSetup.pinned, pinnedSetup.grouped]);
await inSw(sw, async (ids: number[]) => void (await Promise.all(ids.map((id) => chrome.tabs.discard(id)))), [pinnedSetup.pinned, pinnedSetup.grouped]);
const pinnedWake = await wakeCaptureSleep(sw, pinnedSetup.pinned);
const groupedWake = await wakeCaptureSleep(sw, pinnedSetup.grouped);
log("pinnedAndGroupedPreserved", { before: pinBefore, pinnedAfter: pinnedWake.after, groupedAfter: groupedWake.after });

// Login redirect: the woken tab lands somewhere else.
const [redir] = await inSw(sw, async (url: string) => [(await chrome.tabs.create({ url, active: false })).id!], `${SITE}/p/redir-target`);
await Bun.sleep(1000);
await inSw(sw, async (id: number) => void (await chrome.tabs.discard(id)), redir!);
// Simulate the site now redirecting to login by changing the URL Chrome will reload.
await inSw(sw, async ([id, url]: [number, string]) => void (await chrome.tabs.update(id, { url })), [redir!, `${SITE}/redirect`] as [number, string]);
await Bun.sleep(1500);
log("loginRedirect", await tabsState(sw, [redir!]));

// Slow page: what the tab looks like while the bound runs out.
const [slow] = await inSw(sw, async (url: string) => [(await chrome.tabs.create({ url, active: false })).id!], `${SITE}/slow?delay=8000`);
await Bun.sleep(1000);
log("slowWhileLoading", { tab: await tabsState(sw, [slow!]), snap: (await bridgeSnapshot(cdp, sw)).filter((t: any) => t.tabId === slow) });

// ---------- 3. frozen ----------
const [frozenId] = await inSw(sw, async (url: string) => [(await chrome.tabs.create({ url, active: false })).id!], `${SITE}/frozen/1`);
await Bun.sleep(1500);
let frozenNote = "frozen through CDP Page.setWebLifecycleState, then detached";
{
  const target = (await cdp.send("Target.getTargets")).targetInfos.find((t: any) => t.type === "page" && t.url.includes("/frozen/1"));
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  await cdp.send("Page.setWebLifecycleState", { state: "frozen" }, sessionId).catch((e) => (frozenNote = String(e)));
  await cdp.send("Target.detachFromTarget", { sessionId });
}
await Bun.sleep(500);
log("frozenState", { note: frozenNote, tab: await tabsState(sw, [frozenId!]), snap: (await bridgeSnapshot(cdp, sw)).filter((t: any) => t.tabId === frozenId) });
const frozenScript = await inSw(sw, async (id: number) =>
  Promise.race([
    chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.title }).then((r) => ({ ok: true, title: r[0]?.result })),
    new Promise((r) => setTimeout(() => r({ ok: false, error: "executeScript did not return in 3s" }), 3000)),
  ]).catch((e) => ({ ok: false, error: String(e) })), frozenId!);
log("frozenExecuteScript", frozenScript);
const frozenDiscard = await inSw(sw, async (id: number) => {
  const t = await chrome.tabs.discard(id).catch((e) => ({ error: String(e) }) as any);
  const after = await chrome.tabs.get(t?.id ?? id).catch(() => null);
  return { result: t?.error ?? { id: t?.id }, after: after && { status: after.status, discarded: after.discarded, frozen: (after as any).frozen } };
}, frozenId!);
log("frozenDiscard", frozenDiscard);
log("frozenWakeAfterDiscard", await wakeCaptureSleep(sw, (frozenDiscard.result as any)?.id ?? frozenId!));

}

// ---------- 4. throughput and memory by window size ----------
async function windowRun(n: number, count: number, mb: number) {
  const ids = await inSw(sw, async ([count, base]: [number, string]) => {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push((await chrome.tabs.create({ url: `${base}&i=${i}`, active: false })).id!);
    return ids;
  }, [count, `${SITE}/bench/${n}?mb=${mb}`] as [number, string]);
  await Bun.sleep(3000);
  await inSw(sw, async (ids: number[]) => void (await Promise.all(ids.map((id) => chrome.tabs.discard(id).catch(() => null)))), ids);
  await Bun.sleep(1500);
  const baseline = await chromeRssAll();
  let peak = baseline;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peak = Math.max(peak, await chromeRssAll());
      await Bun.sleep(150);
    }
  })();
  const t0 = performance.now();
  const per = await inSw(sw, async ([ids, n]: [number[], number]) => {
    const times: number[] = [];
    let next = 0;
    let awake = 0;
    let maxAwake = 0;
    const slot = async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        const s = performance.now();
        awake++;
        maxAwake = Math.max(maxAwake, awake);
        await chrome.tabs.reload(id);
        let tab = await chrome.tabs.get(id);
        while (tab.status !== "complete" && performance.now() - s < 30000) {
          await new Promise((r) => setTimeout(r, 50));
          tab = await chrome.tabs.get(id);
        }
        await chrome.scripting.executeScript({ target: { tabId: id }, files: ["extract.js"] });
        await chrome.scripting.executeScript({ target: { tabId: id }, func: () => (globalThis as any).__linklogExtract?.(160000)?.ok });
        await chrome.tabs.discard(id);
        awake--;
        times.push(performance.now() - s);
      }
    };
    await Promise.all(Array.from({ length: n }, slot));
    times.sort((a, b) => a - b);
    return { maxAwake, p50: Math.round(times[Math.floor(times.length / 2)]!), p95: Math.round(times[Math.floor(times.length * 0.95)]!), max: Math.round(times.at(-1)!) };
  }, [ids, n] as [number[], number]);
  const total = performance.now() - t0;
  sampling = false;
  await sampler;
  await inSw(sw, async (ids: number[]) => void (await chrome.tabs.remove(ids)), ids);
  return { n, count, pageMb: mb, totalMs: Math.round(total), tabsPerSec: +(count / (total / 1000)).toFixed(2), ...per, rssBaselineMb: Math.round(baseline), rssPeakMb: Math.round(peak), rssDeltaMb: Math.round(peak - baseline) };
}
const bench = [];
for (const mb of [0, 32])
  for (const n of [1, 3, 5, 8]) {
    console.log(`-- bench n=${n} mb=${mb} at ${new Date().toISOString()}`);
    bench.push(await windowRun(n, 18, mb));
    log("bench", bench);
  }

await shutdown(cdp);
await writeFile(resolve(import.meta.dir, RESULT_FILE), JSON.stringify(results, null, 2));
console.log(`wrote planning/fac-163/${RESULT_FILE}`);
process.exit(0);
