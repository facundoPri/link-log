// Composer: title cards (HTML rendered by Chromium) + recorded clips → one MP4 per chapter and one full video.
// Reads qa/out/manifest.json, so it can run on its own after any recording: `bun qa/video/compose.ts`.
//   chapter video = chapter intro card, then per scenario (title card + clip), then outro (pass/fail)
//   full video    = PR card, coverage card, caption-bar legend, every non-optional chapter video (ch1…ch6),
//                   then results by chapter and the possible product bugs (story.ts)
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser } from "playwright-core";
import { OUT } from "./env";
import { readManifest, writeManifest, type Manifest, type ScenarioResult } from "./manifest";
import { launchBrowser, VIEWPORT } from "./recorder";
import { BAR_HEIGHT } from "./overlay";
import { CHAPTER_LINES, FINDINGS, PR } from "./story";

const FPS = 30;
const CARD_SECONDS = { intro: 6, scenario: 5, outro: 6, pr: 8, coverage: 12, legend: 14, results: 12, findings: 16 };
const ENCODE = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-an"];
export const PR_LINE = process.env.QA_PR ?? "Linklog · branch facundoPri/fac-48-needs-attention · FAC-48 (+ FAC-52…57)";

async function ffmpeg(args: string[]) {
  const p = Bun.spawn(["ffmpeg", "-nostdin", "-y", "-hide_banner", "-loglevel", "error", ...args], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${err}`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pill = (status?: string) =>
  status ? `<span class="pill ${status}">${status === "passed" ? "✓ PASSED" : "✗ FAILED"}</span>` : "";

function page(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${VIEWPORT.width}px; height: ${VIEWPORT.height}px; background: radial-gradient(1200px 700px at 15% 0%, #1e3a8a 0%, #0b1020 60%); color: #e8ecf4;
    font: 22px/1.4 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif; padding: 84px 104px; display: flex; flex-direction: column; gap: 26px; }
  .kicker { font-size: 18px; letter-spacing: .14em; text-transform: uppercase; color: #93c5fd; font-weight: 700; }
  h1 { font-size: 58px; line-height: 1.08; font-weight: 800; letter-spacing: -.02em; }
  h2 { font-size: 20px; letter-spacing: .1em; text-transform: uppercase; color: #9aa4b8; font-weight: 700; margin-top: 8px; }
  .id { display: inline-block; font-size: 26px; font-weight: 800; background: #1d4ed8; padding: 6px 16px; border-radius: 10px; margin-right: 14px; }
  .meta { color: #9aa4b8; font-size: 20px; }
  ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  li { padding-left: 28px; position: relative; } li::before { content: "›"; position: absolute; left: 4px; color: #60a5fa; font-weight: 800; }
  .box { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 16px; padding: 22px 28px; }
  .box b { display: block; font-size: 15px; letter-spacing: .12em; text-transform: uppercase; color: #86efac; margin-bottom: 6px; }
  .box.covers b { color: #93c5fd; } .box.failed { border-color: rgba(239,68,68,.5); background: rgba(185,28,28,.15); } .box.failed b { color: #fca5a5; }
  table { border-collapse: collapse; width: 100%; font-size: 21px; }
  td { padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
  td.sid { font-weight: 800; white-space: nowrap; width: 1%; } td.n { color: #9aa4b8; white-space: nowrap; width: 1%; text-align: right; }
  .pill { display: inline-block; color: #fff; font-size: 16px; font-weight: 800; padding: 5px 12px; border-radius: 999px; white-space: nowrap; }
  .pill.passed { background: #15803d; } .pill.failed { background: #b91c1c; }
  .sub { display: block; color: #aab4c8; font-size: 17px; margin-top: 3px; } code { font-size: .95em; color: #bfdbfe; }
  .tag { display: inline-block; color: #fff; font-size: 14px; font-weight: 800; padding: 3px 9px; border-radius: 7px; margin: 3px 2px 0 0; background: #334155; }
  .tag.passed { background: #15803d; } .tag.failed { background: #b91c1c; }
  table.findings td { padding: 9px 14px; } table.findings .sub { font-size: 16px; }
  .legend { display: grid; grid-template-columns: 1fr 470px; gap: 30px; align-items: start; }
  .callouts { display: flex; flex-direction: column; gap: 10px; font-size: 19px; } .callouts b { margin-right: 8px; }
  .callouts .n, .bar .n { display: inline-flex; width: 28px; height: 28px; border-radius: 50%; background: #f59e0b; color: #0b1020; font-weight: 800; font-size: 16px; align-items: center; justify-content: center; margin-right: 10px; } .bar .n { width: 20px; height: 20px; font-size: 12px; margin-right: 6px; vertical-align: middle; }
  .chips { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .chip { font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; padding: 9px 13px; border-radius: 999px; }
  .chip.ok { background: #15803d; } .chip.bad { background: #b91c1c; } .chip.wait { background: #1e293b; border: 1px solid #334155; }
  .bar { height: ${BAR_HEIGHT}px; display: grid; grid-template-columns: 250px 1fr 430px; gap: 22px; align-items: center; padding: 0 22px; background: #0b1020;
    border-top: 3px solid #3b82f6; font-size: 15px; line-height: 1.3; border-radius: 6px; margin-top: -14px; }
  .bar.passed { border-top-color: #22c55e; } .bar.failed { border-top-color: #ef4444; }
  .bar .bid { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .bar .badge { align-self: flex-start; font-weight: 700; font-size: 13px; padding: 3px 9px; border-radius: 6px; background: #1d4ed8; }
  .bar.passed .badge { background: #15803d; } .bar.failed .badge { background: #b91c1c; }
  .bar .btitle { font-size: 12.5px; color: #9aa4b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .bstep { font-size: 19px; font-weight: 600; } .bar .bstep b { color: #60a5fa; margin-right: 8px; }
  .bar .bexp { font-size: 14px; color: #bbf7d0; border-left: 2px solid #334155; padding-left: 16px; }
  .bar .bexp i { font-style: normal; color: #86efac; font-weight: 700; display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
  .total { font-size: 30px; font-weight: 800; } .err { color: #fca5a5; font-size: 16px; display: block; margin-top: 4px; }
  </style></head><body>${body}</body></html>`;
}

function introCard(title: string, kicker: string, summary: string[], scenarios: ScenarioResult[]) {
  return page(`<div class="kicker">${esc(kicker)}</div><h1>${esc(title)}</h1><div class="meta">${esc(PR_LINE)}</div>
  ${summary.length ? `<h2>What we'll see</h2><ul>${summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
  <h2>Scenarios</h2><table>${scenarios.map((s) => `<tr><td class="sid">${esc(s.id)}</td><td>${esc(s.title)}</td><td class="n">${esc(s.ticket)}</td></tr>`).join("")}</table>`);
}
export function scenarioCard(s: ScenarioResult) {
  return page(`<div class="kicker">${esc(s.ticket)} · chapter ${esc(s.chapter)}</div>
  <h1><span class="id">${esc(s.id)}</span>${esc(s.title)}</h1>
  ${s.covers ? `<div class="box covers"><b>Covers</b>${esc(s.covers)}</div>` : ""}
  <div class="box"><b>Expected result</b>${esc(s.expected || "—")}</div>
  ${s.status === "failed" && s.error ? `<div class="box failed"><b>Failed check (product differs from the plan)</b>${esc(s.error)}</div>` : ""}
  <div class="meta">${s.assertions.length} automated checks · recorded ${esc(s.startedAt.slice(0, 16).replace("T", " "))} UTC ${pill(s.status)}</div>`);
}
function outroCard(title: string, scenarios: ScenarioResult[]) {
  const passed = scenarios.filter((s) => s.status === "passed").length;
  return page(`<div class="kicker">Summary</div><h1>${esc(title)}</h1>
  <div class="total">${passed} of ${scenarios.length} scenarios passed</div>
  <table>${scenarios.map((s) => `<tr><td class="sid">${esc(s.id)}</td><td>${esc(s.title)}${s.error ? `<span class="err">${esc(s.error)}</span>` : ""}</td>
  <td class="n">${s.assertions.filter((a) => a.ok).length}/${s.assertions.length} checks</td><td class="n">${pill(s.status)}</td></tr>`).join("")}</table>`);
}


// Full video only: the PR, what the video covers, how to read the caption bar, results by chapter, findings.
export function prCard() {
  return page(`<div class="kicker">QA walkthrough · Linklog pull request</div><h1>${esc(PR.title)}</h1>
  <div class="meta">branch <code>${esc(PR.branch)}</code></div>
  <table>${PR.tickets.map(([id, t]) => `<tr><td class="sid">${esc(id)}</td><td>${esc(t)}</td></tr>`).join("")}</table>
  <div class="meta">Recorded against the real UI and Worker, isolated local stack, deterministic fixtures, no paid calls. Every caption is backed by an automated check.</div>`);
}
export function coverageCard(chapters: { id: string; title: string; ticket: string; n: number }[]) {
  return page(`<div class="kicker">What this video covers</div><h1>${chapters.length} chapters, ${chapters.reduce((a, c) => a + c.n, 0)} scenarios</h1>
  <table>${chapters.map((c, i) => `<tr><td class="sid">${i + 1}</td><td><b>${esc(c.title)}</b> <span class="meta">· ${esc(c.ticket)} · ${c.n} scenarios</span><span class="sub">${esc(CHAPTER_LINES[c.id] ?? "")}</span></td></tr>`).join("")}</table>
  <div class="meta">Each chapter: intro → per scenario a title card (ID, ticket, what it covers, expected result) and the recording → results. The video ends with all results and the possible product bugs.</div>`);
}
export function legendCard() {
  const bar = (status: "running" | "passed" | "failed", badge: string, step: string, exp: string, marks = false) => {
    const n = (k: number) => (marks ? `<span class="n">${k}</span>` : "");
    return `<div class="bar ${status}"><div class="bid"><span class="badge">${n(1)}${badge}</span><span class="btitle">${badge.slice(0, 5)}: plan cases and scenario title</span></div>
  <div class="bstep">${n(2)}<b>3.</b>${step}</div><div class="bexp"><i>${n(3)}Expected</i>${exp}</div></div>`;
  };
  return page(`<div class="kicker">How to read the recordings</div><h1>The caption bar</h1>
  <div class="legend">
    <div class="callouts"><div><span class="n">1</span><b>Scenario ID and status</b>RUNNING while it plays, then <span class="pill passed">PASSED</span> or <span class="pill failed">FAILED</span>; the title under it names the plan cases</div>
    <div><span class="n">2</span><b>Current step</b>what we do now, numbered</div>
    <div><span class="n">3</span><b>Expected result</b>what must happen for this step to pass</div>
    <div><span class="n">4</span><b>Check chips</b>top right: one per automated check (UI text or API state). Green passed, red failed, dark = a timed wait or hold</div>
    <div><span class="n">5</span><b>Cursor</b>a drawn pointer glides to each target; a blue ripple marks the click</div></div>
    <div class="chips"><span class="chip ok">✓ API: attempt 2 of 3, reason site_error</span><span class="chip ok">✓ Never in Needs attention while running</span><span class="chip wait">⏱ holds 12 s</span><span class="chip bad">✗ Toast: Cancelled 3 queued jobs</span></div>
  </div>
  ${bar("running", "NA-07 · RUNNING", "Open Activity while the preview is retried", "“Attempt 2 of 3 · Waiting to retry” with the previous reason", true)}
  ${bar("passed", "NA-07 · PASSED", "The job ends: the link enters Needs attention", "“Couldn't get the preview: The site had a problem.”")}
  ${bar("failed", "NA-04 · FAILED", "Cancel the import from Activity", "“Cancelled 3 queued jobs” — the bar turns red and shows the failed check")}
  <div class="meta">A FAILED scenario is kept as filmed: the product behaved differently from the plan, and the clip stops at the first failed check.</div>`);
}
export function resultsCard(chapters: { title: string; scenarios: ScenarioResult[] }[]) {
  const all = chapters.flatMap((c) => c.scenarios), passed = all.filter((s) => s.status === "passed").length;
  return page(`<div class="kicker">Results</div><h1>${passed} of ${all.length} scenarios passed</h1>
  <table>${chapters.map((c) => `<tr><td><b>${esc(c.title)}</b><span class="sub">${c.scenarios.map((s) => `<span class="tag ${s.status}">${esc(s.id)}</span>`).join(" ")}</span></td>
  <td class="n">${c.scenarios.filter((s) => s.status === "passed").length}/${c.scenarios.length}</td></tr>`).join("")}</table>
  <div class="meta"><span class="tag passed">ID</span> passed · <span class="tag failed">ID</span> failed: the product differs from the plan (see the next card). ${all.reduce((a, s) => a + s.assertions.filter((x) => x.ok).length, 0)}/${all.reduce((a, s) => a + s.assertions.length, 0)} checks passed.</div>`);
}
export function findingsCard(statusOf: (id: string) => string | undefined) {
  return page(`<div class="kicker">Possible product bugs found</div><h1>For triage</h1>
  <table class="findings">${FINDINGS.map((f, i) => `<tr><td class="sid">${i + 1}</td><td><b>${esc(f.title)}</b><span class="sub">${esc(f.detail)}</span></td>
  <td class="n">${f.scenarios.map((id) => `<span class="tag ${statusOf(id) ?? ""}">${esc(id)}</span>`).join(" ")}</td></tr>`).join("")}</table>
  <div class="meta">Evidence and plan corrections: planning/qa/fac-48-video-qa-summary.md</div>`);
}

async function cardVideo(browser: Browser, html: string, name: string, seconds: number) {
  const png = resolve(OUT, "cards", `${name}.png`), mp4 = resolve(OUT, "cards", `${name}.mp4`);
  const p = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await p.setContent(html, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await p.screenshot({ path: png, timeout: 15_000 });
  await p.close();
  await ffmpeg(["-loop", "1", "-framerate", String(FPS), "-t", String(seconds), "-i", png, ...ENCODE, mp4]);
  return mp4;
}
async function clipVideo(s: ScenarioResult) {
  const out = resolve(OUT, "segments", `${s.id}.clip.mp4`);
  await ffmpeg(["-ss", (s.clipOffsetMs / 1000).toFixed(2), "-i", resolve(OUT, s.clip),
    "-vf", `scale=${VIEWPORT.width}:${VIEWPORT.height}:force_original_aspect_ratio=decrease,pad=${VIEWPORT.width}:${VIEWPORT.height}:(ow-iw)/2:(oh-ih)/2,fps=${FPS}`, ...ENCODE, out]);
  return out;
}
async function concat(parts: string[], out: string) {
  const list = `${out}.txt`;
  await writeFile(list, parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"));
  // Re-encoded, not stream-copied: card and clip encodes differ, and a copy can glitch at the joins.
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, ...ENCODE, "-movflags", "+faststart", out]);
}

export async function compose(only?: string[]): Promise<Manifest["videos"]> {
  const m = await readManifest();
  for (const d of ["cards", "segments", "videos"]) await mkdir(resolve(OUT, d), { recursive: true });
  const browser = await launchBrowser();
  const videos: NonNullable<Manifest["videos"]> = { chapters: { ...m.videos?.chapters } };
  const fullParts: string[] = [];
  const fullChapters: { id: string; title: string; ticket: string; scenarios: ScenarioResult[] }[] = [];
  try {
    // Chapter ids sort into the story order (ch1…ch6); optional chapters (the pilot) stay out of the full video.
    for (const ch of Object.values(m.chapters).sort((a, b) => a.id.localeCompare(b.id))) {
      const scs = ch.scenarios.map((id) => m.scenarios[id]).filter((s): s is ScenarioResult => !!s);
      if (!scs.length) continue;
      const intro = await cardVideo(browser, introCard(ch.title, `Chapter ${ch.id} · ${ch.ticket}`, ch.summary, scs), `chapter-${ch.id}-intro`, CARD_SECONDS.intro);
      const parts = [intro];
      for (const s of scs) {
        const segment = [await cardVideo(browser, scenarioCard(s), `scenario-${s.id}`, CARD_SECONDS.scenario), await clipVideo(s)];
        parts.push(...segment);
        const seg = resolve(OUT, "segments", `${s.id}.mp4`);
        await concat(segment, seg);
        s.segment = `segments/${s.id}.mp4`;
      }
      parts.push(await cardVideo(browser, outroCard(`${ch.title}: results`, scs), `chapter-${ch.id}-outro`, CARD_SECONDS.outro));
      if (!ch.optional) {
        fullParts.push(...parts);
        fullChapters.push({ id: ch.id, title: ch.title, ticket: ch.ticket, scenarios: scs });
      }
      if (only && !only.includes(ch.id)) continue;
      const out = resolve(OUT, "videos", `chapter-${ch.id}.mp4`);
      await concat(parts, out);
      videos.chapters[ch.id] = `videos/chapter-${ch.id}.mp4`;
      console.log(`  chapter ${ch.id} → qa/out/${videos.chapters[ch.id]}`);
    }
    if (fullChapters.length) {
      const opening = [
        await cardVideo(browser, prCard(), "full-pr", CARD_SECONDS.pr),
        await cardVideo(browser, coverageCard(fullChapters.map((c) => ({ ...c, n: c.scenarios.length }))), "full-coverage", CARD_SECONDS.coverage),
        await cardVideo(browser, legendCard(), "full-legend", CARD_SECONDS.legend),
      ];
      const closing = [
        await cardVideo(browser, resultsCard(fullChapters), "full-results", CARD_SECONDS.results),
        await cardVideo(browser, findingsCard((id) => m.scenarios[id]?.status), "full-findings", CARD_SECONDS.findings),
      ];
      await concat([...opening, ...fullParts, ...closing], resolve(OUT, "videos", "full.mp4"));
      videos.full = "videos/full.mp4";
      console.log(`  full → qa/out/${videos.full}`);
    }
  } finally {
    await browser.close();
  }
  m.videos = videos;
  await writeManifest(m);
  return videos;
}

if (import.meta.main) {
  // No chapter ids means every chapter (an empty list would skip them all).
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  await compose(ids.length ? ids : undefined);
}
