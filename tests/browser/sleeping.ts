/// <reference types="chrome" />
// FAC-163 native checks: Sleeping tabs, Load content, Put to sleep and pinned protection, in
// real Chromium with the worktree's extension build, driven over raw CDP (see cdp.ts).
import { resolve } from "node:path";
import { launchRaw, type RawBrowser } from "./cdp";
import { api, EXTENSION, OUT, sessionCookie, SITE, siteHits, UI, waitFor } from "./env";

type Ctx = {
  check: (name: string, fn: () => Promise<string | void>) => Promise<void>;
  assert: (cond: unknown, message: string) => asserts cond;
  section: (name: string) => void;
  evidence: string;
  meta: Record<string, unknown>;
};

const LINKLOG = "p=S";
/** `call(command, args)` over the page's real bridge, as the Linklog app sends it. */
const BRIDGE_CALL = `const call = (command, args) => new Promise((resolve, reject) => {
  const id = crypto.randomUUID();
  const on = (e) => { const r = e.data?.response; if (r?.id !== id) return; removeEventListener("message", on); r.ok ? resolve(r.result) : reject(new Error(r.error)); };
  addEventListener("message", on);
  postMessage({ channel: "linklog-bridge", from: "page", request: { id, command, args } }, location.origin);
});`;
const QUEUE = 450;

/** Resident memory of this browser's process tree, in MB (shared pages count once per process). */
async function chromiumRss(root: number) {
  const procs = (await Bun.$`ps -axo pid=,ppid=,rss=`.text())
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((r) => r.length === 3) as [number, number, number][];
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of procs) if (tree.has(ppid) && !tree.has(pid)) (tree.add(pid), (grew = true));
  }
  return Math.round(procs.filter(([pid]) => tree.has(pid)).reduce((n, [, , rss]) => n + rss, 0) / 1024);
}

