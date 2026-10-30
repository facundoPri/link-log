// Runs one journey file against a running verify instance and writes its evidence:
// <dir>/report.json (steps with video offsets, checks, artifacts), *.png, *.aria.yml, *.json, and one .webm per page.
import { mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { Session } from "./verify";

const VIEWPORT = { width: 1280, height: 820 };
const ROOT = resolve(realpathSync(import.meta.dir), "../../../..");

type Api = {
  get: (path: string) => Promise<any>;
  send: (method: string, path: string, body?: unknown) => Promise<any>;
  /** POST a tag or lens that a journey needs; a 409 means an earlier journey on this instance already created it. */
  ensure: (path: string, body: unknown) => Promise<void>;
  library: () => Promise<{ links: any[]; batches: any[]; tags: any[] }>;
  /** The link saved from `url` (matched on original or resolved URL), or undefined. */
  link: (url: string) => Promise<any>;
};

export type JourneyContext = {
  /** Signed in as Demo A, on the library. */
  page: Page;
  /** API as Demo A, through the UI's /api proxy (same origin and cookie as the page). */
  api: Api;
  ui: string;
  accounts: { label: string; email: string; password: string }[];
  /** A signed-in page for another account (1 = Demo B), in its own context and video. */
  pageAs: (account: number) => Promise<Page>;
  /** An API client for another account. */
  apiAs: (account: number) => Api;
  /** A fixture URL unique to this journey run (qa/video/fixtures.ts), so reruns never dedupe into old links. */
  fixture: (name: string, path?: string) => string;
  /** Starts a step; its offset into the video goes in the report. */
  step: (text: string) => Promise<void>;
  /** Polls until `check` returns something truthy, and returns it. Fails the journey after `timeout` (15 s). */
  check: <T>(name: string, check: () => Promise<T> | T, opts?: { timeout?: number }) => Promise<NonNullable<T>>;
  shot: (name: string, page?: Page) => Promise<void>;
  /** ARIA snapshot of the page, for a text proof of what a user can reach. */
  aria: (name: string, page?: Page) => Promise<void>;
  note: (name: string, data: unknown) => Promise<void>;
};
export type Journey = (ctx: JourneyContext) => Promise<void>;

export type Report = {
  journey: string;
  ui: string;
  commit: string;
  startedAt: string;
  status: "passed" | "failed";
  error?: string;
  steps: { ms: number; text: string }[];
  checks: { name: string; ok: boolean; ms: number; error?: string }[];
  artifacts: string[];
};

function makeApi(ui: string, cookie: string): Api {
  const send = async (method: string, path: string, body?: unknown) => {
    // Writes need a JSON body (415 otherwise) and a trusted Origin.
    const r = await fetch(`${ui}/api${path}`, {
      method,
      headers: { Cookie: cookie, ...(method === "GET" ? {} : { Origin: ui, "Content-Type": "application/json" }) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  };
  const api: Api = {
    get: (path) => send("GET", path),
    send,
    ensure: async (path, body) => {
      await send("POST", path, body).catch((e: Error) => {
        if (!e.message.includes("→ 409")) throw e;
      });
    },
    library: () => send("GET", "/library"),
    link: async (url) => (await api.library()).links.find((l) => l.original_url === url || l.url === url),
  };
  return api;
}

export async function runJourney(file: string, s: Session, dir: string, { headed = false } = {}): Promise<Report> {
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const report: Report = { journey: file, ui: s.ui, commit: s.commit, startedAt: new Date(t0).toISOString(), status: "failed", steps: [], checks: [], artifacts: [] };
  const artifact = (path: string) => report.artifacts.push(relative(dir, path));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: !headed });
  const contexts: BrowserContext[] = [];
  const signedIn = async (account: number) => {
    const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: join(dir, `.video-${contexts.length}`), size: VIEWPORT } });
    contexts.push(context);
    await context.addCookies(s.accounts[account]!.cookie.split("; ").map((pair) => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1), url: s.ui })));
    const page = await context.newPage();
    await page.goto(s.ui);
    return page;
  };
  const page = await signedIn(0);
  const run = `${new Date(t0).toISOString().slice(11, 19).replace(/:/g, "")}`;
  const name = file.split("/").pop()!.replace(/\.ts$/, "");
  const { fixtureUrl } = await import(resolve(ROOT, "qa/video/fixtures.ts"));
  const ctx: JourneyContext = {
    page,
    api: makeApi(s.ui, s.accounts[0]!.cookie),
    ui: s.ui,
    accounts: s.accounts.map(({ label, email, password }) => ({ label, email, password })),
    pageAs: signedIn,
    apiAs: (account) => makeApi(s.ui, s.accounts[account]!.cookie),
    fixture: (fixture, path = "") => fixtureUrl(fixture as any, `${name}-${run}/${path}`.replace(/\/$/, "")),
    async step(text) {
      report.steps.push({ ms: Date.now() - t0, text });
      console.log(`▶ ${text}`);
    },
    async check(checkName, check, { timeout = 15_000 } = {}) {
      const started = Date.now();
      let last: unknown;
      while (Date.now() - started < timeout) {
        try {
          const value = await check();
          if (value) {
            report.checks.push({ name: checkName, ok: true, ms: Date.now() - started });
            return value as NonNullable<typeof value>;
          }
          last = undefined;
        } catch (e) {
          last = e;
        }
        await Bun.sleep(300);
      }
      const error = last ? String((last as Error).message ?? last).split("\n")[0]!.slice(0, 300) : `still false after ${Math.round(timeout / 1000)} s`;
      report.checks.push({ name: checkName, ok: false, ms: Date.now() - started, error });
      throw new Error(`${checkName}: ${error}`);
    },
    async shot(shotName, p = page) {
      const path = join(dir, `${shotName}.png`);
      await p.screenshot({ path });
      artifact(path);
    },
    async aria(ariaName, p = page) {
      const path = join(dir, `${ariaName}.aria.yml`);
      writeFileSync(path, await p.locator("body").ariaSnapshot());
      artifact(path);
    },
    async note(noteName, data) {
      const path = join(dir, `${noteName}.json`);
      writeFileSync(path, JSON.stringify(data, null, 2));
      artifact(path);
    },
  };
  try {
    const journey = (await import(file)).default as Journey;
    await journey(ctx);
    const failed = report.checks.some((c) => !c.ok);
    report.status = report.checks.length && !failed ? "passed" : "failed";
    if (!report.checks.length) report.error = "the journey made no checks";
  } catch (e) {
    report.error = String((e as Error).message ?? e).split("\n")[0];
    await ctx.shot("failed").catch(() => {});
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await browser.close().catch(() => {});
    // Playwright names videos randomly: the first page's recording becomes video.webm, later pages video-<n>.webm.
    for (const [i] of contexts.entries()) {
      const vdir = join(dir, `.video-${i}`);
      const [webm] = readdirSync(vdir).filter((f) => f.endsWith(".webm"));
      if (webm) {
        const path = join(dir, i === 0 ? "video.webm" : `video-${i}.webm`);
        renameSync(join(vdir, webm), path);
        artifact(path);
      }
      rmSync(vdir, { recursive: true, force: true });
    }
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  }
  return report;
}
