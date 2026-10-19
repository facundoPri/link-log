// Scenario API and recorder. A scenario drives the real UI in a recorded Chromium page; every claim its
// captions make must be checked with `expect`, and a clip only passes when it made at least one assertion
// and all of them passed.
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { BAR_HEIGHT, overlayScript, type OverlayState } from "./overlay";
import { fixtureUrl, type FixtureName } from "./fixtures";
import type { EnvOptions } from "./env";
import { OUT } from "./env";
import { updateManifest, type ScenarioResult } from "./manifest";

export const VIEWPORT = { width: 1440, height: 900 };

export type ScenarioMeta = {
  /** Ticket(s) this scenario evidences, e.g. "FAC-48". */
  ticket?: string;
  /** The acceptance criterion or edge case it covers (title card). */
  covers?: string;
  /** The expected result, in one or two sentences (title card). */
  expected?: string;
  /** Worker configuration for this scenario only (default: the chapter's). The runner restarts the stack when it changes. */
  env?: EnvOptions;
  /** Continue from the previous scenario's state: no library reset, and a restart for `env` keeps D1/R2. */
  keepState?: boolean;
};
export type Target = Locator | string;
export type ScenarioContext = {
  page: Page;
  /** Starts a new step: updates the caption bar. `expected` replaces the expected-result panel. */
  step: (caption: string, expected?: string) => Promise<void>;
  /** Glides the cursor to the target, ripples, clicks. A string is a Playwright selector. */
  click: (target: Target) => Promise<void>;
  /** Glides the cursor to the target and rests on it (shows tooltips). */
  hover: (target: Target) => Promise<void>;
  /** Clicks the target, then types like a person. */
  type: (target: Target, text: string) => Promise<void>;
  /** Clicks the target, then fills it at once (reads as a paste; use for long text). */
  paste: (target: Target, text: string) => Promise<void>;
  expect: Expect;
  api: Api;
  /** Waits with a visible countdown chip. */
  hold: (ms: number, label: string) => Promise<void>;
  /** A fixture URL unique to this scenario. */
  fixture: (name: FixtureName, path?: string) => string;
  ui: string;
};
export type ScenarioFn = (ctx: ScenarioContext) => Promise<void>;
export type Scenario = { id: string; title: string; meta: ScenarioMeta; run: ScenarioFn };
export type Chapter = {
  id: string;
  title: string;
  /** PR / ticket line for the intro card. */
  ticket: string;
  /** What the chapter shows, one line each (intro card). */
  summary: string[];
  env?: EnvOptions;
  /** Left out of the default run and of full.mp4; recorded only when named with --chapter. */
  optional?: boolean;
  scenarios: Scenario[];
};

export function scenario(id: string, title: string, run: ScenarioFn): Scenario;
export function scenario(id: string, title: string, meta: ScenarioMeta, run: ScenarioFn): Scenario;
export function scenario(id: string, title: string, a: ScenarioMeta | ScenarioFn, b?: ScenarioFn): Scenario {
  return typeof a === "function" ? { id, title, meta: {}, run: a } : { id, title, meta: a, run: b! };
}
export const chapter = (c: Chapter) => c;

type Assertion = { name: string; ok: boolean; ms: number; error?: string };
class AssertionFailed extends Error {}

export type Expect = {
  /** Polls `check` until it returns truthy (a string is kept as detail) or the timeout passes. */
  (name: string, check: () => Promise<unknown> | unknown, opts?: { timeout?: number }): Promise<void>;
  /** The target becomes visible. A string is matched as visible text. */
  visible(target: Target, name?: string, opts?: { timeout?: number }): Promise<void>;
  /** The target is absent or hidden (checked until the timeout). */
  hidden(target: Target, name?: string, opts?: { timeout?: number }): Promise<void>;
  /** `check` must stay truthy during the whole window, polled every second; fails at the first violation. */
  holds(name: string, ms: number, check: () => Promise<unknown> | unknown): Promise<void>;
};

export type Link = Record<string, any> & { id: string; original_url: string; url: string; attention_kind: string | null; attention_reason: string | null; processing: boolean };
export type Api = {
  get<T = any>(path: string): Promise<T>;
  send<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  library(): Promise<{ links: Link[]; [k: string]: any }>;
  /** The link saved from `url` (matched on original_url or url). */
  link(url: string): Promise<Link | undefined>;
  /** Jobs of a link, newest first, from the library's batches. */
  jobs(url: string): Promise<any[]>;
};

