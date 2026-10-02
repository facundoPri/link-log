/// <reference types="chrome" />
// Real-extension integration run: `bun run test:browser`.
// Isolated ports, D1/R2 state and Chromium profiles; fixture Jev provider (no paid calls).
// Writes evidence to docs/browser-validation/ (run.json, run.md, screenshots).
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext, Page, Worker } from "playwright-core";
import { PROTOCOL_VERSION } from "@linklog/browser-protocol";
import { api, API_PORT, buildAll, EXTENSION, launch, OTHER_APP_PORT, OUT, ROOT, SITE, startApi, startMarkedApp, startSite, UI, UI_PORT, waitFor } from "./env";

// LINKLOG_BROWSER_EVIDENCE writes the run elsewhere (e.g. .cache/...) instead of the committed evidence.
const EVIDENCE = resolve(ROOT, process.env.LINKLOG_BROWSER_EVIDENCE ?? "docs/browser-validation");
type Check = { area: string; name: string; ok: boolean; detail: string; ms: number };
const checks: Check[] = [];
const meta: Record<string, unknown> = { startedAt: new Date().toISOString() };
let area = "setup";

async function check(name: string, fn: () => Promise<string | void>) {
  const started = performance.now();
  try {
    const detail = (await fn()) ?? "";
    checks.push({ area, name, ok: true, detail, ms: Math.round(performance.now() - started) });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    const detail = (error as Error).message.split("\n").filter((l) => l.trim() && !/^\s+-\s+(attempting|waiting 20|retrying)/.test(l)).slice(0, 3).join(" ").slice(0, 400);
    checks.push({ area, name, ok: false, detail, ms: Math.round(performance.now() - started) });
    console.log(`  ✗ ${name} — ${detail}`);
  }
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
const section = (name: string) => {
  area = name;
  console.log(`\n${name}`);
};

// ---------- helpers ----------
let swRef: Worker | null = null;
async function sw(context: BrowserContext): Promise<Worker> {
  const live = context.serviceWorkers().find((w) => w.url().includes("background.js"));
  if (live) return (swRef = live);
  return (swRef = await context.waitForEvent("serviceworker", { timeout: 15000 }));
}
async function inSw<R, A>(context: BrowserContext, fn: (arg: A) => Promise<R>, arg: A): Promise<R> {
  for (let i = 0; i < 3; i++) {
    try {
      return await (await sw(context)).evaluate(fn as never, arg);
    } catch (e) {
      if (i === 2) throw e;
      await Bun.sleep(300);
    }
  }
  throw new Error("unreachable");
}
/** Opens Linklog; `windowId` pins it to a window (newPage may pick any window). */
async function openLinklog(context: BrowserContext, tag: string, windowId?: number): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${UI}/?p=${tag}`);
  if (windowId !== undefined) {
    const t = (await tabOf(context, `p=${tag}`))!;
    if (t.windowId !== windowId)
      await inSw(context, async ([id, w]: [number, number]) => void (await chrome.tabs.move(id, { windowId: w, index: -1 })), [t.id!, windowId] as [number, number]);
  }
  await page.locator("aside").getByRole("button", { name: /^Browser/ }).click();
  await waitFor("Browser view connected", async () => (await page.locator("h1", { hasText: "Browser" }).count()) > 0);
  return page;
}
async function tabOf(context: BrowserContext, urlPart: string) {
  return inSw(context, async (part: string) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url ?? "").includes(part)) ?? null;
  }, urlPart);
}
async function createTabs(context: BrowserContext, windowId: number, urls: string[]) {
  return inSw(context, async ([w, list]: [number, string[]]) => {
    const ids: number[] = [];
    for (const url of list) ids.push((await chrome.tabs.create({ windowId: w, url, active: false })).id!);
    return ids;
  }, [windowId, urls] as [number, string[]]);
}
async function rowCount(page: Page) {
  return page.locator("[data-tab-id]").count();
}
async function cacheStats(context: BrowserContext, lensId: string) {
  return inSw(context, async (id: string) => {
    const all = await chrome.storage.session.get(null);
    const s = { done: 0, failed: 0, inflight: 0, unavailable: 0 };
    for (const [k, v] of Object.entries(all))
      if (k.startsWith("res:"))
        for (const [ek, rec] of Object.entries((v as { entries: Record<string, { state: string }> }).entries))
          if (ek.includes(`~${id}~`)) {
            if (rec.state === "done") s.done++;
            else if (rec.state === "failed") s.failed++;
            else if (rec.state === "unavailable") s.unavailable++;
            else s.inflight++;
          }
    return s;
  }, lensId);
}
async function calls() {
  const usage = await api<{ events: { provider: string; service: string; status: string }[] }>("/usage");
  return usage.events.filter((e) => e.provider === "fixture" && e.service === "jev").length;
}
async function settle(context: BrowserContext, lensId: string, done: number, timeout = 60000) {
  return waitFor(`${done} done for ${lensId}`, async () => {
    const s = await cacheStats(context, lensId);
    return s.done >= done && s.inflight === 0 ? s : null;
  }, timeout);
}
/** The Linklog page the run drives; it must stay the painted tab of its window. */
let home: Page | null = null;
async function shot(page: Page, name: string) {
  // Headless Chromium doesn't repaint background tabs.
  await page.bringToFront();
  await Bun.sleep(300);
  await page.screenshot({ path: resolve(EVIDENCE, `${name}.png`) });
  if (home && page !== home && !home.isClosed()) await home.bringToFront();
}
async function toggleLens(page: Page, name: string) {
  await page.locator("aside button[aria-pressed]", { hasText: name }).first().click();
}
async function selectTabs(page: Page, tabIds: number[]) {
  for (const id of tabIds) await page.locator(`[data-tab-id="${id}"] button[role=checkbox]`).click();
}
async function createLens(body: Record<string, unknown>) {
  const lib = await api<{ lenses: { id: string; name: string }[] }>("/lenses", "POST", { scope: "browser", threshold: 0.8, ...body });
  return lib.lenses.find((l) => l.name === body.name)!;
}
const art = (i: number, marker: string) => `${SITE}/a/${i}?m=${encodeURIComponent(marker)}`;

// ---------- run ----------
await rm(EVIDENCE, { recursive: true, force: true });
await mkdir(EVIDENCE, { recursive: true });
section("Setup");
await buildAll();
const site = startSite();
const markedApp = startMarkedApp();

// D1 migration on existing data: apply 0001–0009, seed through the old schema, then 0010.
await check("0010 applies on a real local D1 with existing rows", async () => {
  const dir = resolve(OUT, "migration");
  await rm(dir, { recursive: true, force: true });
  await mkdir(resolve(dir, "old"), { recursive: true });
  const all = (await Array.fromAsync(new Bun.Glob("*.sql").scan(resolve(ROOT, "migrations")))).sort();
  for (const f of all.filter((f) => f < "0010")) await Bun.write(resolve(dir, "old", f), Bun.file(resolve(ROOT, "migrations", f)));
  const cfg = (migrations: string) =>
    JSON.stringify({ name: "mig", main: resolve(ROOT, "worker/index.ts"), compatibility_date: "2026-09-21", d1_databases: [{ binding: "DB", database_name: "linklog", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: migrations }] });
  await writeFile(resolve(dir, "old.jsonc"), cfg(resolve(dir, "old")));
  await writeFile(resolve(dir, "new.jsonc"), cfg(resolve(ROOT, "migrations")));
  const wr = async (args: string[]) => {
    const p = Bun.spawn(["bunx", "wrangler", ...args, "--local", "--persist-to", resolve(dir, "state")], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1" } });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) throw new Error(out + (await new Response(p.stderr).text()));
    return out;
  };
  await wr(["d1", "migrations", "apply", "linklog", "-c", resolve(dir, "old.jsonc")]);
  await wr(["d1", "execute", "linklog", "-c", resolve(dir, "old.jsonc"), "--command",
    "INSERT INTO links(id,original_url,url,domain,title,created_at) VALUES('l1','https://a.example/','https://a.example/','a.example','A','t'); INSERT INTO batches(id,kind,config,created_at) VALUES('b1','lens','{}','t'); INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('j1','b1','l1','done','t'),('j2','b1','l1','running','t'); INSERT INTO usage_events(id,batch_id,job_id,link_id,provider,service,operation,status,created_at) VALUES('u1','b1','j1','l1','typesafe','jev','classify','done','t'); INSERT INTO provider_leases(job_id,expires_at,pool) VALUES('j2',1,'jev');"]);
  await wr(["d1", "migrations", "apply", "linklog", "-c", resolve(dir, "new.jsonc")]);
  const out = await wr(["d1", "execute", "linklog", "-c", resolve(dir, "new.jsonc"), "--json", "--command",
    "SELECT (SELECT count(*) FROM links) links,(SELECT count(*) FROM jobs) jobs,(SELECT job_id FROM usage_events WHERE id='u1') usage_job,(SELECT count(*) FROM provider_leases) leases,(SELECT count(*) FROM browser_targets) targets"]);
  const row = JSON.parse(out)[0].results[0];
  assert(row.links === 1 && row.jobs === 2 && row.usage_job === "j1" && row.leases === 1 && row.targets === 0, JSON.stringify(row));
  return `links 1, jobs 2, usage_events.job_id kept (${row.usage_job}), leases 1`;
});

const dev = await startApi();
const A = await launch("A");
const ctx = A.context;
const extensionId = new URL((await sw(ctx)).url()).host;
const manifest = await Bun.file(resolve(EXTENSION, "manifest.json")).json();
Object.assign(meta, { browser: A.version, extensionId, extensionVersion: manifest.version, manifest, ui: UI, site: SITE });
console.log(`  Chromium ${A.version} · extension ${extensionId} v${manifest.version}`);

try {
  section("Connection");
  await check("without the extension Browser shows connect/install steps", async () => {
    const plain = await launch("plain", false);
    try {
      const page = await plain.context.newPage();
      await page.goto(UI);
      await page.locator("aside").getByRole("button", { name: /^Browser/ }).click();
      await waitFor("connect card", async () => (await page.getByText("Connect the Linklog extension").count()) > 0, 15000);
      await shot(page, "01-no-extension");
    } finally {
      await plain.context.close();
    }
  });

  const L1 = await openLinklog(ctx, "L1");
  home = L1;
  const l1Tab = (await tabOf(ctx, "p=L1"))!;
  const W1 = l1Tab.windowId;
  // Start from a clean window: close the initial blank tab and the welcome page.
  await inSw(ctx, async (keep: number) => {
    for (const t of await chrome.tabs.query({})) if (t.id !== keep) await chrome.tabs.remove(t.id!);
  }, l1Tab.id!);
  const W2 = await inSw(ctx, async (urls: string[]) => (await chrome.windows.create({ url: urls, focused: false }))!.id!, [0, 1, 2].map((i) => `${SITE}/w2/${i}`));
  const w1Ids = await createTabs(ctx, W1, Array.from({ length: 20 }, (_, i) => art(i, i % 2 ? "jev:no" : "jev:yes")));
  await check("lists only the tabs of Linklog's window (20 here, 3 in the other window)", async () => {
    await waitFor("20 rows", async () => (await rowCount(L1)) === 20, 20000);
    const text = await L1.locator("main").innerText();
    assert(!text.includes("/w2/"), "window 2 tabs leaked into window 1");
    return `window ${W1}: 20 rows; window ${W2} tabs hidden`;
  });

  section("Lenses and cache");
  const linksBefore = (await api<{ links: unknown[] }>("/library")).links.length;
  const lensA = await createLens({ name: "Relevant", type: "noul", question: "Is this page relevant to my research?" });
  const lensB = await createLens({
    name: "Kind",
    type: "choice",
    question: "What kind of page is this?",
    options: [
      { key: "article", label: "Article", description: "" },
      { key: "reference", label: "Reference", description: "" },
    ],
  });
  await L1.reload();
  await L1.locator("aside").getByRole("button", { name: /^Browser/ }).click();
  await check("activating lens A evaluates all 20 tabs once", async () => {
    await toggleLens(L1, "Relevant");
    await settle(ctx, lensA.id, 20);
    const n = await calls();
    assert(n === 20, `expected 20 provider calls, got ${n}`);
    await waitFor("verdicts in rows", async () => (await L1.locator("[data-tab-id]", { hasText: /Yes|No/ }).count()) === 20);
    await shot(L1, "02-lens-active");
    return "20 Jev calls (fixture provider)";
  });
  await check("toggling lens A off and on reuses results (0 new calls)", async () => {
    await toggleLens(L1, "Relevant");
    await Bun.sleep(800);
    await toggleLens(L1, "Relevant");
    await Bun.sleep(3000);
    const n = await calls();
    assert(n === 20, `calls changed to ${n}`);
    assert((await cacheStats(ctx, lensA.id)).done === 20, "results lost");
  });
  const extraIds = await createTabs(ctx, W1, [art(20, "jev:yes"), art(21, "jev:no"), art(22, "jev:yes")]);
  await check("3 new tabs with A active: only the 3 missing are evaluated; inactive B waits", async () => {
    await settle(ctx, lensA.id, 23);
    await Bun.sleep(1500);
    const n = await calls();
    assert(n === 23, `expected 23 calls, got ${n}`);
    assert((await cacheStats(ctx, lensB.id)).done === 0, "lens B ran while inactive");
    return "20 reused + 3 new = 23 calls";
  });
  await check("filters narrow the list, never the evaluation scope", async () => {
    await L1.locator(`[data-lens-filter="${lensA.id}"] button[aria-pressed]`, { hasText: "Yes" }).click();
    await waitFor("12 yes rows", async () => (await rowCount(L1)) === 12);
    await createTabs(ctx, W1, [art(23, "jev:no")]);
    await settle(ctx, lensA.id, 24);
    assert((await rowCount(L1)) === 12, "filtered list changed for a No tab");
    await L1.locator(`[data-lens-filter="${lensA.id}"] button[aria-pressed]`, { hasText: "No" }).click();
    await waitFor("24 rows (Yes OR No)", async () => (await rowCount(L1)) === 24);
    await L1.locator(`[data-lens-filter="${lensA.id}"] button[aria-pressed]`, { hasText: "Yes" }).click();
    await waitFor("12 No rows", async () => (await rowCount(L1)) === 12);
    await shot(L1, "03-filter-no");
    await L1.locator(`[data-lens-filter="${lensA.id}"] button[aria-pressed]`, { hasText: "No" }).click();
    return "Yes → 12 rows; new No tab still evaluated (24 done); inverse No filter → 12";
  });
  await check("two active lenses: AND across lenses, OR within a lens", async () => {
    await toggleLens(L1, "Kind");
    await settle(ctx, lensB.id, 24);
    const n = await calls();
    assert(n === 48, `expected 48 calls, got ${n}`);
    await L1.locator(`[data-lens-filter="${lensA.id}"] button[aria-pressed]`, { hasText: "Yes" }).click();
    await L1.locator(`[data-lens-filter="${lensB.id}"] button[aria-pressed]`, { hasText: "Article" }).click();
    const expected = await L1.evaluate(() => document.querySelectorAll("[data-tab-id]").length);
    const combined = await rowCount(L1);
    await L1.locator(`[data-lens-filter="${lensB.id}"] button[aria-pressed]`, { hasText: "Reference" }).click();
    const either = await rowCount(L1);
    await shot(L1, "04-two-lenses-filters");
    // "Pick one" always includes the automatic "Other" option; all three together = every Yes row.
    await L1.locator(`[data-lens-filter="${lensB.id}"] button[aria-pressed]`, { hasText: "Other" }).click();
    const all = await rowCount(L1);
    assert(all === 12, `Yes AND (Article OR Reference OR Other) should be 12, got ${all}`);
    assert(combined <= either && either <= all && expected === combined, "AND/OR filter mismatch");
    await L1.getByRole("button", { name: "Clear", exact: true }).click();
    return `Yes∧Article = ${combined}; Yes∧(Article∨Reference) = ${either}; Yes∧(any option) = 12`;
  });
  await check("classifying tabs never creates saved links", async () => {
    const after = (await api<{ links: unknown[] }>("/library")).links.length;
    assert(after === linksBefore, `links changed ${linksBefore} → ${after}`);
    return `${after} links before and after 48 evaluations`;
  });

  section("Lifecycle and recovery");
  await check("closing and reopening Linklog keeps done results (0 new calls)", async () => {
    await L1.close();
    const again = await openLinklog(ctx, "L1", W1);
    home = again;
    await waitFor("verdicts back", async () => (await again.locator("[data-tab-id]", { hasText: /Yes|No/ }).count()) === 24);
    assert((await calls()) === 48, "calls changed");
  });
  let L = ctx.pages().find((p) => p.url().includes("p=L1"))!;
  home = L;
  await check("real service-worker suspension keeps session and results", async () => {
    const before = await inSw(ctx, async () => (await chrome.storage.session.get("browserSessionId")).browserSessionId as string, 0);
    await L.close();
    // An in-memory marker proves the worker really restarts (only storage.session survives).
    await inSw(ctx, async () => void ((globalThis as { __probe?: string }).__probe = "before-stop"), 0);
    const cdp = await ctx.newCDPSession(ctx.pages()[0]!);
    const { targetInfos } = (await cdp.send("Target.getTargets")) as { targetInfos: { type: string; url: string; targetId: string }[] };
    const target = targetInfos.find((t) => t.type === "service_worker" && t.url.includes(extensionId))!;
    await cdp.send("Target.closeTarget", { targetId: target.targetId });
    await Bun.sleep(1000);
    L = await openLinklog(ctx, "L1", W1);
    home = L;
    await waitFor("verdicts back", async () => (await L.locator("[data-tab-id]", { hasText: /Yes|No/ }).count()) === 24, 20000);
    const after = await inSw(ctx, async () => (await chrome.storage.session.get("browserSessionId")).browserSessionId as string, 0);
    const probe = await inSw(ctx, async () => (globalThis as { __probe?: string }).__probe ?? "fresh", 0);
    assert(probe === "fresh", "the service worker was not restarted");
    assert(before === after, "browserSessionId changed");
    assert((await calls()) === 48, "calls changed");
    return `worker stopped and restarted; session ${after.slice(0, 8)}… unchanged; 0 new calls`;
  });
  await check("API outage: stored answers stay visible, nothing is emptied", async () => {
    await L.route("**/api/**", (route) => route.abort());
    await createTabs(ctx, W1, [art(30, "jev:yes")]);
    await waitFor("offline banner", async () => (await L.getByText(/local API is unavailable/).count()) > 0, 20000);
    assert((await L.locator("[data-tab-id]", { hasText: /Yes|No/ }).count()) >= 24, "results disappeared");
    await shot(L, "05-api-offline");
    await L.unroute("**/api/**");
    await settle(ctx, lensA.id, 25, 60000);
    await settle(ctx, lensB.id, 25, 60000);
    const n = await calls();
    assert(n === 50, `expected 50 calls after recovery, got ${n}`);
    return "banner shown; recovered by request id; 2 new calls (A, B) for the new tab";
  });
  await check("response lost after the POST was accepted: same job, no duplicate", async () => {
    let dropped = 0;
    await L.route("**/api/browser/evaluations", async (route) => {
      if (route.request().method() === "POST" && dropped < 2) {
        dropped++;
        await route.fetch(); // the backend accepts it…
        await route.abort(); // …but the page never sees the answer
      } else await route.continue();
    });
    const batchesBefore = (await api<{ batches: { kind: string }[] }>("/library")).batches.filter((b) => b.kind === "browser-lens").length;
    await createTabs(ctx, W1, [art(31, "jev:no")]);
    await settle(ctx, lensA.id, 26, 60000);
    await settle(ctx, lensB.id, 26, 60000);
    await L.unroute("**/api/browser/evaluations");
    const batchesAfter = (await api<{ batches: { kind: string }[] }>("/library")).batches.filter((b) => b.kind === "browser-lens").length;
    const n = await calls();
    assert(dropped === 2, `dropped ${dropped}`);
    assert(n === 52, `expected 52 calls, got ${n}`);
    assert(batchesAfter - batchesBefore === 2, `expected 2 new batches, got ${batchesAfter - batchesBefore}`);
    return "2 responses dropped; reconciled by GET; 2 batches, 2 calls";
  });
  await check("queue redelivery / recovery sweeps don't repeat evaluations; polling stays calm", async () => {
    // Status polls while jobs are queued/running: one per pending request every ~1.5 s,
    // not a tight loop driven by "results changed" echoes.
    let polls = 0;
    const count = (r: { method: () => string; url: () => string }) => {
      if (r.method() === "GET" && /\/api\/browser\/evaluations\/[^/]+$/.test(r.url())) polls++;
    };
    L.on("request", count);
    const started = Date.now();
    await createTabs(ctx, W1, [art(32, "jev:slow=2500 jev:yes"), art(33, "jev:slow=2500 jev:no")]);
    for (let i = 0; i < 4; i++) {
      await fetch(`http://127.0.0.1:${API_PORT}/cdn-cgi/local/scheduled`).catch(() => {});
      await Bun.sleep(700);
    }
    await settle(ctx, lensA.id, 28, 60000);
    await settle(ctx, lensB.id, 28, 60000);
    L.off("request", count);
    const seconds = (Date.now() - started) / 1000;
    const n = await calls();
    assert(n === 56, `expected 56, got ${n}`);
    // At most 2 requests (one per lens) polled every 1.5 s, plus the immediate polls after each submit.
    assert(polls / seconds < 4, `${polls} status polls in ${seconds.toFixed(1)} s`);
    return `4 recovery sweeps during running jobs; 4 calls for 2 tabs × 2 lenses; ${polls} status polls in ${seconds.toFixed(1)} s`;
  });

  section("Identity and invalidation");
  await check("closing and reopening the same URL is a new tab instance", async () => {
    const t = (await tabOf(ctx, "/a/0?"))!;
    const before = await L.locator(`[data-tab-id="${t.id}"]`).count();
    const oldInstance = await inSw(ctx, async () => (await chrome.storage.session.get("instances")).instances as Record<string, any>, 0);
    await inSw(ctx, async (id: number) => chrome.tabs.remove(id), t.id!);
    const [newId] = await createTabs(ctx, W1, [t.url!]);
    const inst = await inSw(ctx, async () => (await chrome.storage.session.get("instances")).instances as Record<string, any>, 0);
    assert(before === 1, "row missing");
    assert(inst[String(newId)].tabInstanceId !== oldInstance[String(t.id)].tabInstanceId, "instance reused");
    await settle(ctx, lensA.id, 28);
    await settle(ctx, lensB.id, 28);
    const n = await calls();
    assert(n === 58, `expected 58, got ${n}`);
    return "new tabInstanceId; re-evaluated (2 calls)";
  });
  await check("navigation invalidates; hash change doesn't; SPA pushState does", async () => {
    const t = (await tabOf(ctx, "/a/1?"))!;
    const page = ctx.pages().find((p) => p.url().includes("/a/1?"))!;
    await page.evaluate(() => (location.hash = "#section"));
    await Bun.sleep(2500);
    assert((await calls()) === 58, "hash change re-evaluated");
    await page.evaluate(() => history.pushState({}, "", "/spa/next?m=jev:yes"));
    await waitFor("revision bump", async () => {
      const i = await inSw(ctx, async () => (await chrome.storage.session.get("instances")).instances as Record<string, any>, 0);
      return i[String(t.id)].documentRevision === 1;
    });
    await settle(ctx, lensA.id, 28);
    await settle(ctx, lensB.id, 28);
    await waitFor("2 calls", async () => (await calls()) === 60);
    await inSw(ctx, async (id: number) => chrome.tabs.update(id, { url: "http://127.0.0.1:3099/a/99?m=jev:no" }), t.id!);
    await waitFor("2 more calls", async () => (await calls()) === 62, 30000);
    return "hash: 0 calls; pushState: 2; full navigation: 2";
  });
  await check("editing a lens: threshold reuses answers, a new question re-evaluates", async () => {
    const full = (await api<{ lenses: any[] }>("/library")).lenses.find((l) => l.id === lensA.id);
    await api(`/lenses/${lensA.id}`, "PATCH", { ...full, threshold: 0.6 });
    await L.reload();
    await L.locator("aside").getByRole("button", { name: /^Browser/ }).click();
    await Bun.sleep(3000);
    assert((await calls()) === 62, "threshold change re-evaluated");
    await api(`/lenses/${lensA.id}`, "PATCH", { ...full, question: "Is this page relevant to my thesis?" });
    await L.reload();
    await L.locator("aside").getByRole("button", { name: /^Browser/ }).click();
    const tabs = await rowCount(L);
    await waitFor("re-evaluated", async () => (await calls()) === 62 + tabs, 60000);
    return `threshold: 0 calls; question: ${tabs} calls (one per tab)`;
  });
  await check("Re-evaluate this window runs every readable tab exactly once", async () => {
    // Tabs with a current answer for lens A (the cache also keeps answers of its old question).
    const answered = () => L.locator(`[data-lens-cell="${lensA.id}"]`, { hasText: /Yes|No|Unsure/ }).count();
    // Results reload after the question edit: wait until every lens-A cell settled.
    const pending = () => L.locator(`[data-lens-cell="${lensA.id}"]`, { hasText: /Waiting|Queued|Evaluating/ }).count();
    await waitFor("lens A settled", async () => (await pending()) === 0 && (await answered()) > 0, 30000);
    const readable = await answered();
    const n = await calls();
    await L.locator(`[data-lens-filter="${lensA.id}"]`).getByRole("button", { name: /options/ }).click();
    await L.getByRole("menuitem", { name: "Re-evaluate this window" }).click();
    await waitFor("re-evaluated", async () => (await calls()) >= n + readable, 60000);
    await waitFor("answers back", async () => (await answered()) === readable, 30000);
    await Bun.sleep(3000);
    const added = (await calls()) - n;
    assert(added === readable, `expected ${readable} calls (one per tab), got ${added}`);
    return `${readable} tabs → ${added} calls, even across claim rounds of 20`;
  });
  await check("Clean drops results, turns the lens off and doesn't re-evaluate", async () => {
    await L.locator(`[data-lens-filter="${lensA.id}"]`).getByRole("button", { name: /options/ }).click();
    await L.getByRole("menuitem", { name: "Clean results…" }).click();
    await L.getByRole("button", { name: "Clean results" }).click();
    const n = await calls();
    await Bun.sleep(3000);
    assert((await calls()) === n, "Clean triggered evaluations");
    assert((await cacheStats(ctx, lensA.id)).done === 0, "results remain");
    assert((await L.locator("aside button[aria-pressed=true]", { hasText: "Relevant" }).count()) === 0, "lens still active");
    return "0 results for A, A off, lens definition kept";
  });

  section("States that are not answers");
  await check("provider failure is Failed with explicit retry, never No", async () => {
    const [id] = await createTabs(ctx, W1, [art(40, "jev:fail")]);
    await waitFor("failed", async () => (await cacheStats(ctx, lensB.id)).failed === 1, 30000);
    await waitFor("row shows Failed", async () => (await L.locator(`[data-tab-id="${id}"]`, { hasText: "Failed" }).count()) === 1);
    const n = await calls();
    await Bun.sleep(3000);
    assert((await calls()) === n, "failure retried automatically");
    await L.locator(`[data-tab-id="${id}"]`).getByRole("button", { name: "Retry Kind" }).click();
    await waitFor("explicit retry ran", async () => (await calls()) === n + 1, 20000);
    await shot(L, "06-failed-retry");
    return "no automatic retry; explicit retry = 1 call";
  });
  await check("no permission and internal pages stay manageable with honest states", async () => {
    const [noAccess] = await createTabs(ctx, W1, ["http://localhost:3099/private"]);
    // chrome:// pages and tabs.discard() close the Playwright context in headless Chromium
    // (reproduced with an empty extension); an extension page is equally unreadable, and the
    // discarded/frozen states are covered by apps/extension/tests (contentAccess).
    const [restricted] = await createTabs(ctx, W1, [`chrome-extension://${extensionId}/popup.html`]);
    await waitFor("states", async () =>
      (await L.locator(`[data-tab-id="${noAccess}"]`, { hasText: "No access" }).count()) === 1 &&
      (await L.locator(`[data-tab-id="${restricted}"]`, { hasText: "Can't read" }).count()) === 1,
    );
    const n = await calls();
    await Bun.sleep(2500);
    assert((await calls()) === n, "an unreadable tab was sent to Jev");
    await shot(L, "07-access-states");
    return "No access / Can't read shown; neither evaluated nor activated";
  });
  await check("application pages keep deterministic evidence (GitHub PR state)", async () => {
    await ctx.route("https://github.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html><head><meta charset="utf-8"><title>Fix sync race by ada · Pull Request #7 · acme/app</title></head><body>
<div class="gh-header-meta"><span class="State State--merged" title="Status: Merged">Merged</span></div>
<main><h1><bdi class="js-issue-title markdown-title">Fix sync race</bdi></h1>
<div class="timeline-comment"><p>Looks good, merging.</p></div><div class="timeline-comment"><p>Thanks!</p></div></main></body></html>`,
      }),
    );
    // Playwright routes apply to pages it opens, so open it here and move it into window 1.
    const gh = await ctx.newPage();
    await gh.goto("https://github.com/acme/app/pull/7");
    const id = (await tabOf(ctx, "github.com/acme/app/pull/7"))!.id!;
    await inSw(ctx, async ([tab, w]: [number, number]) => void (await chrome.tabs.move(tab, { windowId: w, index: -1 })), [id, W1] as [number, number]);
    await waitFor("Merged badge", async () => (await L.locator(`[data-tab-id="${id}"]`, { hasText: "Merged" }).count()) === 1, 30000);
    const capture = await inSw(ctx, async () => JSON.stringify(Object.entries(await chrome.storage.session.get(null)).filter(([k]) => k.startsWith("cap:")).map(([, v]) => v)), 0);
    assert(capture.includes("Pull request state: Merged") && capture.includes("Comments loaded: 2"), "PR facts missing from capture");
    await L.locator(`[data-tab-id="${id}"]`).scrollIntoViewIfNeeded();
    await shot(L, "07b-github-pr-facts");
    await L.bringToFront(); // keep Linklog the painted tab of window 1
    return "facts: state Merged, 2 comments; sent to Jev as evidence and shown as a badge";
  });
  await check("page capture excludes form values and passwords", async () => {
    const all = await inSw(ctx, async () => JSON.stringify(await chrome.storage.session.get(null)), 0);
    assert(all.includes("Second paragraph"), "no capture found");
    assert(!all.includes("hunter2") && !all.includes("do-not-read-me"), "form values captured");
  });

  section("Content, previews and domains");
  await check("rows show the page's own preview (description and image), read locally", async () => {
    const id = (await tabOf(ctx, "/a/3?"))!.id!;
    const row = L.locator(`[data-tab-id="${id}"]`);
    await waitFor("preview", async () => (await row.getByText("Fixture page /a/3").count()) === 1 && (await row.locator("img[src*='/img/cover-a-3']").count()) === 1, 20000);
    return "description and og:image from the page's metadata; nothing sent to the API";
  });
  await check("clicking a tab opens the inspector with the page as Markdown and its links", async () => {
    const id = (await tabOf(ctx, "/a/3?"))!.id!;
    await L.locator(`[data-tab-id="${id}"] p`).first().click();
    const panel = L.locator(`[data-browser-inspector="${id}"]`);
    await waitFor("content", async () => (await panel.locator("[data-capture-markdown]", { hasText: "Second paragraph" }).count()) === 1, 20000);
    await panel.getByRole("radio", { name: "Markdown" }).click();
    const md = (await panel.locator("[data-capture-markdown] pre").textContent()) ?? "";
    assert(md.includes("| Metric | Value |") && md.includes("```ts") && md.includes("[Related reading](https://example.com/related)"), `markdown lacks table/code/link: ${md.slice(0, 400)}`);
    assert(!md.includes("hunter2") && !md.includes("do-not-read-me"), "form values in content");
    await panel.getByRole("radio", { name: "Preview" }).click();
    await shot(L, "15-inspector");
    await panel.getByRole("tab", { name: /^Links/ }).click();
    await waitFor("links tab", async () => (await panel.getByText("Related reading").count()) > 0);
    await panel.getByRole("button", { name: "Close inspector" }).click();
    return `Markdown with GFM table, fenced code and absolute links (${md.length} chars)`;
  });
  await check("domain filter: pick several (OR), remove one, clear", async () => {
    const gh = (await tabOf(ctx, "github.com/acme/app/pull/7"))!.id!;
    const total = await rowCount(L);
    await L.getByRole("button", { name: "Filter", exact: true }).click();
    await L.getByRole("option", { name: /^github\.com/ }).click();
    await waitFor("only github", async () => (await rowCount(L)) === 1 && (await L.locator(`[data-tab-id="${gh}"]`).count()) === 1);
    await L.getByRole("option", { name: /^127\.0\.0\.1/ }).click();
    const both = await waitFor("github + 127.0.0.1", async () => {
      const n = await rowCount(L);
      return n > 1 && n < total ? n : null;
    });
    await shot(L, "16-domain-filter");
    await L.keyboard.press("Escape");
    await L.getByRole("button", { name: "Remove domain filter github.com" }).click();
    await waitFor("github removed", async () => (await L.locator(`[data-tab-id="${gh}"]`).count()) === 0);
    await L.getByRole("button", { name: "Clear", exact: true }).click();
    await waitFor("cleared", async () => (await rowCount(L)) === total);
    return `${total} tabs → 1 (github.com) → ${both} (+127.0.0.1) → cleared`;
  });

  section("Bridge security");
  await check("non-Linklog pages get no bridge and can't reach the extension", async () => {
    const page = ctx.pages().find((p) => p.url().startsWith(SITE))!;
    const res = await page.evaluate(async (ext) => {
      const bridge = document.documentElement.dataset.linklogBridge ?? null;
      const runtime = (window as any).chrome?.runtime;
      let connect = runtime?.connect ? "runtime exposed" : "no chrome.runtime on the page";
      if (runtime?.connect)
        try {
          runtime.connect(ext, { name: "linklog-bridge" });
          connect = "connected?";
        } catch (e) {
          connect = String(e).slice(0, 60);
        }
      const reply = await new Promise((r) => {
        addEventListener("message", (e) => e.data?.from === "extension" && r("answered"));
        postMessage({ channel: "linklog-bridge", from: "page", request: { id: "x1", command: "closeTabs", args: { tabs: [] } } }, "*");
        setTimeout(() => r("no answer"), 1500);
      });
      return { bridge, connect, reply };
    }, extensionId);
    assert(res.bridge === null && res.reply === "no answer" && res.connect !== "connected?", JSON.stringify(res));
    return JSON.stringify(res);
  });
  await check(`bridge finds Linklog on a non-default port (${UI_PORT}) with no configured origin`, async () => {
    const matches: string[] = manifest.content_scripts[0].matches;
    assert(!matches.some((m) => m.includes(String(UI_PORT))), `manifest names the port: ${matches.join(", ")}`);
    assert(await L.evaluate((v) => document.documentElement.dataset.linklogBridge === v, String(PROTOCOL_VERSION)), "no bridge on Linklog");
    return `content script matches ${matches.join(", ")}; Linklog connected on :${UI_PORT}`;
  });
  await check("a local page with the marker gets the bridge, but nothing before a handshake", async () => {
    const page = await ctx.newPage();
    try {
      await page.goto(`http://127.0.0.1:${OTHER_APP_PORT}/`);
      const res = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 500));
        const bridge = document.documentElement.dataset.linklogBridge ?? null;
        const reply = await new Promise((r) => {
          addEventListener("message", (e) => e.data?.from === "extension" && e.data.response?.id === "s1" && r(e.data.response));
          postMessage({ channel: "linklog-bridge", from: "page", request: { id: "s1", command: "snapshot", args: {} } }, location.origin);
          setTimeout(() => r("no answer"), 3000);
        });
        return { bridge, reply };
      });
      assert(res.bridge === String(PROTOCOL_VERSION), `bridge missing: ${JSON.stringify(res)}`);
      assert(JSON.stringify(res.reply).includes("Connect first"), `snapshot without hello: ${JSON.stringify(res.reply)}`);
      return "bridge attached; snapshot before hello → “Connect first.”";
    } finally {
      await page.close();
      await L.bringToFront();
    }
  });
  await check("bridge rejects malformed commands and ids from another window", async () => {
    const other = (await tabOf(ctx, "/w2/0"))!;
    const inst = await inSw(ctx, async () => (await chrome.storage.session.get("instances")).instances as Record<string, any>, 0);
    const res = await L.evaluate(async ([tabId, tabInstanceId]) => {
      const ask = (request: unknown) =>
        new Promise((r) => {
          const on = (e: MessageEvent) => {
            if (e.data?.from === "extension" && e.data.response?.id === (request as { id: string }).id) {
              removeEventListener("message", on);
              r(e.data.response);
            }
          };
          addEventListener("message", on);
          postMessage({ channel: "linklog-bridge", from: "page", request }, location.origin);
          setTimeout(() => r("timeout"), 3000);
        });
      const bad = await ask({ id: "bad1", command: "eval", args: { code: "1" } });
      const foreign = await ask({ id: "far1", command: "closeTabs", args: { tabs: [{ tabId, tabInstanceId, url: "http://127.0.0.1:3099/w2/0" }] } });
      return { bad, foreign };
    }, [other.id!, inst[String(other.id)].tabInstanceId] as [number, string]);
    const stillOpen = await tabOf(ctx, "/w2/0");
    assert(res.bad === "timeout", `malformed command was answered: ${JSON.stringify(res.bad)}`);
    assert(JSON.stringify(res.foreign).includes("no longer in this window") && stillOpen, JSON.stringify(res.foreign));
    return "unknown command dropped by the bridge; other-window tab refused and still open";
  });

  section("Save and Close");
  await check("Save adds links through the normal library pipeline (extraction queued)", async () => {
    const ids = [(await tabOf(ctx, "/a/3?"))!.id!, (await tabOf(ctx, "/a/4?"))!.id!];
    const before = await api<{ links: any[]; batches: any[] }>("/library");
    let saveBody = "";
    const spy = (r: { method: () => string; url: () => string; postData: () => string | null }) => {
      if (r.method() === "POST" && r.url().endsWith("/api/browser/save")) saveBody = r.postData() ?? "";
    };
    L.on("request", spy);
    await selectTabs(L, ids);
    await L.getByRole("button", { name: "Save", exact: true }).click();
    await waitFor("2 links", async () => (await api<{ links: any[] }>("/library")).links.length === before.links.length + 2, 20000);
    L.off("request", spy);
    const after = await api<{ links: any[]; batches: any[] }>("/library");
    const saved = after.links.filter((l) => !before.links.some((b) => b.id === l.id));
    // Only URLs travel; the server fetches them like any added link. The fixture host is
    // 127.0.0.1 (SSRF-blocked) and there are no remote bindings, so extraction won't succeed
    // here — what matters is that the normal extract batch was queued for both links.
    assert(saveBody && !saveBody.includes("markdown") && JSON.parse(saveBody).urls?.length === 2, `save body: ${saveBody.slice(0, 200)}`);
    assert(saved.every((l) => l.content_source !== "browser"), "content stored from the local capture");
    const extract = after.batches.filter((b) => b.kind === "extract").length - before.batches.filter((b) => b.kind === "extract").length;
    assert(extract === 1, `expected 1 new extract batch, got ${extract}`);
    await waitFor("Saved badge", async () => (await L.locator("[data-tab-id]", { hasText: "Saved" }).count()) === 2);
    // Tag one (once its extraction job ends, as in All links), save again: duplicate, tags untouched.
    await waitFor("tagged", async () => !(await api(`/links/${saved[0].id}`, "PATCH", { tags: ["keep-me"] })).error, 30000);
    await L.getByRole("button", { name: "Save", exact: true }).click();
    await Bun.sleep(1500);
    const again = await api<{ links: any[] }>("/library");
    assert(again.links.length === after.links.length, "duplicate created");
    assert(again.links.find((l) => l.id === saved[0].id).tags.map((t: any) => t.name).includes("keep-me"), "tags changed");
    await shot(L, "08-saved");
    await L.getByRole("button", { name: "Clear selection" }).click();
    return "2 links from URLs only; 1 normal extract batch queued; re-save = duplicate, tags kept";
  });
  await check("Close closes only the selected tabs, after revalidation", async () => {
    const ids = [(await tabOf(ctx, "/a/5?"))!.id!, (await tabOf(ctx, "/a/6?"))!.id!];
    const total = await inSw(ctx, async () => (await chrome.tabs.query({})).length, 0);
    await selectTabs(L, ids);
    await L.locator("[aria-label='Selected tab actions']").getByRole("button", { name: "Close" }).click();
    await L.getByRole("button", { name: "Close tabs" }).click();
    await waitFor("closed", async () => (await inSw(ctx, async () => (await chrome.tabs.query({})).length, 0)) === total - 2);
    await waitFor("rows removed", async () => (await L.locator(`[data-tab-id="${ids[0]}"], [data-tab-id="${ids[1]}"]`).count()) === 0, 10000);
    const links = (await api<{ links: any[] }>("/library")).links.length;
    return `2 closed; ${links} saved links untouched`;
  });

  section("Groups");
  let pinnedId = "";
  await check("create a pinned group from the selection", async () => {
    const ids = [(await tabOf(ctx, "/a/7?"))!.id!, (await tabOf(ctx, "/a/8?"))!.id!];
    await selectTabs(L, ids);
    await L.locator("[aria-label='Selected tab actions']").getByRole("button", { name: "Group", exact: true }).click();
    await L.getByRole("option", { name: /New group/ }).click();
    await L.locator("#group-name").fill("Research");
    await L.locator("#group-description").fill("Papers and articles for the thesis");
    await L.getByText("Pin to library").click();
    await L.getByRole("button", { name: "Create group" }).click();
    const groups = await waitFor("native group", async () => {
      const g = await inSw(ctx, async (w: number) => chrome.tabGroups.query({ windowId: w }), W1);
      return g.length === 1 ? g : null;
    });
    const catalog = await api<{ groups: any[] }>("/browser/catalog");
    pinnedId = catalog.groups[0]?.id;
    assert(groups[0]!.title === "Research" && catalog.groups.length === 1, "group/pin missing");
    await shot(L, "09-groups");
    return `native group ${groups[0]!.id} bound to pinned ${pinnedId.slice(0, 8)}…`;
  });
  let L2: Page;
  await check("pinned group appears in another window without tabs and materializes on use", async () => {
    L2 = await (async () => {
      const page = await ctx.newPage();
      await page.goto(`${UI}/?p=L2`);
      const t = (await tabOf(ctx, "p=L2"))!;
      await inSw(ctx, async ([id, w]: [number, number]) => void (await chrome.tabs.move(id, { windowId: w, index: -1 })), [t.id!, W2] as [number, number]);
      await page.locator("aside").getByRole("button", { name: /^Browser/ }).click();
      return page;
    })();
    await waitFor("W2 rows", async () => (await rowCount(L2)) === 3, 20000);
    assert((await inSw(ctx, async (w: number) => chrome.tabGroups.query({ windowId: w }), W2)).length === 0, "empty group created");
    await waitFor("pinned destination", async () => (await L2.locator("aside", { hasText: "Research" }).count()) > 0);
    const w2Tab = (await tabOf(ctx, "/w2/1"))!;
    await selectTabs(L2, [w2Tab.id!]);
    await L2.locator("[aria-label='Selected tab actions']").getByRole("button", { name: "Group", exact: true }).click();
    await L2.getByRole("option", { name: /Research/ }).click();
    const g = await waitFor("group in W2", async () => {
      const list = await inSw(ctx, async (w: number) => chrome.tabGroups.query({ windowId: w }), W2);
      return list.length === 1 ? list[0] : null;
    });
    const meta = await inSw(ctx, async () => (await chrome.storage.session.get("groups")).groups as Record<string, any>, 0);
    assert(meta[String(g!.id)].pinnedId === pinnedId, "binding missing");
    await shot(L2, "10-pinned-other-window");
    return `created group ${g!.id} in window ${W2} bound to the same definition`;
  });
  await check("same name never merges groups", async () => {
    const [fresh] = await createTabs(ctx, W1, [art(60, "same-name")]);
    const t = { id: fresh! };
    await inSw(ctx, async ([id, w]: [number, number]) => {
      // Without windowId Chrome uses the focused window and would move the tab there.
      const g = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: w } });
      await chrome.tabGroups.update(g, { title: "Research", color: "red" });
    }, [t.id!, W1] as [number, number]);
    await waitFor("two groups", async () => {
      const groups = await inSw(ctx, async (w: number) => chrome.tabGroups.query({ windowId: w, title: "Research" }), W1);
      return groups.length === 2;
    }).catch(async (e) => {
      const all = await inSw(ctx, async () => (await chrome.tabGroups.query({})).map((g) => `${g.windowId}:${g.title}:${g.color}`), 0);
      const tab = await inSw(ctx, async (id: number) => chrome.tabs.get(id).then((x) => `${x.windowId}/${x.groupId}`).catch(() => "gone"), t.id!);
      throw new Error(`${(e as Error).message} — groups ${all.join(", ")}; tab ${tab}; W1 ${W1}`);
    });
    const pinned = (await api<{ groups: any[] }>("/browser/catalog")).groups.length;
    assert(pinned === 1, "a second definition appeared");
    return "two native 'Research' groups in window 1, one pinned definition";
  });
  await check("Autogroup keeps tabs grouped meanwhile and moves the rest after review", async () => {
    const a = (await createTabs(ctx, W1, [art(50, "jev:group=Research"), art(51, "jev:group=Research")]));
    await waitFor("rows", async () => (await L.locator(`[data-tab-id="${a[1]}"]`).count()) === 1);
    await L.getByRole("button", { name: "Clear selection" }).click({ timeout: 2000 }).catch(() => {});
    await selectTabs(L, a);
    const batches = async () => (await api<{ batches: { id: string; kind: string }[] }>("/library")).batches.filter((b) => b.kind === "browser-autogroup").map((b) => b.id);
    const batchesBefore = await batches();
    await L.getByRole("button", { name: "Autogroup" }).click();
    await waitFor("suggestions", async () => (await L.getByRole("button", { name: /^Apply/ }).isEnabled().catch(() => false)), 40000);
    await Bun.sleep(1500);
    // One click = one run: one Activity batch and one Jev call per tab (dev StrictMode included).
    const runs = (await batches()).filter((id) => !batchesBefore.includes(id));
    assert(runs.length === 1, `expected 1 Autogroup batch in Activity, got ${runs.length}`);
    const usage = await api<{ events: { batch_id: string; provider: string }[] }>("/usage");
    const autogroupCalls = usage.events.filter((e) => e.batch_id === runs[0] && e.provider === "fixture").length;
    assert(autogroupCalls === 2, `expected 2 calls in the Autogroup batch, got ${autogroupCalls}`);
    await shot(L, "11-autogroup-review");
    // The user groups one tab while the suggestion is on screen.
    await inSw(ctx, async ([id, w]: [number, number]) => {
      const g = await chrome.tabs.group({ tabIds: [id], createProperties: { windowId: w } });
      await chrome.tabGroups.update(g, { title: "Manual", color: "yellow" });
    }, [a[0]!, W1] as [number, number]);
    await L.getByRole("button", { name: /^Apply/ }).click();
    const [g0, g1, research] = await waitFor("applied", async () => {
      const tabs = await inSw(ctx, async (ids: number[]) => Promise.all(ids.map((id) => chrome.tabs.get(id))), a);
      const groups = await inSw(ctx, async (w: number) => chrome.tabGroups.query({ windowId: w }), W1);
      const r = groups.find((g) => g.title === "Research" && g.color !== "red");
      return tabs[1]!.groupId === r?.id ? [tabs[0]!.groupId, tabs[1]!.groupId, r!.id] : null;
    }, 20000);
    const manual = (await inSw(ctx, async (id: number) => chrome.tabGroups.get(id), g0!)).title;
    assert(manual === "Manual", "grouped-meanwhile tab was moved");
    return `1 Activity batch, 2 calls; tab kept in “Manual”; other moved to pinned Research (${g1} = ${research})`;
  });
  await check("Move to group changes a grouped tab; Ungroup keeps it open", async () => {
    const t = (await tabOf(ctx, "/a/7?"))!;
    await L.getByRole("button", { name: "Clear selection" }).click({ timeout: 2000 }).catch(() => {});
    await selectTabs(L, [t.id!]);
    await L.locator("[aria-label='Selected tab actions']").getByRole("button", { name: "Group", exact: true }).click();
    await L.getByRole("option", { name: /Manual/ }).click();
    await waitFor("moved", async () => {
      const tab = await inSw(ctx, async (id: number) => chrome.tabs.get(id), t.id!);
      return tab.groupId !== t.groupId && tab.groupId >= 0;
    });
    await L.locator("[aria-label='Selected tab actions']").getByRole("button", { name: "Group", exact: true }).click();
    await L.getByRole("option", { name: /Remove from group/ }).click();
    const tab = await waitFor("ungrouped", async () => {
      const x = await inSw(ctx, async (id: number) => chrome.tabs.get(id).catch(() => null), t.id!);
      return x && x.groupId === -1 ? x : null;
    });
    await L.getByRole("button", { name: "Clear selection" }).click({ timeout: 2000 }).catch(() => {});
    return `tab ${tab.id} open and ungrouped`;
  });
  await check("group filters: one group, several groups (union), ungrouped", async () => {
    const counts = await inSw(ctx, async (w: number) => {
      const tabs = await chrome.tabs.query({ windowId: w });
      return tabs.filter((t) => !t.url?.includes(":3010")).reduce<Record<string, number>>((m, t) => ((m[t.groupId] = (m[t.groupId] ?? 0) + 1), m), {});
    }, W1);
    await L.locator("aside").getByRole("button", { name: /^Ungrouped/ }).click();
    await waitFor("ungrouped rows", async () => (await rowCount(L)) === counts["-1"]);
    await L.locator("aside").getByRole("button", { name: /^Manual/ }).click();
    const manualId = Object.keys(counts).find((k) => k !== "-1" && counts[k] === 1) ?? "";
    await waitFor("union", async () => (await rowCount(L)) === counts["-1"]! + (await inSw(ctx, async () => {
      const g = (await chrome.tabGroups.query({ title: "Manual" }))[0];
      return g ? (await chrome.tabs.query({ groupId: g.id })).length : 0;
    }, 0)));
    await shot(L, "12-group-filters");
    await L.getByRole("button", { name: "Clear", exact: true }).click();
    void manualId;
    return `Ungrouped = ${counts["-1"]} rows; Ungrouped ∪ Manual shown together`;
  });

  section("Two pages, moves and a second profile");
  await check("two Linklog pages in one window share results without duplicate jobs", async () => {
    const lensC = await createLens({ name: "Shared", type: "noul", question: "Shared lens?" });
    const L3 = await openLinklog(ctx, "L3", W1);
    await L.reload();
    await L.locator("aside").getByRole("button", { name: /^Browser/ }).click();
    const n = await calls();
    const eligible = await L.evaluate(() => [...document.querySelectorAll("[data-tab-id]")].filter((r) => !/No access|Can't read|Not loaded/.test(r.textContent ?? "")).length);
    await Promise.all([toggleLens(L, "Shared"), toggleLens(L3, "Shared")]);
    // Every readable tab ends done or failed (the jev:fail fixture) — once.
    await waitFor("all settled", async () => {
      const st = await cacheStats(ctx, lensC.id);
      return st.inflight === 0 && st.done + st.failed + st.unavailable === eligible;
    }, 60000);
    await Bun.sleep(2000);
    const added = (await calls()) - n;
    const unreadable = (await cacheStats(ctx, lensC.id)).unavailable;
    assert(added === eligible - unreadable, `expected ${eligible - unreadable} calls, got ${added}`);
    await waitFor("both pages show results", async () => (await L3.locator("[data-tab-id]", { hasText: "Shared" }).count()) > 0);
    await L3.close();
    return `${eligible} tabs, ${added} calls from two concurrent activations`;
  });
  await check("moving a tab to another window keeps its cached result", async () => {
    const t = (await tabOf(ctx, "/a/10?"))!;
    const before = await cacheStats(ctx, lensB.id);
    await inSw(ctx, async ([id, w]: [number, number]) => void (await chrome.tabs.move(id, { windowId: w, index: -1 })), [t.id!, W2] as [number, number]);
    await waitFor("row moved", async () => (await L.locator(`[data-tab-id="${t.id}"]`).count()) === 0 && (await L2.locator(`[data-tab-id="${t.id}"]`).count()) === 1);
    const after = await cacheStats(ctx, lensB.id);
    assert(after.done === before.done, "cache changed");
    return "row left window 1, appeared in window 2, cache unchanged";
  });
  await check("moving the Linklog page switches its scope to the new window", async () => {
    const t = (await tabOf(ctx, "p=L2"))!;
    await inSw(ctx, async ([id, w]: [number, number]) => void (await chrome.tabs.move(id, { windowId: w, index: -1 })), [t.id!, W1] as [number, number]);
    await waitFor("L2 now lists window 1", async () => (await L2.locator("main").innerText()).includes("/a/3"), 20000);
    assert(!(await L2.locator("main").innerText()).includes("/w2/0"), "still showing window 2");
    return "patch stream re-scoped after onAttached";
  });
  await check("second profile shares pinned definitions, not tabs", async () => {
    const B = await launch("B");
    try {
      const page = await openLinklog(B.context, "B1");
      await waitFor("pinned from profile A", async () => (await page.locator("aside", { hasText: "Research" }).count()) > 0, 20000);
      const text = await page.locator("main").innerText();
      assert(!text.includes("/a/3"), "profile A tabs visible in profile B");
      const idA = await inSw(ctx, async () => (await chrome.storage.local.get("installationId")).installationId as string, 0);
      const idB = await (await sw(B.context)).evaluate(async () => (await chrome.storage.local.get("installationId")).installationId as string);
      await sw(ctx);
      assert(idA !== idB, "same installationId");
      await shot(page, "13-second-profile");
      return `installation ${idA.slice(0, 8)}… vs ${idB.slice(0, 8)}…`;
    } finally {
      await B.context.close();
    }
  });
  await check("Unpin keeps real groups and their metadata", async () => {
    const before = await inSw(ctx, async () => (await chrome.tabGroups.query({ title: "Research" })).length, 0);
    await api(`/browser/groups/${pinnedId}`, "DELETE", {});
    await L.reload();
    await L.locator("aside").getByRole("button", { name: /^Browser/ }).click();
    await Bun.sleep(1500);
    const after = await inSw(ctx, async () => (await chrome.tabGroups.query({ title: "Research" })).length, 0);
    assert(before === after && after >= 2, `${before} → ${after}`);
    return `${after} native “Research” groups still open; definition removed`;
  });

  section("Activity");
  await check("browser evaluations appear in Activity with their usage", async () => {
    await L.locator("aside").getByRole("button", { name: /Activity|Applying/ }).click();
    const sheet = L.getByRole("dialog", { name: "Activity" });
    await waitFor("activity", async () => (await sheet.getByText(/^Browser lens: /).count()) > 0 && (await sheet.getByText(/^Autogroup · open tabs/).count()) > 0, 10000);
    await Bun.sleep(400);
    await shot(L, "14-activity");
    await L.keyboard.press("Escape");
  });
} finally {
  meta.finishedAt = new Date().toISOString();
  meta.providerCalls = await calls().catch(() => null);
  await writeFile(resolve(EVIDENCE, "run.json"), JSON.stringify({ meta, checks }, null, 2));
  const md = [
    `# Browser integration run`,
    ``,
    `- Chromium: ${meta.browser}`,
    `- Extension: ${meta.extensionId} v${meta.extensionVersion}`,
    `- Started: ${meta.startedAt} · finished: ${meta.finishedAt}`,
    `- Fixture Jev calls (mock provider, not paid): ${meta.providerCalls}`,
    ``,
    `| Area | Check | Result | Detail |`,
    `| --- | --- | --- | --- |`,
    ...checks.map((c) => `| ${c.area} | ${c.name} | ${c.ok ? "pass" : "**FAIL**"} | ${c.detail.replaceAll("|", "\\|")} |`),
    ``,
  ].join("\n");
  await writeFile(resolve(EVIDENCE, "run.md"), md);
  await ctx.close().catch(() => {});
  dev.kill();
  site.stop();
  markedApp.stop();
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. Evidence: docs/browser-validation/`);
  process.exit(failed.length ? 1 : 0);
}
