// Composer: title cards (HTML rendered by Chromium) + recorded clips → one MP4 per chapter and one full video.
// Reads qa/out/manifest.json, so it can run on its own after any recording: `bun qa/video/compose.ts`.
//   chapter video = chapter intro card, then per scenario (title card + clip), then outro (pass/fail)
//   full video    = full intro card, every chapter's segments, full outro
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Browser } from "playwright-core";
import { OUT } from "./env";
import { readManifest, writeManifest, type Manifest, type ScenarioResult } from "./manifest";
import { launchBrowser, VIEWPORT } from "./recorder";

const FPS = 30;
const CARD_SECONDS = { intro: 6, scenario: 5, outro: 6 };
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
  .box.covers b { color: #93c5fd; }
  table { border-collapse: collapse; width: 100%; font-size: 21px; }
  td { padding: 11px 14px; border-bottom: 1px solid rgba(255,255,255,.08); vertical-align: top; }
  td.sid { font-weight: 800; white-space: nowrap; width: 1%; } td.n { color: #9aa4b8; white-space: nowrap; width: 1%; text-align: right; }
  .pill { display: inline-block; font-size: 16px; font-weight: 800; padding: 5px 12px; border-radius: 999px; white-space: nowrap; }
  .pill.passed { background: #15803d; } .pill.failed { background: #b91c1c; }
  .total { font-size: 30px; font-weight: 800; } .err { color: #fca5a5; font-size: 16px; display: block; margin-top: 4px; }
  </style></head><body>${body}</body></html>`;
}

function introCard(title: string, kicker: string, summary: string[], scenarios: ScenarioResult[]) {
  return page(`<div class="kicker">${esc(kicker)}</div><h1>${esc(title)}</h1><div class="meta">${esc(PR_LINE)}</div>
  ${summary.length ? `<h2>What we'll see</h2><ul>${summary.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
  <h2>Scenarios</h2><table>${scenarios.map((s) => `<tr><td class="sid">${esc(s.id)}</td><td>${esc(s.title)}</td><td class="n">${esc(s.ticket)}</td></tr>`).join("")}</table>`);
}
function scenarioCard(s: ScenarioResult) {
  return page(`<div class="kicker">${esc(s.ticket)} · chapter ${esc(s.chapter)}</div>
  <h1><span class="id">${esc(s.id)}</span>${esc(s.title)}</h1>
  ${s.covers ? `<div class="box covers"><b>Covers</b>${esc(s.covers)}</div>` : ""}
  <div class="box"><b>Expected result</b>${esc(s.expected || "—")}</div>
  <div class="meta">${s.assertions.length} automated checks · recorded ${esc(s.startedAt.slice(0, 16).replace("T", " "))} UTC ${pill(s.status)}</div>`);
}
function outroCard(title: string, scenarios: ScenarioResult[]) {
  const passed = scenarios.filter((s) => s.status === "passed").length;
  return page(`<div class="kicker">Summary</div><h1>${esc(title)}</h1>
  <div class="total">${passed} of ${scenarios.length} scenarios passed</div>
  <table>${scenarios.map((s) => `<tr><td class="sid">${esc(s.id)}</td><td>${esc(s.title)}${s.error ? `<span class="err">${esc(s.error)}</span>` : ""}</td>
  <td class="n">${s.assertions.filter((a) => a.ok).length}/${s.assertions.length} checks</td><td class="n">${pill(s.status)}</td></tr>`).join("")}</table>`);
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
  const chapterParts: string[] = [];
  const all: ScenarioResult[] = [];
  try {
    for (const ch of Object.values(m.chapters)) {
      const scs = ch.scenarios.map((id) => m.scenarios[id]).filter((s): s is ScenarioResult => !!s);
      if (!scs.length) continue;
      all.push(...scs);
      const intro = await cardVideo(browser, introCard(ch.title, `Chapter ${ch.id} · ${ch.ticket}`, ch.summary, scs), `chapter-${ch.id}-intro`, CARD_SECONDS.intro);
      const parts = [intro];
      for (const s of scs) {
        const segment = [await cardVideo(browser, scenarioCard(s), `scenario-${s.id}`, CARD_SECONDS.scenario), await clipVideo(s)];
        parts.push(...segment);
        const seg = resolve(OUT, "segments", `${s.id}.mp4`);
        await concat(segment, seg);
        s.segment = `segments/${s.id}.mp4`;
      }
      chapterParts.push(...parts.slice());
      const outro = await cardVideo(browser, outroCard(`${ch.title}: results`, scs), `chapter-${ch.id}-outro`, CARD_SECONDS.outro);
      parts.push(outro);
      if (only && !only.includes(ch.id)) continue;
      const out = resolve(OUT, "videos", `chapter-${ch.id}.mp4`);
      await concat(parts, out);
      videos.chapters[ch.id] = `videos/chapter-${ch.id}.mp4`;
      console.log(`  chapter ${ch.id} → qa/out/${videos.chapters[ch.id]}`);
    }
    if (all.length) {
      const intro = await cardVideo(browser, introCard("FAC-48 · QA walkthrough", "Full video", Object.values(m.chapters).map((c) => `${c.id}: ${c.title}`), all), "full-intro", CARD_SECONDS.intro);
      const outro = await cardVideo(browser, outroCard("All scenarios", all), "full-outro", CARD_SECONDS.outro);
      await concat([intro, ...chapterParts, outro], resolve(OUT, "videos", "full.mp4"));
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

if (import.meta.main) await compose(process.argv.slice(2).filter((a) => !a.startsWith("-")));