function makeApi(base: string, cookie: string): Api {
  const send = async (method: string, path: string, body?: unknown): Promise<any> => {
    // The Worker refuses a write without a JSON body (415), like the app's own client never sends.
    if (method !== "GET" && body === undefined) body = {};
    const r = await fetch(`${base}/api${path}`, { method, headers: { Cookie: cookie, Origin: base, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
  const api: Api = {
    get: (path) => send("GET", path),
    send,
    library: () => send("GET", "/library"),
    async link(url) {
      return (await api.library()).links.find((l) => l.original_url === url || l.url === url);
    },
    async jobs(url) {
      const lib = await api.library();
      const link = lib.links.find((l) => l.original_url === url || l.url === url);
      if (!link) return [];
      const details = await Promise.all((lib.batches ?? []).map(async (b: any) => ({ kind: b.kind, jobs: ((await send("GET", `/batches/${b.id}`)) as any).jobs ?? [] })));
      return details.flatMap((b) => b.jobs.filter((j: any) => j.link_id === link.id).map((j: any) => ({ ...j, kind: b.kind })));
    },
  };
  return api;
}

const locate = (page: Page, t: Target) => (typeof t === "string" ? page.locator(t) : t);
const short = (e: unknown) => String((e as Error)?.message ?? e).split("\n").filter((l) => l.trim()).slice(0, 2).join(" ").slice(0, 300);

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: !process.env.HEADED });
}

/** Records one scenario. Never throws: the outcome is in the result (and the manifest). */
export async function record(browser: Browser, ch: Chapter, sc: Scenario, ui: string, cookie: string): Promise<ScenarioResult> {
  const rawDir = resolve(OUT, "raw", sc.id);
  await rm(rawDir, { recursive: true, force: true });
  await mkdir(resolve(OUT, "clips"), { recursive: true });
  await mkdir(resolve(OUT, "shots"), { recursive: true });
  const t0 = Date.now();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, recordVideo: { dir: rawDir, size: VIEWPORT } });
  await context.addInitScript(overlayScript, BAR_HEIGHT);
  const page = await context.newPage();
  await context.addCookies(cookie.split("; ").map(pair => { const at = pair.indexOf("="); return { name: pair.slice(0, at), value: pair.slice(at + 1), url: ui }; }));
  const api = makeApi(ui, cookie);
  const assertions: Assertion[] = [];
  const steps: { at: number; caption: string; expected: string }[] = [];
  let state: Partial<OverlayState> = { id: sc.id, title: sc.title, n: 0, caption: "Opening Linklog", expected: sc.meta.expected ?? "", status: "running" };
  const overlay = async (patch: Partial<OverlayState>) => {
    state = { ...state, ...patch };
    await page.evaluate((s) => (window as any).__qa?.set(s), state).catch(() => {});
  };
  // Navigations rebuild the overlay from sessionStorage; this keeps it in sync after reloads too.
  page.on("load", () => void overlay({}));
  const chip = (text: string, kind: "ok" | "bad" | "wait") => page.evaluate(([t, k]) => (window as any).__qa?.chip(t, k), [text, kind] as const).catch(() => {});
  let error: string | undefined;
  let screenshot: string | undefined;
  let offsetMs = 0;

  const fail = async (name: string, e: unknown, started: number): Promise<never> => {
    const message = short(e);
    assertions.push({ name, ok: false, ms: Date.now() - started, error: message });
    await overlay({ n: 0, status: "failed", caption: `✗ ${name}`, expected: message });
    await chip(`✗ ${name}`, "bad");
    screenshot = resolve(OUT, "shots", `${sc.id}-failed.png`);
    await page.screenshot({ path: screenshot }).catch(() => {});
    await page.waitForTimeout(2500);
    throw new AssertionFailed(`${name}: ${message}`);
  };
  const pass = async (name: string, started: number) => {
    assertions.push({ name, ok: true, ms: Date.now() - started });
    await chip(`✓ ${name}`, "ok");
  };
  const poll = async (name: string, check: () => Promise<unknown> | unknown, timeout: number) => {
    const started = Date.now();
    let last: unknown = null;
    while (Date.now() - started < timeout) {
      try {
        if (await check()) return pass(name, started);
        last = null;
      } catch (e) {
        last = e;
      }
      await page.waitForTimeout(400);
    }
    return fail(name, last ?? new Error(`still false after ${Math.round(timeout / 1000)} s`), started);
  };
  const expect = (async (name: string, check: () => Promise<unknown> | unknown, opts?: { timeout?: number }) => poll(name, check, opts?.timeout ?? 15_000)) as Expect;
  expect.visible = async (target, name, opts) => {
    const loc = typeof target === "string" ? page.getByText(target).first() : target;
    const label = name ?? `"${typeof target === "string" ? target : String(target)}" is visible`;
    const started = Date.now();
    try {
      await loc.waitFor({ state: "visible", timeout: opts?.timeout ?? 15_000 });
      await pass(label, started);
    } catch (e) {
      await fail(label, e, started);
    }
  };
  expect.hidden = async (target, name, opts) => {
    const loc = typeof target === "string" ? page.getByText(target) : target;
    const label = name ?? `"${typeof target === "string" ? target : String(target)}" is not shown`;
    await poll(label, async () => !(await loc.first().isVisible().catch(() => false)), opts?.timeout ?? 5_000);
  };
  expect.holds = async (name, ms, check) => {
    const started = Date.now();
    await page.evaluate(([l, m]) => (window as any).__qa?.countdown(l, m), [name, ms] as const).catch(() => {});
    while (Date.now() - started < ms) {
      let ok: unknown;
      try {
        ok = await check();
      } catch (e) {
        await fail(name, e, started);
      }
      if (!ok) await fail(name, new Error(`violated after ${((Date.now() - started) / 1000).toFixed(1)} s`), started);
      await page.waitForTimeout(1000);
    }
    await pass(name, started);
  };

  const move = async (target: Target) => {
    const loc = locate(page, target).first();
    await loc.waitFor({ state: "visible", timeout: 15_000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (!box) throw new Error(`No box for ${String(target)}`);
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    const from = state.cursor ?? { x: 720, y: 400 };
    const ms = Math.round(Math.min(1100, Math.max(450, Math.hypot(x - from.x, y - from.y) * 0.9)));
    await page.evaluate(([a, b, m]) => (window as any).__qa?.move(a, b, m), [x, y, ms] as const);
    state.cursor = { x, y };
    await page.mouse.move(x, y);
    await page.waitForTimeout(180);
    return { x, y };
  };
  const ctx: ScenarioContext = {
    page,
    api,
    expect,
    ui,
    fixture: (name, path = "") => fixtureUrl(name, `${sc.id.toLowerCase()}/${path}`.replace(/\/$/, "")),
    async step(caption, expected) {
      steps.push({ at: Date.now() - t0, caption, expected: expected ?? state.expected ?? "" });
      await overlay({ n: (state.n ?? 0) + 1, caption, ...(expected !== undefined && { expected }) });
      await page.waitForTimeout(900);
    },
    async click(target) {
      const { x, y } = await move(target);
      await page.evaluate(([a, b]) => (window as any).__qa?.ripple(a, b), [x, y] as const);
      await page.mouse.click(x, y);
      await page.waitForTimeout(350);
    },
    async hover(target) {
      await move(target);
      await page.waitForTimeout(700);
    },
    async type(target, text) {
      await ctx.click(target);
      await page.keyboard.type(text, { delay: 28 });
      await page.waitForTimeout(250);
    },
    async paste(target, text) {
      await ctx.click(target);
      await locate(page, target).first().fill(text);
      await page.waitForTimeout(400);
    },
    async hold(ms, label) {
      await page.evaluate(([l, m]) => (window as any).__qa?.countdown(l, m), [label, ms] as const).catch(() => {});
      await page.waitForTimeout(ms);
    },
  };

  const started = new Date().toISOString();
  try {
    await page.goto(ui);
    await overlay({ cursor: { x: 720, y: 400 } });
    await page.waitForTimeout(400);
    offsetMs = Date.now() - t0;
    await sc.run(ctx);
    if (!assertions.length) throw new AssertionFailed("The scenario made no assertions");
    await overlay({ n: 0, status: "passed", caption: `✓ All ${assertions.length} checks passed`, expected: sc.meta.expected ?? "" });
    await page.waitForTimeout(1800);
  } catch (e) {
    error = short(e);
    if (!(e instanceof AssertionFailed)) {
      assertions.push({ name: "scenario ran to the end", ok: false, ms: 0, error });
      screenshot = resolve(OUT, "shots", `${sc.id}-failed.png`);
      await page.screenshot({ path: screenshot }).catch(() => {});
      await overlay({ n: 0, status: "failed", caption: "✗ Scenario error", expected: error });
      await page.waitForTimeout(2000);
    }
  }
  const video = page.video();
  await context.close();
  const clip = resolve(OUT, "clips", `${sc.id}.webm`);
  if (video) await rename(await video.path(), clip);
  await rm(rawDir, { recursive: true, force: true });
  const ok = !error && assertions.length > 0 && assertions.every((a) => a.ok);
  const result: ScenarioResult = {
    id: sc.id,
    title: sc.title,
    chapter: ch.id,
    ticket: sc.meta.ticket ?? ch.ticket,
    covers: sc.meta.covers ?? "",
    expected: sc.meta.expected ?? "",
    status: ok ? "passed" : "failed",
    error,
    screenshot: screenshot && screenshot.replace(`${OUT}/`, ""),
    assertions,
    steps: steps.map((s) => ({ ...s, at: Math.max(0, s.at - offsetMs) })),
    clip: `clips/${sc.id}.webm`,
    clipOffsetMs: offsetMs,
    startedAt: started,
    durationMs: Date.now() - t0,
  };
  await updateManifest(ch, result);
  return result;
}
