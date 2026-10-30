// PROTOTYPE (FAC-45), throwaway. Starts an isolated verify-linklog instance (fixture sites, no real network, no
// billing), seeds Demo A with a mixed library, and prints the three variant URLs. Stop it with `V down`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureUrl, type FixtureName } from "../qa/video/fixtures";
type Session = { ui: string; accounts: { email: string; password: string; cookie: string }[] };

const ROOT = resolve(import.meta.dir, "..");
const V = ["bun", ".agents/skills/verify-linklog/scripts/verify.ts"];
const up = Bun.spawnSync([...V, "up"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (up.exitCode) process.exit(up.exitCode);

const runDir = resolve(ROOT, ".cache/verify-linklog", readFileSync(resolve(ROOT, ".cache/verify-linklog/current"), "utf8").trim().replace(/^\.cache\/verify-linklog\//, ""));
const session: Session = JSON.parse(readFileSync(resolve(runDir, "session.json"), "utf8"));
const demo = session.accounts[0]!;
const send = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${session.ui}/api${path}`, {
    method,
    headers: { Cookie: demo.cookie, Origin: session.ui, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json();
};

for (const name of ["reading", "research", "tools"]) await send("POST", "/tags", { name });
await send("POST", "/lenses", { name: "Worth reading?", type: "noul", question: "Is this worth reading in full?" });
const seed: [FixtureName, string, string[]][] = [
  ["article", "intro-to-bulk-actions", ["reading"]],
  ["article", "command-palettes", ["research"]],
  ["article-yes", "selection-models", []],
  ["article", "design-systems", ["research", "tools"]],
  ["login-wall", "members-only", []],
  ["pdf", "whitepaper.pdf", []],
  ["gone", "deleted-post", []],
  ["nowhere", "typo-domain", []],
  ["article", "progress-patterns", ["reading"]],
  ["browser-empty", "empty-page", []],
  ["article", "undo-vs-confirm", []],
  ["file", "slides.pdf", ["tools"]],
];
for (const [fixture, path, tags] of seed) await send("POST", "/links", { url: fixtureUrl(fixture, path), tags });

console.log(`\nPROTOTYPE FAC-45 seeded ${seed.length} links for ${demo.email} / ${demo.password}`);
for (const v of ["D", "A", "B", "C"]) console.log(`  ${session.ui}/?variant=${v}`);
console.log(`Stop: ${V.join(" ")} down`);
