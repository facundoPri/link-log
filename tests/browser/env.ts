// Isolated environment for real-extension tests: its own ports, D1/R2 state,
// Chromium profiles and a deterministic Jev provider. Never touches your data.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Worker } from "playwright-core";

export const ROOT = resolve(import.meta.dir, "../..");
export const OUT = resolve(ROOT, ".cache/browser-test");
export const UI_PORT = Number(process.env.TEST_UI_PORT) || 3010;
export const API_PORT = Number(process.env.TEST_API_PORT) || 8790;
export const SITE_PORT = Number(process.env.TEST_SITE_PORT) || 3099;
export const UI = `http://127.0.0.1:${UI_PORT}`;
export const API = `http://127.0.0.1:${API_PORT}/api`;
export const SITE = `http://127.0.0.1:${SITE_PORT}`;
export const EXTENSION = resolve(OUT, "extension");
const EXE = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";

async function run(cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out}\n${err}`);
  return out;
}

/** Fixture pages. Markers steer the fixture Jev provider (see worker/ai/fixture.ts). */
export function startSite() {
  return Bun.serve({
    port: SITE_PORT,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/img/"))
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#0f766e"/><text x="24" y="100" font-size="28" fill="#fff" font-family="sans-serif">${url.pathname.slice(5)}</text></svg>`, { headers: { "content-type": "image/svg+xml" } });
      const marker = url.searchParams.get("m") ?? "";
      const title = url.searchParams.get("t") ?? `Fixture ${url.pathname}`;
      const body = `<!doctype html><html><head><title>${title}</title><meta name="description" content="Fixture page ${url.pathname}"><meta property="og:image" content="/img/cover${url.pathname.replaceAll("/", "-")}.svg"><meta property="og:site_name" content="Fixture site"></head>
<body><main><h1>${title}</h1><p>This fixture article talks about ${url.pathname.replaceAll("/", " ")} in enough detail to be read as a normal page by the extension extractor. ${marker}</p>
<p>Second paragraph with more words so the capture is not considered nearly empty. It mentions testing, browsers, tabs and groups.</p>
<h2>Numbers</h2><table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>tabs</td><td>20</td></tr></tbody></table>
<pre><code class="language-ts">const answer = 42;</code></pre>
<form><input name="secret" value="do-not-read-me"><input type="password" value="hunter2"></form>
<a href="https://example.com/related">Related reading</a></main></body></html>`;
      return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
}

export async function startApi() {
  await rm(resolve(OUT, "state"), { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  // No remote bindings (AI, Browser Rendering): nothing paid can run from here.
  const config = {
    name: "linklog-browser-test",
    main: resolve(ROOT, "worker/index.ts"),
    compatibility_date: "2026-09-21",
    compatibility_flags: ["nodejs_compat"],
    assets: { directory: resolve(ROOT, "dist"), binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
    d1_databases: [{ binding: "DB", database_name: "linklog", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: resolve(ROOT, "migrations") }],
    r2_buckets: [{ binding: "CONTENT", bucket_name: "linklog-content" }],
    queues: {
      producers: [{ binding: "JOBS", queue: "linklog-jobs" }],
      consumers: [{ queue: "linklog-jobs", max_batch_size: 10, max_batch_timeout: 1, max_retries: 3, max_concurrency: 10 }],
    },
    workflows: [{ binding: "PROCESS_LINK", name: "linklog-process-link", class_name: "LinkWorkflow" }],
    vars: { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" },
  };
  await writeFile(resolve(OUT, "wrangler.jsonc"), JSON.stringify(config, null, 2));
  const proc = Bun.spawn(["bun", "scripts/dev.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      LINKLOG_UI_PORT: String(UI_PORT),
      LINKLOG_API_PORT: String(API_PORT),
      LINKLOG_WRANGLER_CONFIG: resolve(OUT, "wrangler.jsonc"),
      LINKLOG_PERSIST_TO: resolve(OUT, "state"),
      LINKLOG_RECOVERY_MS: "4000",
      LINKLOG_NO_HMR: "1",
    },
    stdout: Bun.file(resolve(OUT, "dev.log")),
    stderr: Bun.file(resolve(OUT, "dev.err.log")),
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${UI}/api/library`)).ok) return proc;
    } catch {}
    if (proc.exitCode !== null) throw new Error(`dev exited; see ${OUT}/dev.err.log`);
    await Bun.sleep(200);
  }
  throw new Error("API did not start");
}

export async function buildAll() {
  await run(["bun", "scripts/build.ts"]);
  await run(["bun", "apps/extension/scripts/build.ts"], {
    LINKLOG_ORIGINS: `http://127.0.0.1:${UI_PORT},http://localhost:${UI_PORT}`,
    LINKLOG_EXTENSION_OUT: EXTENSION,
    // Test-only: content access for fixture hosts is granted at install.
    LINKLOG_EXTRA_HOSTS: `http://127.0.0.1:${SITE_PORT}/*,https://github.com/*`,
  });
}

export async function launch(name: string, extension = true): Promise<{ context: BrowserContext; sw: Worker | null; version: string }> {
  const dir = resolve(OUT, `profile-${name}`);
  await rm(dir, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: EXE,
    headless: process.env.HEADED ? false : true,
    viewport: { width: 1280, height: 820 },
    args: extension ? [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] : [],
  });
  let sw: Worker | null = null;
  if (extension) {
    sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  }
  const version = context.browser()?.version() ?? (await run([EXE, "--version"])).trim();
  return { context, sw, version };
}

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(API + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return (await r.json()) as T;
}

export async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeout = 30000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}
