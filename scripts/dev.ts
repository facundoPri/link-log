// Local stack: migrations -> Wrangler (Worker + local D1/R2) -> Bun UI with the /api proxy.
// Identified by ports and state dir, so several checkouts can run side by side:
//   LINKLOG_UI_PORT (3000)  LINKLOG_API_PORT (8787)  LINKLOG_PERSIST_TO (.wrangler/state)
//   LINKLOG_WRANGLER_CONFIG (alternate wrangler config)  LINKLOG_NO_HMR  LINKLOG_RECOVERY_MS
// The auth secret for a state dir is generated once and kept inside it, so sessions survive
// restarts. It is local-only and never valid for a deployed Worker (see worker/config.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { apiPort, apiUrl, HOST, portInUse, uiPort, uiUrl } from "./ports";

export const stateDir = resolve(process.env.LINKLOG_PERSIST_TO || ".wrangler/state");
const appEnv = process.env.LINKLOG_APP_ENV === "test" ? "test" : "local";
/** The public origin the browser sees; Better Auth's baseURL and the only trusted origin. */
export const origin = uiUrl();
const wranglerConfig = process.env.LINKLOG_WRANGLER_CONFIG ? ["-c", process.env.LINKLOG_WRANGLER_CONFIG] : [];

function localEnvFile() {
  mkdirSync(stateDir, { recursive: true });
  const secretPath = join(stateDir, "linklog-auth-secret");
  if (!existsSync(secretPath)) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    writeFileSync(secretPath, Buffer.from(bytes).toString("base64url"), { mode: 0o600 });
  }
  const secret = readFileSync(secretPath, "utf8").trim();
  // Loaded last, so a stray APP_ENV/BETTER_AUTH_URL in .dev.vars cannot change the local identity.
  // Wrangler treats env-file values as secrets and prints them as "(hidden)".
  const envPath = join(stateDir, "linklog-local.env");
  // Automated runs (APP_ENV=test) use the deterministic Jev fixture: no paid model calls.
  const testVars = appEnv === "test" ? "JEV_PROVIDER=fixture\nALLOW_FIXTURE_JEV=1\n" : "";
  writeFileSync(envPath, `APP_ENV=${appEnv}\nBETTER_AUTH_URL=${origin}\nBETTER_AUTH_SECRET=${secret}\n${testVars}`, { mode: 0o600 });
  return envPath;
}

export function migrateArgs() {
  return ["bunx", "wrangler", "d1", "migrations", "apply", "linklog", "--local", ...wranglerConfig, "--persist-to", stateDir];
}

export function wranglerDevArgs() {
  const envFiles = [...(existsSync(".dev.vars") ? [".dev.vars"] : []), localEnvFile()];
  return [
    "bunx", "wrangler", "dev", ...wranglerConfig,
    "--ip", HOST,
    "--port", String(apiPort()),
    "--inspector-port", String(apiPort() + 1000),
    "--persist-to", stateDir,
    ...envFiles.flatMap((file) => ["--env-file", file]),
    // Wrangler's request log prints full URLs, including auth tokens; keep it off by default.
    "--log-level", process.env.LINKLOG_WRANGLER_LOG_LEVEL || "warn",
    ...(process.env.LINKLOG_WRANGLER_LOCAL === "1" ? ["--local"] : []),
  ];
}

export async function runStack(options: { afterApi?: () => Promise<void>; uiEnv?: Record<string, string> } = {}) {
  // Never kill whatever already listens on our ports; pick other ports instead.
  for (const [name, port, env] of [
    ["UI", uiPort(), "LINKLOG_UI_PORT"],
    ["API", apiPort(), "LINKLOG_API_PORT"],
  ] as const)
    if (await portInUse(port)) {
      console.error(`${name} port ${port} is already in use. Stop that process or set ${env} to another port.`);
      process.exit(1);
    }
  const migrate = Bun.spawn(migrateArgs(), { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if ((await migrate.exited) !== 0) process.exit(1);
  const api = Bun.spawn(wranglerDevArgs(), { stdout: "inherit", stderr: "inherit" });
  let ready = false;
  for (let attempt = 0; attempt < 600 && !ready; attempt++) {
    let status = 0;
    try {
      // 401 means the Worker is up with a valid auth config; 503 means its config was rejected.
      status = (await fetch(`${apiUrl()}/api/library`)).status;
    } catch {}
    if (status === 503) {
      api.kill();
      throw new Error("The Worker rejected its auth configuration (503). Check APP_ENV/BETTER_AUTH_* and the EMAIL binding.");
    }
    ready = status === 401;
    if (!ready) await Bun.sleep(100);
  }
  if (!ready) {
    api.kill();
    throw new Error(`The Worker did not start on ${apiUrl()}.`);
  }
  try {
    await options.afterApi?.();
  } catch (error) {
    api.kill();
    throw error;
  }
  const app = Bun.spawn(["bun", ...(process.env.LINKLOG_NO_HMR ? [] : ["--hot"]), "src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...options.uiEnv },
  });
  // Wrangler does not fire cron locally. Recover durable queued/running jobs after restarts.
  const recovery = setInterval(() => {
    void fetch(`${apiUrl()}/cdn-cgi/local/scheduled`).catch(() => {});
  }, Number(process.env.LINKLOG_RECOVERY_MS) || 30000);
  console.log(`Linklog: ${origin} (API ${apiUrl()}, state ${stateDir}, APP_ENV=${appEnv})`);
  function stop() {
    clearInterval(recovery);
    api.kill();
    app.kill();
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const exited = await Promise.race([
    api.exited.then((code) => `Wrangler exited (${code})`),
    app.exited.then((code) => `UI server exited (${code})`),
  ]);
  console.error(`${exited}; stopping the local stack.`);
  stop();
}

if (import.meta.main) await runStack();
