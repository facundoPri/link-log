// Runs every example in docs/upload-api.md against a running verify-linklog instance and compares
// the response with the one the doc shows. Rerunnable: each run uses fresh API keys and rewrites
// `example.com` to a run-unique host in both the command and the expected response.
//
//   bun .agents/skills/verify-linklog/scripts/verify.ts up
//   bun scripts/check-upload-api-docs.ts [--run <verify run dir>] [--out <file>]
//
// Doc format: `<!-- example: name -->`, then a ```sh block, then "Response `status`", then the
// expected body in the next fenced block. `"<id>"` matches any non-empty string. For a 429 the
// block holds a `Retry-After: n` line (any whole number of seconds from 1 to 60 passes) and the body.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string) => args[args.indexOf(name) + 1];
const root = resolve(dirname(import.meta.path), "..");
const runDir = args.includes("--run") ? resolve(opt("--run")!) : resolve(root, readFileSync(join(root, ".cache/verify-linklog/current"), "utf8").trim());
const session = JSON.parse(readFileSync(join(runDir, "session.json"), "utf8"));
const ui: string = session.ui;
const cookie: string = session.accounts[0].cookie;
const host = `r${Date.now().toString(36)}.example.com`;
const lines: string[] = [];
const log = (line = "") => {
  lines.push(line);
  console.log(line);
};

const send = async (method: string, path: string, body: unknown = {}) => {
  const r = await fetch(`${ui}/api${path}`, { method, headers: { Cookie: cookie, Origin: ui, "Content-Type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}`);
  return r.json() as Promise<any>;
};
const newKey = async (label: string) => (await send("POST", "/api-keys", { name: `docs ${label} ${Date.now() % 100000}` })).secret as string;

const doc = readFileSync(join(root, "docs/upload-api.md"), "utf8").replaceAll("example.com", host);
const examples = [...doc.matchAll(/<!-- example: ([\w-]+) -->\n```sh\n([\s\S]*?)\n```\n\nResponse `(\d+)`[^\n]*\n\n```\w*\n([\s\S]*?)\n```/g)].map((m) => ({ name: m[1]!, command: m[2]!, status: Number(m[3]), expected: m[4]! }));
if (!examples.length) throw new Error("no examples found in docs/upload-api.md");

const matches = (expected: unknown, actual: unknown): boolean => {
  if (expected === "<id>") return typeof actual === "string" && actual.length > 0;
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => matches(e, actual[i]));
  if (expected && typeof expected === "object") {
    const keys = Object.keys(expected);
    return !!actual && typeof actual === "object" && keys.length === Object.keys(actual).length && keys.every((k) => k in actual && matches((expected as any)[k], (actual as any)[k]));
  }
  return expected === actual;
};

const run = async (command: string, key: string) => {
  const p = Bun.spawn(["sh", "-c", command], { env: { ...process.env, LINKLOG_URL: ui, LINKLOG_KEY: key }, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
};

let failed = 0;
const key = await newKey("main");
for (const ex of examples) {
  const exKey = ex.name === "rate-limited" ? await newKey("limit") : key;
  if (ex.name === "rate-limited")
    for (let i = 0; i < 60; i++)
      await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { Authorization: `Bearer ${exKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ urls: [`https://${host}/burst-${i}`] }) });
  const out = await run(ex.command, exKey);
  let problem = "";
  let actual: any;
  if (ex.status === 429) {
    const status = Number(/^HTTP\/\S+ (\d+)/.exec(out)?.[1]);
    const retry = Number(/^retry-after: (\d+)\s*$/im.exec(out)?.[1]);
    const body = out.slice(out.indexOf("\r\n\r\n") + 4);
    const expectedBody = ex.expected.split("\n").filter((l) => !/^Retry-After:/.test(l)).join("\n");
    try {
      actual = JSON.parse(body);
    } catch {
      problem = "body is not JSON";
    }
    if (!problem && (status !== 429 || !(retry >= 1 && retry <= 60) || !matches(JSON.parse(expectedBody), actual))) problem = `status ${status}, Retry-After ${retry}`;
    actual = { status, retryAfter: retry, body: actual };
  } else {
    try {
      actual = JSON.parse(out);
    } catch {
      problem = "body is not JSON";
    }
    if (!problem && !matches(JSON.parse(ex.expected), actual)) problem = "response differs from the doc";
  }
  if (ex.name === "too-many") {
    const lib = await send("GET", "/library");
    if (lib.links.some((l: any) => l.original_url?.includes("/many-"))) problem ||= "the 400 saved links";
  }
  log(`## ${ex.name} (documented ${ex.status}) ${problem ? "FAIL: " + problem : "PASS"}`);
  log("$ " + ex.command.replace(/\n\s*/g, " "));
  log(JSON.stringify(actual, null, 2));
  log();
  if (problem) failed++;
}

// The doc says a revoked key is a 401 too.
const revokedKey = await newKey("revoked");
const keys = (await send("GET", "/api-keys")) as any;
const id = keys.apiKeys.find((k: any) => revokedKey.startsWith(k.prefix))?.id;
await send("POST", `/api-keys/${id}/revoke`);
const revoked = await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { Authorization: `Bearer ${revokedKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ urls: [`https://${host}/a`] }) });
const revokedBody = (await revoked.json()) as { error?: string };
const revokedOk = revoked.status === 401 && revokedBody.error === "A valid API key is required.";
log(`## revoked key (documented 401) ${revokedOk ? "PASS" : "FAIL"}`);
log(JSON.stringify({ status: revoked.status, body: revokedBody }, null, 2));
if (!revokedOk) failed++;

log(`\n${examples.length + 1 - failed}/${examples.length + 1} examples match the doc`);
if (args.includes("--out")) writeFileSync(resolve(opt("--out")!), lines.join("\n") + "\n");
process.exit(failed ? 1 : 0);
