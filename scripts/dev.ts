import { apiPort, apiUrl, HOST, portInUse, uiPort } from "./ports";

// Never kill whatever already listens on our ports; pick other ports instead.
for (const [name, port, env] of [
  ["UI", uiPort(), "LINKLOG_UI_PORT"],
  ["API", apiPort(), "LINKLOG_API_PORT"],
] as const)
  if (await portInUse(port)) {
    console.error(`${name} port ${port} is already in use. Stop that process or set ${env} to another port.`);
    process.exit(1);
  }
const wranglerArgs = process.env.LINKLOG_WRANGLER_CONFIG ? ["-c", process.env.LINKLOG_WRANGLER_CONFIG] : [];
const persist = process.env.LINKLOG_PERSIST_TO ? ["--persist-to", process.env.LINKLOG_PERSIST_TO] : [];
const migrate = Bun.spawn(
  ["bunx", "wrangler", "d1", "migrations", "apply", "linklog", "--local", ...wranglerArgs, ...persist],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
if ((await migrate.exited) !== 0) process.exit(1);
const api = Bun.spawn(
  ["bunx", "wrangler", "dev", ...wranglerArgs, "--ip", HOST, "--port", String(apiPort()), ...persist],
  { stdout: "inherit", stderr: "inherit" },
);
for (let attempt = 0; attempt < 150; attempt++) {
  try {
    if ((await fetch(`${apiUrl()}/api/library`)).ok) break;
  } catch {}
  await Bun.sleep(100);
}
const app = Bun.spawn(["bun", ...(process.env.LINKLOG_NO_HMR ? [] : ["--hot"]), "src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});
// Wrangler does not fire cron locally. Recover durable queued/running jobs after restarts.
const recovery = setInterval(() => {
  void fetch(`${apiUrl()}/cdn-cgi/local/scheduled`).catch(() => {});
}, Number(process.env.LINKLOG_RECOVERY_MS) || 30000);
function stop() {
  clearInterval(recovery);
  api.kill();
  app.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([api.exited, app.exited]);
stop();
