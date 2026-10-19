// qa/out/manifest.json: one entry per recorded scenario (latest run wins) plus the chapters they belong to.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { OUT } from "./env";
import type { Chapter } from "./recorder";

export type ScenarioResult = {
  id: string;
  title: string;
  chapter: string;
  ticket: string;
  covers: string;
  expected: string;
  status: "passed" | "failed";
  error?: string;
  /** Screenshot taken at the failure, relative to qa/out. */
  screenshot?: string;
  assertions: { name: string; ok: boolean; ms: number; error?: string }[];
  /** Step captions with their time in the trimmed clip (ms). */
  steps: { at: number; caption: string; expected: string }[];
  /** Raw recording, relative to qa/out; the composer trims `clipOffsetMs` (blank page before the app loads). */
  clip: string;
  clipOffsetMs: number;
  /** Composed segment (title card + clip), relative to qa/out; set by the composer. */
  segment?: string;
  startedAt: string;
  durationMs: number;
};
export type ChapterInfo = Omit<Chapter, "scenarios" | "env"> & { scenarios: string[] };
export type Manifest = {
  updatedAt: string;
  chapters: Record<string, ChapterInfo>;
  scenarios: Record<string, ScenarioResult>;
  videos?: { chapters: Record<string, string>; full?: string };
};

export const MANIFEST = resolve(OUT, "manifest.json");

export async function readManifest(): Promise<Manifest> {
  const file = Bun.file(MANIFEST);
  return (await file.exists()) ? await file.json() : { updatedAt: new Date().toISOString(), chapters: {}, scenarios: {} };
}
export async function writeManifest(m: Manifest) {
  await mkdir(OUT, { recursive: true });
  m.updatedAt = new Date().toISOString();
  await Bun.write(MANIFEST, JSON.stringify(m, null, 2));
}
export async function updateManifest(ch: Chapter, result: ScenarioResult) {
  const m = await readManifest();
  m.chapters[ch.id] = { id: ch.id, title: ch.title, ticket: ch.ticket, summary: ch.summary, optional: ch.optional, scenarios: ch.scenarios.map((s) => s.id) };
  m.scenarios[result.id] = result;
  await writeManifest(m);
}
