// What production ships: the Worker bundle and the built SPA contain no Test Utils, fixtures or
// local-only credentials, and the SPA build refuses the demo fixture variable.
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORBIDDEN = ["testUtils", "test-utils", "demo-a@linklog.test", "linklog-demo-a-password", "BUN_PUBLIC_LINKLOG_DEV_FIXTURES"];
let workerCode = "";

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "linklog-bundle-"));
  const build = Bun.spawnSync(["bunx", "wrangler", "deploy", "--dry-run", "--outdir", out], { stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  workerCode = readdirSync(out).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(out, f), "utf8")).join("\n");
  rmSync(out, { recursive: true, force: true });
}, 120000);

test("the Worker bundle has auth but no test helpers or fixtures", () => {
  expect(workerCode).toContain("/sign-in/magic-link");
  for (const needle of FORBIDDEN) expect([needle, workerCode.includes(needle)]).toEqual([needle, false]);
});

test("the SPA build refuses demo fixtures and ships none", () => {
  const refused = Bun.spawnSync(["bun", "scripts/build.ts"], { env: { ...process.env, BUN_PUBLIC_LINKLOG_DEV_FIXTURES: "[]" }, stderr: "pipe" });
  expect(refused.exitCode).toBe(1);
  const built = Bun.spawnSync(["bun", "scripts/build.ts"], { env: { ...process.env, BUN_PUBLIC_LINKLOG_DEV_FIXTURES: "" } });
  expect(built.exitCode).toBe(0);
  const assets = readdirSync("dist").filter((f) => f.endsWith(".js")).map((f) => readFileSync(join("dist", f), "utf8")).join("\n");
  for (const needle of ["demo-a@linklog.test", "linklog-demo-a-password", "testUtils"]) expect([needle, assets.includes(needle)]).toEqual([needle, false]);
}, 120000);