export async function sleepingChecks(ctx: Ctx) {
  const { check, section, evidence, meta } = ctx;
  const assert: Ctx["assert"] = ctx.assert;
  const profile = resolve(OUT, "profile-sleeping");
  const cookie = sessionCookie();
  const launch = (fresh: boolean, args: string[] = []) =>
    launchRaw({ profile, extension: EXTENSION, port: 9351, fresh, args, cookie: cookie && { ...cookie, domain: "127.0.0.1" } });
  let b: RawBrowser = await launch(true);

  const dom = <R = unknown>(js: string) => b.page<R>(LINKLOG, `(async () => { ${js} })()`);
  const click = (finder: string) => dom(`const el = ${finder}; if (!el) throw new Error("not found: " + ${JSON.stringify(finder)}); el.click(); return true;`);
  const button = (text: string, scope = "document") =>
    `[...${scope}.querySelectorAll("button")].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && !e.disabled)`;
  const rows = () =>
    dom<{ tabId: number; content: string | null; load: string | null; pinned: boolean }[]>(
      `return [...document.querySelectorAll("[data-tab-id]")].map((r) => ({ tabId: Number(r.dataset.tabId), content: r.querySelector("[data-content]")?.dataset.content ?? null, load: r.querySelector("[data-load-state]")?.dataset.loadState ?? null, pinned: !!r.querySelector('[aria-label="Pinned tab"]') }));`,
    );
  const shot = (name: string) => b.screenshot(LINKLOG, resolve(evidence, `${name}.png`));
  /** On a timeout: a screenshot and what the page says, so the failure explains itself. */
  const explain = (name: string) => async (error: Error): Promise<never> => {
    await shot(`fail-${name}`).catch(() => {});
    const text = await dom<string>(`return document.querySelector("main")?.innerText.slice(0, 600) ?? document.body.innerText.slice(0, 600)`).catch(() => "");
    throw new Error(`${error.message}; page: ${text.replace(/\s+/g, " ")}`);
  };
  const run = () => b.sw(async () => ((await chrome.storage.session.get("loadRun")).loadRun ?? null) as any, null);
  const tabsOf = (prefix: string) =>
    b.sw(async (p: string) => (await chrome.tabs.query({})).filter((t) => (t.url || t.pendingUrl || "").startsWith(p)).map((t) => ({ id: t.id!, status: t.status, discarded: t.discarded, frozen: (t as { frozen?: boolean }).frozen, active: t.active, pinned: t.pinned, index: t.index, groupId: t.groupId, windowId: t.windowId })), prefix);
  const hits = (prefix: string) => [...siteHits].filter(([p]) => p.startsWith(prefix));
  const resetHits = (prefix: string) => {
    for (const [p] of hits(prefix)) siteHits.delete(p);
  };
  async function openBrowserView(windowId: number) {
    await b.sw(async ([url, w]: [string, number]) => void (await chrome.tabs.create({ url, windowId: w, active: true })), [`${UI}/?${LINKLOG}`, windowId] as [string, number]);
    await waitFor("Linklog page", async () => (await b.targets()).some((t) => t.type === "page" && t.url.includes(LINKLOG)), 15000);
    await waitFor("sidebar", () => dom<boolean>(`return !!document.querySelector("aside")`), 20000);
    await showBrowser();
  }
  async function showBrowser() {
    await waitFor("sidebar", () => dom<boolean>(`return !!document.querySelector("aside")`), 20000);
    await click(`[...document.querySelectorAll("aside button")].find((e) => /^Browser/.test(e.textContent.trim()))`);
    await waitFor("tab rows", async () => (await rows()).length > 0, 30000);
  }
  /** The run that holds a tab whose URL contains `urlPart`, once nothing in it is in progress. */
  const awaitRun = (what: string, urlPart: string, timeout = 120_000) =>
    waitFor(what, async () => {
      const r = await run();
      if (!r?.items.some((i: { docKey: string }) => i.docKey.includes(urlPart))) return null;
      return (r.status === "done" || r.status === "paused") && !r.items.some((i: { state: string }) => ["queued", "loading", "capturing", "putting-to-sleep"].includes(i.state)) ? r : null;
    }, timeout);

  try {
    section("Sleeping tabs (native)");
    meta.sleepingBrowser = b.version;
    meta.sleepingExtension = (await b.sw(async () => ({ id: chrome.runtime.id, version: chrome.runtime.getManifest().version }), null));

    // Chrome restores tabs at startup and loads only a few: the rest are "unloaded", not discarded.
    const restoreUrls = Array.from({ length: 30 }, (_, i) => `${SITE}/restore/${i}`);
    await b.sw(async (urls: string[]) => {
      for (const url of urls) await chrome.tabs.create({ url, active: false });
    }, restoreUrls);
    await Bun.sleep(2500);
    await b.close();
    b = await launch(false, ["--restore-last-session"]);
    await Bun.sleep(3000);
    const restored = await tabsOf(`${SITE}/restore/`);
    const W = restored[0]!.windowId;
    const neverLoaded = restored.filter((t) => t.status === "unloaded" && !t.discarded);
    resetHits("/restore/");
    await openBrowserView(W);

    await check("restored-but-never-loaded tabs show as Sleeping, never as an endless Loading", async () => {
      assert(neverLoaded.length > 0, `Chrome loaded all ${restored.length} restored tabs; no never-loaded state to check`);
      await Bun.sleep(20_000);
      const shown = await rows();
      const ids = new Set(neverLoaded.map((t) => t.id));
      const theirs = shown.filter((r) => ids.has(r.tabId));
      assert(theirs.length === neverLoaded.length && theirs.every((r) => r.content === "sleeping"), `rows: ${JSON.stringify(theirs.slice(0, 5))}`);
      assert(!shown.some((r) => r.content === "loading"), "a row still shows Loading after 20 s");
      const banner = await dom<number>(`return Number(document.querySelector("[data-sleeping-count]")?.dataset.sleepingCount ?? 0)`);
      assert(banner === neverLoaded.length, `banner counts ${banner}, expected ${neverLoaded.length}`);
      await shot("20-sleeping-banner");
      return `${neverLoaded.length} of ${restored.length} restored tabs have Chrome status "unloaded" with discarded false; all ${theirs.length} rows say Sleeping, 0 say Loading after 20 s; banner counts ${banner}`;
    });

    await check("the Sleeping filter lists only sleeping tabs and shows their count", async () => {
      await click(`document.querySelector('button[aria-label^="Show only sleeping tabs"]')`);
      await Bun.sleep(400);
      const shown = await rows();
      const label = await dom<string>(`return document.querySelector('button[aria-label^="Show only sleeping tabs"]').getAttribute("aria-label")`);
      assert(shown.length === neverLoaded.length && shown.every((r) => r.content === "sleeping"), `filtered rows: ${shown.length}`);
      await shot("21-sleeping-filter");
      await click(`document.querySelector('button[aria-label^="Show only sleeping tabs"]')`);
      return `${shown.length} rows, all Sleeping; ${label}`;
    });

    await check("entering Browser, filtering and selecting never wake a tab", async () => {
      await click(`document.querySelector('[data-tab-id="${neverLoaded[0]!.id}"] button[role=checkbox]')`);
      await click(`document.querySelector('[data-tab-id="${neverLoaded[0]!.id}"] button[role=checkbox]')`);
      await Bun.sleep(1000);
      const woken = hits("/restore/");
      assert(!woken.length, `pages loaded: ${JSON.stringify(woken)}`);
      return "0 page loads of the restored tabs";
    });

    await check("banner Load content wakes in the background, captures, and puts every tab back to sleep", async () => {
      const before = await b.sw(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? 0, null);
      await b.sw(async (prefix: string) => {
        const g = globalThis as { __maxAwake?: number; __sampler?: ReturnType<typeof setInterval> };
        g.__maxAwake = 0;
        clearInterval(g.__sampler);
        g.__sampler = setInterval(async () => {
          const awake = (await chrome.tabs.query({})).filter((t) => (t.url || "").startsWith(prefix) && !t.discarded && t.status !== "unloaded");
          g.__maxAwake = Math.max(g.__maxAwake!, awake.filter((t) => t.status === "loading").length);
        }, 20);
      }, `${SITE}/restore/`);
      await click(button("Load content", `document.querySelector("[data-sleeping-count]").closest("div").parentElement`));
      await waitFor("progress banner", () => dom<boolean>(`return !!document.querySelector("[data-load-run]")`), 10000);
      await shot("22-load-progress");
      const r = await awaitRun("run done", "/restore/");
      const after = await b.sw(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? 0, null);
      const native = await tabsOf(`${SITE}/restore/`);
      const ids = new Set(neverLoaded.map((t) => t.id));
      const mine = native.filter((t) => ids.has(t.id));
      const loads = hits("/restore/");
      const maxLoading = await b.sw(async () => (globalThis as { __maxAwake?: number }).__maxAwake ?? -1, null);
      assert(after === before, `active tab changed from ${before} to ${after}`);
      assert(mine.every((t) => t.discarded), `awake after the run: ${mine.filter((t) => !t.discarded).map((t) => t.id)}`);
      assert(loads.length === neverLoaded.length && loads.every(([, n]) => n === 1), `page loads: ${JSON.stringify(loads)}`);
      assert(maxLoading <= 3, `${maxLoading} loading at once`);
      const done = r.items.filter((i: { state: string }) => i.state === "done").length;
      await Bun.sleep(800);
      const captured = await dom<number>(`return document.querySelectorAll('[data-content="sleeping"]').length`);
      await shot("23-load-done");
      return `${done}/${r.items.length} done; ${loads.length} pages loaded once each; at most ${maxLoading} loading at once; active tab ${after} unchanged; all ${mine.length} discarded again (${captured} Sleeping rows with captured content)`;
    });

    await check("a Sleeping tab with captured content shows it in the inspector", async () => {
      const id = neverLoaded[0]!.id;
      await click(`document.querySelector('[data-tab-id="${id}"]')`);
      await waitFor("inspector content", () => dom<boolean>(`return /content captured/.test(document.querySelector("[data-browser-inspector]")?.innerText ?? "")`), 15000);
      await shot("24-inspector-captured");
      const text = await dom<string>(`return document.querySelector("[data-browser-inspector]").innerText`);
      assert(/Synthetic|Fixture/.test(text), "captured page text not shown");
      assert(hits("/restore/").every(([, n]) => n === 1), "opening the inspector woke the tab");
      return "inspector: “The tab is sleeping. This is the content captured …”, page text shown, no wake";
    });

    await check("a frozen tab is loaded, put to sleep instead, and the UI says so", async () => {
      const loaded = (await tabsOf(`${SITE}/restore/`)).find((t) => t.status === "complete" && !t.discarded && !t.frozen)!;
      assert(loaded, "no loaded restored tab left to freeze");
      const url = (await b.sw(async (id: number) => (await chrome.tabs.get(id)).url!, loaded.id));
      const page = (await b.targets()).find((t) => t.type === "page" && t.url === url)!;
      const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
      await b.cdp.send("Page.setWebLifecycleState", { state: "frozen" }, sessionId);
      await b.cdp.send("Target.detachFromTarget", { sessionId });
      await waitFor("frozen row", async () => (await rows()).find((r) => r.tabId === loaded.id)?.content === "sleeping", 10000);
      await click(`document.querySelector('[data-tab-id="${loaded.id}"]')`);
      await waitFor("inspector Load content", () => dom<boolean>(`return !!${button("Load content", `document.querySelector("[data-browser-inspector]")`)}`), 10000);
      await click(button("Load content", `document.querySelector("[data-browser-inspector]")`));
      await awaitRun("frozen run done", new URL(url).pathname, 60000);
      const [after] = (await tabsOf(url)).filter((t) => t.id === loaded.id);
      const r = await run();
      const item = r.items.find((i: { docKey: string }) => i.docKey.endsWith(new URL(url).pathname));
      assert(after?.discarded && !after.frozen, `frozen tab ended ${JSON.stringify(after)}`);
      assert(item.state === "done" && /frozen/.test(item.note ?? ""), JSON.stringify(item));
      await Bun.sleep(500);
      await shot("25-frozen-now-asleep");
      return `frozen: true → discarded: true, frozen: false; note “${item.note}”`;
    });

    await check("Put to sleep from the selection sleeps eligible tabs and reports the rest", async () => {
      const ids = await b.sw(async ([w, base]: [number, string]) => {
        const out: number[] = [];
        for (const p of ["a", "b"]) out.push((await chrome.tabs.create({ url: `${base}/awake/${p}`, windowId: w, active: false })).id!);
        return out;
      }, [W, SITE] as [number, string]);
      await waitFor("awake rows", async () => (await rows()).filter((r) => ids.includes(r.tabId) && r.content === null).length === 2, 20000);
      const asleep = neverLoaded[1]!.id;
      for (const id of [...ids, asleep]) await click(`document.querySelector('[data-tab-id="${id}"] button[role=checkbox]')`);
      await Bun.sleep(300);
      await shot("26-selection-bar");
      const order = await dom<string[]>(`return [...document.querySelector('[aria-label="Selected tab actions"]').querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean)`);
      await click(button("Put to sleep", `document.querySelector('[aria-label="Selected tab actions"]')`));
      await waitFor("slept", async () => (await tabsOf(`${SITE}/awake/`)).every((t) => t.discarded), 10000);
      const toast = await dom<string>(`return document.querySelector("[data-sonner-toast]")?.innerText ?? ""`);
      await shot("27-put-to-sleep");
      assert(/Put to sleep 2 of 3/.test(toast) && /Already asleep/.test(toast), `toast: ${toast}`);
      await click(`document.querySelector('[aria-label="Clear selection"]')`);
      return `bar: ${order.join(" · ")}; toast “${toast.replace(/\n/g, " ")}”`;
    });

    await check("pinned tabs show a marker and keep pin, order, group and window through Put to sleep and Load content", async () => {
      const pinned = await b.sw(async ([w, base]: [number, string]) => {
        const out: number[] = [];
        for (const p of ["p1", "p2"]) out.push((await chrome.tabs.create({ url: `${base}/pinned/${p}`, windowId: w, active: false, pinned: true })).id!);
        return out;
      }, [W, SITE] as [number, string]);
      await waitFor("pinned rows", async () => (await rows()).filter((r) => pinned.includes(r.tabId) && r.pinned && r.content === null).length === 2, 20000);
      const before = (await tabsOf(`${SITE}/pinned/`)).map((t) => [t.id, t.pinned, t.index, t.groupId, t.windowId]);
      for (const id of pinned) await click(`document.querySelector('[data-tab-id="${id}"] button[role=checkbox]')`);
      await click(button("Put to sleep", `document.querySelector('[aria-label="Selected tab actions"]')`));
      await waitFor("pinned asleep", async () => (await tabsOf(`${SITE}/pinned/`)).every((t) => t.discarded), 10000);
      await click(button("Load content", `document.querySelector('[aria-label="Selected tab actions"]')`));
      await awaitRun("pinned run", "/pinned/", 60000);
      const after = (await tabsOf(`${SITE}/pinned/`)).map((t) => [t.id, t.pinned, t.index, t.groupId, t.windowId]);
      await click(`document.querySelector('[aria-label="Clear selection"]')`);
      await shot("28-pinned-marker");
      assert(JSON.stringify(before) === JSON.stringify(after), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
      return `[id, pinned, index, group, window] unchanged: ${JSON.stringify(after)}`;
    });

    await check("Move to group keeps pinned tabs in place, including one pinned after it was selected", async () => {
      const [loose, late] = (await b.sw(async ([w, base]: [number, string]) => {
        const out: number[] = [];
        for (const p of ["g1", "g2"]) out.push((await chrome.tabs.create({ url: `${base}/group/${p}`, windowId: w, active: false })).id!);
        return out;
      }, [W, SITE] as [number, string])) as [number, number];
      await waitFor("group rows", async () => (await rows()).filter((r) => [loose, late].includes(r.tabId)).length === 2, 20000);
      const pinnedId = (await tabsOf(`${SITE}/pinned/`))[0]!.id;
      // The page's view of the tabs, then a pin it hasn't seen, then the command through the real bridge.
      await dom(`${BRIDGE_CALL}
        const snap = await call("snapshot", {});
        window.__pick = snap.tabs.filter((t) => [${loose}, ${late}, ${pinnedId}].includes(t.tabId)).map((t) => ({ tabId: t.tabId, tabInstanceId: t.tabInstanceId }));`);
      await b.sw(async (id: number) => void (await chrome.tabs.update(id, { pinned: true })), late);
      const moved = await dom<{ items: { tabId: number; ok: boolean; error?: string }[] }>(`${BRIDGE_CALL}
        return call("moveToGroup", { tabs: window.__pick, target: { kind: "new", title: "Native", color: "blue", description: "" } });`);
      const native = await b.sw(async (ids: number[]) => Promise.all(ids.map(async (id) => { const t = await chrome.tabs.get(id); return [id, t.pinned, t.groupId]; })), [loose, late, pinnedId]);
      const byId = Object.fromEntries(moved.items.map((i) => [i.tabId, i]));
      assert(byId[loose]?.ok && byId[late]?.ok === false && byId[pinnedId]?.ok === false, JSON.stringify(moved.items));
      assert(native[1]![1] === true && native[2]![1] === true && (native[0]![2] as number) >= 0, JSON.stringify(native));
      return `grouped ${loose}; kept ${late} (pinned after selection) and ${pinnedId}: “${byId[late]?.error}”; native [id, pinned, group] ${JSON.stringify(native)}`;
    });

    await check("a lens over sleeping tabs splits waiting from sleeping and finishes after Load content", async () => {
      const lens = (await api<{ lenses: { id: string; name: string }[] }>("/lenses", "POST", { scope: "browser", threshold: 0.8, name: "Sleepy", type: "noul", question: "Is this page about tabs?" })).lenses.find((l) => l.name === "Sleepy")!;
      const qIds = await b.sw(async ([w, base]: [number, string]) => {
        const out: number[] = [];
        for (let i = 0; i < 6; i++) out.push((await chrome.tabs.create({ url: `${base}/lens/${i}`, windowId: w, active: false })).id!);
        return out;
      }, [W, SITE] as [number, string]);
      await Bun.sleep(2500);
      await b.sw(async (ids: number[]) => void (await Promise.all(ids.map((id) => chrome.tabs.discard(id)))), qIds);
      // The page read the library before the lens existed.
      await dom(`location.reload()`).catch(() => {});
      await Bun.sleep(1500);
      await showBrowser();
      await waitFor("lens in sidebar", () => dom<boolean>(`return !![...document.querySelectorAll("aside button[aria-pressed]")].find((e) => e.textContent.includes("Sleepy"))`), 20000);
      await click(`[...document.querySelectorAll("aside button[aria-pressed]")].find((e) => e.textContent.includes("Sleepy"))`);
      const bar = `document.querySelector('[data-lens-filter="${lens.id}"]')`;
      await waitFor("sleeping count in lens bar", () => dom<boolean>(`return /\\d+ sleeping/.test(${bar}?.innerText ?? "")`), 30000).catch(explain("lens-bar"));
      const split = await dom<string>(`return ${bar}.innerText`);
      await shot("29-lens-bar-sleeping");
      await click(button("Load content", bar));
      await awaitRun("lens run", "/lens/", 60000);
      await waitFor("lens finished on loaded tabs", () => dom<boolean>(`return !/sleeping/.test(${bar}?.innerText ?? "sleeping")`), 60000);
      const done = await dom<string>(`return ${bar}.innerText`);
      await shot("30-lens-bar-done");
      // An active lens reads every awake tab; the queue check needs tabs nothing has read.
      await click(`[...document.querySelectorAll("aside button[aria-pressed=true]")].find((e) => e.textContent.includes("Sleepy"))`);
      const line = (t: string) => t.replace(/\s+/g, " ").trim();
      return `before: “${line(split)}”; after Load content: “${line(done)}”`;
    });

    await check(`a ${QUEUE}-tab queue keeps at most 3 awake, wakes each tab once across a worker restart, and leaks none`, async () => {
      const ids = await b.sw(async ([w, base, n]: [number, string, number]) => {
        const out: number[] = [];
        for (let i = 0; i < n; i++) out.push((await chrome.tabs.create({ url: `${base}/q/${i}`, windowId: w, active: false })).id!);
        return out;
      }, [W, SITE, QUEUE] as [number, string, number]);
      await waitFor("queue tabs loaded", async () => (await tabsOf(`${SITE}/q/`)).every((t) => t.status === "complete"), 120_000);
      await b.sw(async (list: number[]) => {
        for (let i = 0; i < list.length; i += 50) await Promise.all(list.slice(i, i + 50).map((id) => chrome.tabs.discard(id).catch(() => null)));
      }, ids);
      await waitFor("all discarded", async () => (await tabsOf(`${SITE}/q/`)).every((t) => t.discarded), 60_000);
      resetHits("/q/");
      await waitFor("banner counts the queue", () => dom<boolean>(`return Number(document.querySelector("[data-sleeping-count]")?.dataset.sleepingCount ?? 0) >= ${QUEUE}`), 60_000).catch(explain("queue-banner"));
      const rssBefore = await chromiumRss(b.proc.pid);
      let rssPeak = rssBefore;
      let maxAwake = 0;
      let sampling = true;
      const sampler = (async () => {
        while (sampling) {
          const now = await tabsOf(`${SITE}/q/`).catch(() => null);
          if (now) maxAwake = Math.max(maxAwake, now.filter((t) => !t.discarded).length);
          rssPeak = Math.max(rssPeak, await chromiumRss(b.proc.pid));
          await Bun.sleep(100);
        }
      })();
      const t0 = performance.now();
      await click(button("Load content", `document.querySelector("[data-sleeping-count]").closest("div").parentElement`));
      await waitFor("100 done", async () => ((await run())?.items ?? []).filter((i: { state: string }) => i.state === "done").length >= 100, 300_000);
      await b.stopWorker();
      const restartedAt = (await run().catch(() => null))?.items.filter((i: { state: string }) => i.state === "done").length ?? "?";
      const r = await awaitRun("queue done", "/q/", 900_000);
      const ms = performance.now() - t0;
      sampling = false;
      await sampler;
      const native = await tabsOf(`${SITE}/q/`);
      const loads = hits("/q/");
      const twice = loads.filter(([, n]) => n > 1);
      const qItems = r.items.filter((i: { docKey: string }) => i.docKey.includes("/q/"));
      const done = qItems.filter((i: { state: string }) => i.state === "done").length;
      meta.queue = { tabs: QUEUE, ms: Math.round(ms), tabsPerSec: +(QUEUE / (ms / 1000)).toFixed(2), maxAwake, rssBeforeMb: rssBefore, rssPeakMb: rssPeak, restartedAfterDone: restartedAt };
      assert(maxAwake <= 3, `${maxAwake} awake at once`);
      assert(!twice.length, `woken more than once: ${JSON.stringify(twice.slice(0, 5))}`);
      assert(loads.length === QUEUE, `${loads.length} of ${QUEUE} pages loaded`);
      assert(native.every((t) => t.discarded), `${native.filter((t) => !t.discarded).length} left awake`);
      assert(done === QUEUE, `${done} of ${QUEUE} done (${JSON.stringify(qItems.filter((i: { state: string }) => i.state !== "done").slice(0, 3))})`);
      await shot("31-queue-done");
      return `${done}/${QUEUE} done in ${Math.round(ms / 1000)} s (${meta.queue && (meta.queue as { tabsPerSec: number }).tabsPerSec} tabs/s); max ${maxAwake} awake (sampled every 100 ms); worker stopped after ${restartedAt} done and resumed; each page loaded exactly once; 0 left awake; browser process tree RSS ${rssBefore} → peak ${rssPeak} MB (sampled every 100 ms)`;
    });
  } finally {
    await b.close().catch(() => {});
  }
}
