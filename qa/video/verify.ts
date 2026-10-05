// Independent check of the composed output: ffprobe every video, a frame sheet per scenario at its key steps
// (from the manifest step timeline), and freeze/black detection on every clip.
//   bun qa/video/verify.ts            → qa/out/verify/{probe.json, sheets/<ID>.png, frames/<ID>-<n>.png}
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OUT } from "./env";
import { readManifest } from "./manifest";

const CARD = 5; // scenario title card seconds in a segment (compose.ts CARD_SECONDS.scenario)
const run = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}\n${err}`);
  return out + err;
};
const probe = async (file: string) => {
  const j = JSON.parse(await run(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,width,height,r_frame_rate,nb_frames", "-of", "json", file]));
  const v = j.streams[0];
  return { file: file.replace(`${OUT}/`, "qa/out/"), codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate, seconds: +(+j.format.duration).toFixed(1) };
};

const m = await readManifest();
const dir = resolve(OUT, "verify");
for (const d of ["sheets", "frames"]) await mkdir(resolve(dir, d), { recursive: true });
const videos = [...Object.values(m.videos?.chapters ?? {}), m.videos?.full].filter(Boolean).map((v) => resolve(OUT, v!));
const report: any = { videos: await Promise.all(videos.map(probe)), scenarios: {} };

for (const ch of Object.values(m.chapters).filter((c) => !c.optional).sort((a, b) => a.id.localeCompare(b.id)))
  for (const id of ch.scenarios) {
    const s = m.scenarios[id]!;
    const seg = resolve(OUT, "segments", `${id}.mp4`), clip = resolve(OUT, "segments", `${id}.clip.mp4`);
    const segInfo = await probe(seg);
    // Key steps: first, middle and last step, each ~2 s in (or 80% of the way to the next step); plus the final frame.
    const steps = s.steps;
    const pick = [...new Set([0, Math.floor((steps.length - 1) / 2), steps.length - 1])].filter((i) => i >= 0 && i < steps.length);
    const shots = pick.map((i) => {
      const next = steps[i + 1]?.at ?? s.durationMs;
      const t = CARD + steps[i]!.at / 1000 + Math.min(2.5, Math.max(0.3, ((next - steps[i]!.at) / 1000) * 0.8));
      return { label: `step ${i + 1}`, caption: steps[i]!.caption, t: Math.min(t, segInfo.seconds - 0.4) };
    });
    shots.push({ label: "end", caption: "(final frame)", t: segInfo.seconds - 0.3 });
    const files: string[] = [];
    for (const [n, sh] of shots.entries()) {
      const f = resolve(dir, "frames", `${id}-${n + 1}.png`);
      await run(["ffmpeg", "-nostdin", "-y", "-v", "error", "-ss", sh.t.toFixed(2), "-i", seg, "-frames:v", "1", f]);
      files.push(f);
    }
    while (files.length < 4) files.push(files[files.length - 1]!);
    await run(["ffmpeg", "-nostdin", "-y", "-v", "error", ...files.flatMap((f) => ["-i", f]), "-filter_complex",
      "[0][1][2][3]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0,scale=1920:-1", "-frames:v", "1", resolve(dir, "sheets", `${id}.png`)]);
    // Frozen (>= 10 s identical) or black (>= 1 s) stretches inside the recorded clip.
    const det = await run(["ffmpeg", "-nostdin", "-v", "info", "-i", clip, "-vf", "freezedetect=n=0.001:d=10,blackdetect=d=1:pix_th=0.05", "-an", "-f", "null", "-"]);
    const freezes = [...det.matchAll(/freeze_duration: ([\d.]+)/g)].map((x) => +x[1]!);
    const blacks = [...det.matchAll(/black_duration:([\d.]+)/g)].map((x) => +x[1]!);
    report.scenarios[id] = { chapter: ch.id, status: s.status, segment: segInfo, shots, freezes, blacks };
    console.log(`${id.padEnd(7)} ${s.status.padEnd(6)} ${segInfo.seconds}s  freezes:${freezes.join(",") || "-"}  black:${blacks.join(",") || "-"}`);
  }
await Bun.write(resolve(dir, "probe.json"), JSON.stringify(report, null, 2));
for (const v of report.videos) console.log(`${v.file}  ${v.codec} ${v.width}x${v.height} ${v.fps}  ${v.seconds}s`);
