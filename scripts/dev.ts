const migrate = Bun.spawn(
  ["bunx", "wrangler", "d1", "migrations", "apply", "linklog", "--local"],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);
if ((await migrate.exited) !== 0) process.exit(1);
const api = Bun.spawn(
  ["bunx", "wrangler", "dev", "--ip", "127.0.0.1", "--port", "8787"],
  { stdout: "inherit", stderr: "inherit" },
);
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    if ((await fetch("http://127.0.0.1:8787/api/library")).ok) break;
  } catch {}
  await Bun.sleep(100);
}
const app = Bun.spawn(["bun", "--hot", "src/index.ts"], {
  stdout: "inherit",
  stderr: "inherit",
});
// Wrangler does not fire cron locally. Recover durable queued/running jobs after restarts.
const recovery = setInterval(() => {
  void fetch("http://127.0.0.1:8787/cdn-cgi/local/scheduled").catch(() => {});
}, 30000);
function stop() {
  clearInterval(recovery);
  api.kill();
  app.kill();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([api.exited, app.exited]);
stop();
