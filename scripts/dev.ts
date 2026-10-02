// Local stack: migrations -> Wrangler (Worker + local D1/R2) -> Bun UI with HMR and the /api proxy.
// Everything is identified by its ports and state dir so several checkouts can run side by side:
//   LINKLOG_UI_PORT (3000)  LINKLOG_API_PORT (8787)  LINKLOG_STATE_DIR (.wrangler/state)
// The auth secret for that state dir is generated once and kept next to it, so sessions survive
// restarts. It is local-only and never valid for a deployed Worker (see worker/config.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const uiPort = Number(process.env.LINKLOG_UI_PORT || 3000);
export const apiPort = Number(process.env.LINKLOG_API_PORT || 8787);
export const stateDir = resolve(process.env.LINKLOG_STATE_DIR || ".wrangler/state");
const appEnv = process.env.LINKLOG_APP_ENV === "test" ? "test" : "local";
const origin = `http://localhost:${uiPort}`;

function localEnvFile() {
  mkdirSync(stateDir, { recursive: true });
  const secretPath = join(stateDir, "linklog-auth-secret");
  if (!existsSync(secretPath)) {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    writeFileSync(secretPath, Buffer.from(bytes).toString("base64url"), { mode: 0o600 });
  }
  const secret = readFileSync(secretPath, "utf8").trim();
  // Loaded last, so a stray APP_ENV/BETTER_AUTH_URL in .dev.vars cannot change the local identity.
  const envPath = join(stateDir, "linklog-local.env");
  writeFileSync(
    envPath,
    `APP_ENV=${appEnv}\nBETTER_AUTH_URL=${origin}\nBETTER_AUTH_SECRET=${secret}\n`,
    { mode: 0o600 },
  );
  return envPath;
}

export function wranglerDevArgs() {
  const envFiles = [...(existsSync(".dev.vars") ? [".dev.vars"] : []), localEnvFile()];
  return [
    "bunx", "wrangler", "dev",
    "--ip", "127.0.0.1",
    "--port", String(apiPort),
    "--inspector-port", String(apiPort + 1000),
    "--persist-to", stateDir,
    ...envFiles.flatMap((file) => ["--env-file", file]),
    // Wrangler's info-level request log prints full URLs, including auth tokens; keep it off by default.
    "--log-level", process.env.LINKLOG_WRANGLER_LOG_LEVEL || "warn",
    ...(process.env.LINKLOG_WRANGLER_LOCAL === "1" ? ["--local"] : []),
  ];
}

export const apiUrl = `http://127.0.0.1:${apiPort}`;
export { origin };

export async function runStack(options: { afterApi?: () => Promise<void>; uiEnv?: Record<string, string> } = {}) {
  const migrate = Bun.spawn(
    ["bunx", "wrangler", "d1", "migrations", "apply", "linklog", "--local", "--persist-to", stateDir],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );
  if ((await migrate.exited) !== 0) process.exit(1);
  const api = Bun.spawn(wranglerDevArgs(), { stdout: "inherit", stderr: "inherit" });
  let ready = false;
  for (let attempt = 0; attempt < 600 && !ready; attempt++) {
    try {
      // 401 means the Worker is up and its auth config is valid; 503 means config failed.
      const status = (await fetch(`${apiUrl}/api/library`)).status;
      if (status === 503) throw new Error("The Worker rejected its auth configuration (503).");
      ready = status === 401;
    } catch (error) {
      if (error instanceof Error && error.message.includes("503")) {
        api.kill();
        throw error;
      }
    }
    if (!ready) await Bun.sleep(100);
  }
  if (!ready) {
    api.kill();
    throw new Error(`The Worker did not start on ${apiUrl}.`);
  }
  try {
    await options.afterApi?.();
  } catch (error) {
    api.kill();
    throw error;
  }
  const app = Bun.spawn(["bun", "--hot", "src/index.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ...options.uiEnv, LINKLOG_UI_PORT: String(uiPort), LINKLOG_API_PORT: String(apiPort) },
  });
  // Wrangler does not fire cron locally. Recover durable queued/running jobs after restarts.
  const recovery = setInterval(() => {
    void fetch(`${apiUrl}/cdn-cgi/local/scheduled`).catch(() => {});
  }, 30000);
  console.log(`Linklog: ${origin} (API ${apiUrl}, state ${stateDir}, APP_ENV=${appEnv})`);
  function stop() {
    clearInterval(recovery);
    api.kill();
    app.kill();
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await Promise.race([api.exited, app.exited]);
  stop();
}

if (import.meta.main) await runStack();
