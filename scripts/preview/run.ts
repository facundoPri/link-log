import { appendFile, lstat, readdir, rm, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { Cloudflare } from "./cloudflare";
import { current, required } from "./github";
import { authSecret, config, names, WRANGLER_VERSION } from "./model";
import { cleanup, resources, settleDeployment } from "./lifecycle";

const repositoryId = required("GITHUB_REPOSITORY_ID");
const pr = required("PR_NUMBER");
const n = names(repositoryId, pr);
const cf = new Cloudflare(required("CLOUDFLARE_ACCOUNT_ID"), required("CLOUDFLARE_API_TOKEN"));
const action = required("PREVIEW_ACTION");
const expectedSha = process.env.PREVIEW_SHA;
const state = await current();
if (action === "cleanup" && state.action === "cleanup") {
  await cleanup(cf, repositoryId, pr);
  console.log(`Removed isolated preview ${n.worker}`);
} else if (action === "deploy" && state.action === "deploy" && state.sha === expectedSha) {
  await deploy();
} else {
  console.log("Superseded event; no cloud mutation.");
}

async function deploy() {
  const artifact = resolve(required("PREVIEW_ARTIFACT"));
  // No code/config/build commands from the PR run in this process. The artifact is data.
  async function inspect(directory: string) {
    for (const entry of await readdir(directory)) {
      const path = `${directory}/${entry}`;
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Unsafe artifact entry");
      if (stat.isDirectory()) await inspect(path);
    }
  }
  await inspect(artifact);
  for (const entry of await readdir(artifact)) {
    if (!["manifest.json", "worker", "dist", "migrations"].includes(entry)) throw new Error("Unexpected artifact root entry");
  }
  for (const entry of await readdir(`${artifact}/worker`)) {
    if (!["index.js", "index.js.map", "README.md"].includes(entry)) throw new Error("Unexpected Worker module");
  }
  for (const entry of await readdir(`${artifact}/migrations`)) {
    if (!/^\d+_[a-z0-9_]+\.sql$/.test(entry) || !(await lstat(`${artifact}/migrations/${entry}`)).isFile()) throw new Error("Unexpected migration entry");
  }
  const manifest = await Bun.file(`${artifact}/manifest.json`).json();
  if (manifest.sha !== expectedSha || manifest.wrangler !== WRANGLER_VERSION) throw new Error("Artifact identity mismatch");
  const subdomain = required("PREVIEW_WORKERS_SUBDOMAIN");
  const sender = required("PREVIEW_EMAIL_FROM");
  const secret = authSecret(required("PREVIEW_AUTH_SEED"), repositoryId, pr);
  // Validate all setup values before provisioning anything.
  config(repositoryId, pr, "00000000-0000-0000-0000-000000000001", subdomain, sender);
  const remoteSubdomain = (await cf.api("/workers/subdomain")).result?.subdomain;
  if (remoteSubdomain !== subdomain) throw new Error("workers.dev subdomain does not match selected account");
  const wrangler = required("WRANGLER_BIN");
  async function run(args: string[]) {
    const child = Bun.spawn([wrangler, ...args], { cwd: artifact, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
    if (await child.exited !== 0) throw new Error(`Wrangler ${args[0]} failed`);
  }
  const { db } = await resources(cf, repositoryId, pr, true);
  const cfg = config(repositoryId, pr, db.uuid, subdomain, sender);
  const configPath = `${artifact}/wrangler.json`;
  // Replace any identically named artifact file; never load PR wrangler config or .env files.
  await Bun.write(configPath, JSON.stringify(cfg, null, 2));
  const secretsPath = resolve(required("RUNNER_TEMP"), `preview-secrets-${n.worker}.json`);
  await Bun.write(secretsPath, JSON.stringify({ BETTER_AUTH_SECRET: secret }));
  await chmod(secretsPath, 0o600);
  try {
    await run(["d1", "migrations", "apply", "DB", "--remote", "--config", configPath]);
    const before = await current();
    if (before.action !== "deploy" || before.sha !== expectedSha) {
      if (before.action === "cleanup") await cleanup(cf, repositoryId, pr);
      console.log("PR changed before deployment; stopped.");
      return;
    }
    await run(["deploy", "--config", configPath, "--no-bundle", "--secrets-file", secretsPath]);
    const after = await current();
    if (!await settleDeployment(cf, repositoryId, pr, after, expectedSha!))
      throw new Error("PR changed during deployment; stale preview disabled or cleaned up");
    const url = cfg.vars.BETTER_AUTH_URL;
    await appendFile(required("GITHUB_STEP_SUMMARY"), `Preview: ${url}\n\nCommit: ${expectedSha}\n\nHosted email and extraction still require an end-to-end smoke test.\n`);
    console.log(`Preview deployed: ${url}`);
  } finally {
    await rm(secretsPath, { force: true });
  }
}
