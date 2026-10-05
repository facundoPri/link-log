// Records scenarios and composes the videos.
//   bun qa/video/run.ts                      every chapter, then compose
//   bun qa/video/run.ts --chapter pilot      one chapter (comma-separated for several)
//   bun qa/video/run.ts --scenario P1        one scenario (comma-separated for several)
//   bun qa/video/run.ts --list               list chapters and scenarios
//   --no-compose                             record only (compose later: bun qa/video/compose.ts)
// Exit code 1 when any recorded scenario failed.
import { resolve } from "node:path";
import { envKey, startEnv, type QaEnv } from "./env";
import { launchBrowser, record, type Chapter } from "./recorder";
import { compose } from "./compose";
import type { ScenarioResult } from "./manifest";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]?.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
};

async function loadChapters(): Promise<Chapter[]> {
  const dir = resolve(import.meta.dir, "chapters");
  const files = (await Array.fromAsync(new Bun.Glob("*.ts").scan(dir))).sort();
  return Promise.all(files.map(async (f) => (await import(resolve(dir, f))).default as Chapter));
}

/** Empties the library between scenarios so each clip starts clean: resets settings, cancels leftovers, deletes every link. */
async function resetLibrary(env: QaEnv) {
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${env.ui}/api${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json() as Promise<any>);
  // Settings are library-wide and survive link deletion: put them back to the product default (FAC-56 fallback off).
  await call("PUT", "/settings", { preview_fallback: false }).catch(() => {});
  for (let round = 0; round < 60; round++) {
    const lib = await call("GET", "/library");
    if (!lib.links.length) return;
    for (const b of lib.batches.filter((b: any) => b.active > 0)) {
      const detail = await call("GET", `/batches/${b.id}`);
      for (const j of detail.jobs ?? []) if (["queued", "running", "waiting"].includes(j.status)) await call("DELETE", `/jobs/${j.id}`, {}).catch(() => {}); // the API wants a JSON body on writes (415 otherwise)
    }
    for (const l of lib.links) if (!l.processing) await call("DELETE", `/links/${l.id}`, {}).catch(() => {});
    await Bun.sleep(1000);
  }
  console.warn("  ! could not empty the library; the next clip may show leftovers");
}

const chapters = await loadChapters();
if (args.includes("--list")) {
  for (const c of chapters) {
    console.log(`${c.id} — ${c.title}${c.optional ? " (optional: only with --chapter)" : ""}`);
    for (const s of c.scenarios) console.log(`  ${s.id}  ${s.title}`);
  }
  process.exit(0);
}
const wantChapters = opt("--chapter"), wantScenarios = opt("--scenario");
const selected = chapters
  .filter((c) => (wantChapters ? wantChapters.includes(c.id) : !c.optional))
  .map((c) => ({ ...c, scenarios: c.scenarios.filter((s) => !wantScenarios || wantScenarios.includes(s.id)) }))
  .filter((c) => c.scenarios.length);
if (!selected.length) {
  console.error("No scenarios match. Use --list.");
  process.exit(2);
}

const results: ScenarioResult[] = [];
// Chapters that need the same Worker configuration share one environment.
const groups = new Map<string, Chapter[]>();
for (const c of selected) groups.set(envKey(c.env), [...(groups.get(envKey(c.env)) ?? []), c]);
for (const group of groups.values()) {
  console.log(`\nStarting QA environment ${envKey(group[0]!.env)}`);
  let env = await startEnv(group[0]!.env);
  const browser = await launchBrowser();
  try {
    for (const ch of group)
      for (const sc of ch.scenarios) {
        // A scenario may need another Worker configuration (e.g. Jev without a key): restart, keeping state if asked.
        const want = sc.meta.env ?? ch.env;
        if (envKey(want) !== envKey(env.options)) {
          console.log(`  Restarting QA environment ${envKey(want)}${sc.meta.keepState ? " (keeping state)" : ""}`);
          await env.stop();
          env = await startEnv(want, { keepState: !!sc.meta.keepState });
        }
        if (!sc.meta.keepState) await resetLibrary(env);
        console.log(`  ▶ ${sc.id} ${sc.title}`);
        // The full chapter, not the --scenario subset: the manifest keeps every scenario of the chapter.
        const r = await record(browser, chapters.find((c) => c.id === ch.id)!, sc, env.ui);
        results.push(r);
        console.log(`    ${r.status === "passed" ? "✓" : "✗"} ${r.status} — ${r.assertions.filter((a) => a.ok).length}/${r.assertions.length} checks${r.error ? ` — ${r.error}` : ""}`);
      }
  } finally {
    await browser.close();
    await env.stop();
  }
}
if (!args.includes("--no-compose")) {
  console.log("\nComposing");
  await compose(selected.map((c) => c.id));
}
const failed = results.filter((r) => r.status === "failed");
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed. Manifest: qa/out/manifest.json`);
process.exit(failed.length ? 1 : 0);
