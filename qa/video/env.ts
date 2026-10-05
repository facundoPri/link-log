// Starts and stops the isolated QA environment: the product dev stack (scripts/dev.ts) on the QA ports,
// with the QA Worker entry (worker-entry.ts) and its own D1/R2 state. Never touches your data.
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";

export const ROOT = resolve(import.meta.dir, "../..");
export const OUT = resolve(ROOT, "qa/out");
export const UI_PORT = Number(process.env.QA_UI_PORT) || 3300;
export const API_PORT = Number(process.env.QA_API_PORT) || 8990;
export const UI = `http://127.0.0.1:${UI_PORT}`;
export const API = `http://127.0.0.1:${API_PORT}`;

export type EnvOptions = {
  /** "fixture" (default): deterministic fixture Jev. "fake-typesafe": the TypeSafe code path against a local fake
   * that answers `qa:jev-http=<status>` markers (401/402/5xx) and fixture answers otherwise. Neither calls out. */
  jev?: "fixture" | "fake-typesafe";
  /** Every Workflow retry backoff becomes 1 s (QA config only; product timing otherwise). */
  fastRetries?: boolean;
  /** Extra Worker vars, e.g. { BROWSER_CONCURRENCY: "1" }. */
  vars?: Record<string, string>;
};
export const envKey = (o: EnvOptions = {}) => JSON.stringify([o.jev ?? "fixture", !!o.fastRetries, o.vars ?? {}]);

const stripComments = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

async function portBusy(port: number) {
  try {
    const s = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}

async function writeConfig(options: EnvOptions) {
  const src = resolve(import.meta.dir, "wrangler.qa.jsonc");
  const config = JSON.parse(stripComments(await Bun.file(src).text()));
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(dirname(src), p));
  config.main = abs(config.main);
  config.assets.directory = abs(config.assets.directory);
  for (const db of config.d1_databases) db.migrations_dir = abs(db.migrations_dir);
  config.vars = {
    ...config.vars,
    ...(options.jev === "fake-typesafe" ? { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "qa-fake-key", ALLOW_FIXTURE_JEV: "0" } : {}),
    ...(options.fastRetries ? { QA_FAST_RETRIES: "1" } : {}),
    ...options.vars,
  };
  const path = resolve(OUT, "wrangler.qa.generated.jsonc");
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

export type QaEnv = { ui: string; api: string; options: EnvOptions; stop: () => Promise<void> };

export async function startEnv(options: EnvOptions = {}): Promise<QaEnv> {
  for (const port of [UI_PORT, API_PORT])
    if (await portBusy(port)) throw new Error(`Port ${port} is in use. Stop that process or set QA_UI_PORT / QA_API_PORT.`);
  await mkdir(resolve(OUT, "logs"), { recursive: true });
  if (!existsSync(resolve(ROOT, "dist/index.html"))) {
    const build = Bun.spawn(["bun", "scripts/build.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if ((await build.exited) !== 0) throw new Error("bun scripts/build.ts failed");
  }
  // Our own subfolder of the persist root, wiped per start: every run begins with an empty library.
  const persist = resolve(process.env.LINKLOG_PERSIST_TO || resolve(tmpdir(), "linklog-qa"), "qa-video");
  await rm(persist, { recursive: true, force: true });
  const config = await writeConfig(options);
  const log = resolve(OUT, "logs/dev.log");
  const proc = Bun.spawn(["bun", "scripts/dev.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      CI: "1",
      LINKLOG_UI_PORT: String(UI_PORT),
      LINKLOG_API_PORT: String(API_PORT),
      LINKLOG_WRANGLER_CONFIG: config,
      LINKLOG_PERSIST_TO: persist,
      LINKLOG_NO_HMR: "1",
    },
    stdout: Bun.file(log),
    stderr: Bun.file(resolve(OUT, "logs/dev.err.log")),
  });
  const stop = async () => {
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, Bun.sleep(5000)]);
    // wrangler/workerd children that outlive dev.ts on our ports are ours: stop them too.
    for (const port of [UI_PORT, API_PORT]) {
      const pids = (await new Response(Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout).text()).split(/\s+/).filter(Boolean);
      for (const pid of pids) try { process.kill(Number(pid), "SIGTERM"); } catch {}
    }
  };
  for (let i = 0; i < 600; i++) {
    try {
      const health = await fetch(`${UI}/api/__qa/health`);
      if (health.ok && (await health.json() as { qa?: boolean }).qa) return { ui: UI, api: API, options, stop };
    } catch {}
    if (proc.exitCode !== null) throw new Error(`dev exited (${proc.exitCode}); see qa/out/logs/dev.err.log`);
    await Bun.sleep(200);
  }
  await stop();
  throw new Error("The QA environment did not start; see qa/out/logs/");
}
