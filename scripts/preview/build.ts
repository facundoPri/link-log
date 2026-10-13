// Runs ONLY in the credential-free build job. PR build scripts/dependencies are executable code.
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { config, WRANGLER_VERSION } from "./model";
import { required } from "./github";

const source = resolve(process.argv[2] || "source");
const output = resolve(process.argv[3] || "artifact");
const wrangler = required("WRANGLER_BIN");
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: source, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build failed: ${args[0]}`);
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await run([process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"]);
// Dependency-provided bun shims have no postinstall in CI; retain the setup-bun runtime.
await run([process.execPath, "run", "--bun", "build"]);
const cfg = config("1", "1", "00000000-0000-0000-0000-000000000001", "offline", "preview@example.com");
const buildConfig = { ...cfg, main: `${source}/worker/index.ts`, no_bundle: false,
  assets: { ...cfg.assets, directory: `${source}/dist` },
  d1_databases: cfg.d1_databases.map(db => ({ ...db, migrations_dir: `${source}/migrations` })),
};
await Bun.write(`${output}/build.json`, JSON.stringify(buildConfig));
await run([wrangler, "deploy", "--config", `${output}/build.json`, "--dry-run", "--outdir", `${output}/worker`]);
// Fail closed if the application starts requiring additional bundle modules: update this
// artifact contract deliberately instead of silently shipping an incomplete Worker.
for (const name of await readdir(`${output}/worker`)) {
  if (!["index.js", "index.js.map", "README.md"].includes(name)) throw new Error(`Unexpected bundle module: ${name}`);
}
await cp(`${source}/dist`, `${output}/dist`, { recursive: true });
await cp(`${source}/migrations`, `${output}/migrations`, { recursive: true });
await Bun.write(`${output}/manifest.json`, JSON.stringify({ sha: required("PREVIEW_SHA"), wrangler: WRANGLER_VERSION }));
await rm(`${output}/build.json`);
