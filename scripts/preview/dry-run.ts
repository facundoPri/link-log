// Offline verification: bundle both sides of the artifact boundary and apply migrations
// to disposable local D1. Does not build/overwrite the dist served by an active local demo.
import { cp, mkdtemp, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { config } from "./model";

const root = resolve(import.meta.dir, "../..");
const out = await mkdtemp(`${tmpdir()}/linklog-preview-offline-`);
const wrangler = `${root}/node_modules/.bin/wrangler`;
const cfg = config("12345", "5", "00000000-0000-0000-0000-000000000001", "offline", "auth@example.com");
// The build needs a non-empty asset directory, not the user's running frontend.
await mkdir(`${out}/dist`);
await Bun.write(`${out}/dist/index.html`, "<!doctype html><title>Offline bundle check</title>");
await cp(`${root}/migrations`, `${out}/migrations`, { recursive: true });
await Bun.write(`${out}/build.json`, JSON.stringify({ ...cfg, main: `${root}/worker/index.ts`, no_bundle: false }));
async function run(args: string[]) {
  const child = Bun.spawn([wrangler, ...args], { cwd: out, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    env: { PATH: process.env.PATH!, XDG_CONFIG_HOME: out, CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: `${out}/logs` } });
  if (await child.exited !== 0) throw new Error(`Offline Wrangler ${args[0]} failed`);
}
await run(["deploy", "--config", `${out}/build.json`, "--dry-run", "--outdir", `${out}/worker`]);
for (const entry of await readdir(`${out}/worker`)) {
  if (!["index.js", "index.js.map", "README.md"].includes(entry)) throw new Error(`Unexpected bundled module ${entry}`);
}
await Bun.write(`${out}/wrangler.json`, JSON.stringify(cfg));
await run(["deploy", "--config", `${out}/wrangler.json`, "--dry-run", "--no-bundle"]);
await run(["d1", "migrations", "apply", "DB", "--config", `${out}/wrangler.json`, "--local", "--persist-to", `${out}/state`]);
console.log(`Offline bundle and local migrations verified: ${out}`);
