import { extractMetadata } from "../metadata";
import { adapterFor } from "../adapters";
import type { Discovered } from "../adapters/types";
import { transcribeImage, OCR_MODEL } from "../ocr";
import type { MediaItem, ContentDetails } from "../../src/types";
import type { WorkflowStepContext } from "cloudflare:workers";
import { classify, logFailure, LinkFailure } from "../failures";
import type { FailureReason } from "../../src/failures";
import type { JobContext, JobHandler } from "./index";

const MAX_OCR_PREVIEWS = 20;
export const MEDIA_UPSERT_SQL = "INSERT INTO media_items(link_id,media_key,position,kind,url,preview_url,ocr_state,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(link_id,media_key) DO UPDATE SET position=excluded.position,kind=excluded.kind,url=excluded.url,preview_url=excluded.preview_url,ocr_state=CASE WHEN ? THEN excluded.ocr_state WHEN media_items.ocr_state='skipped' AND excluded.ocr_state='pending' THEN 'pending' ELSE media_items.ocr_state END,ocr_text=CASE WHEN ? THEN NULL ELSE media_items.ocr_text END,ocr_error=CASE WHEN ? THEN NULL ELSE media_items.ocr_error END,ocr_model=CASE WHEN ? THEN NULL ELSE media_items.ocr_model END,updated_at=excluded.updated_at";

export function mediaAssetIdentity(raw: string): string {
  const url = new URL(raw);
  return `${url.hostname}${url.pathname}`;
}

export function composeSocial(discovered: Discovered, media: MediaItem[]): { markdown: string; state: "ready" | "partial"; details: ContentDetails } {
  const issues = [...discovered.details.issues];
  const lines = [`# ${discovered.title}`, ""];
  if (discovered.text) lines.push(discovered.text, "");
  if (!discovered.text && discovered.details.type === "youtube-video") lines.push("Transcription not available. You can paste subtitles manually.", "");
  for (const item of [...media].sort((a,b) => a.position-b.position)) {
    lines.push(`## ${item.kind === "image" ? "Image" : "Video"} ${item.position + 1}`, "");
    if (item.preview_url) lines.push(`[Open ${item.kind} preview](${item.preview_url})`, "");
    if (item.kind === "video") lines.push("Only this still preview was checked for text; video motion and audio were not analyzed.", "");
    if (item.ocr_state === "done" && item.ocr_text) lines.push(item.kind === "video" ? "Visible text in video preview (OCR):" : "Visible text (OCR):", "", item.ocr_text, "");
    else if (item.ocr_state === "no_text") lines.push(item.kind === "video" ? "No visible text detected in the video preview." : "No visible text detected.", "");
    else {
      const reason = item.ocr_error || "OCR pending";
      lines.push(`${item.kind === "video" ? "Video preview OCR" : "OCR"} unavailable: ${reason}`, "");
      issues.push(`${item.kind === "video" ? "Video preview" : "Image"} ${item.position + 1}: ${reason}`);
    }
  }
  if (issues.length) lines.push("## Extraction notes", "", ...issues.map((issue) => `- ${issue}`));
  return { markdown: lines.join("\n").trim(), state: issues.length || discovered.details.completeness === "unverified" ? "partial" : "ready", details: { ...discovered.details, issues } };
}

async function storedMedia(env: Env, linkId: string): Promise<MediaItem[]> {
  const rows = await env.DB.prepare("SELECT media_key,position,kind,url,preview_url,ocr_state,ocr_text,ocr_error,ocr_model FROM media_items WHERE link_id=? ORDER BY position")
    .bind(linkId).all<MediaItem>();
  return rows.results;
}

// Owner decision (FAC-48): preview 2 retries, Browser Rendering → Markdown 1. Blocked, not found and
// non-HTML answers fail fast. The backoff only runs for transient reasons.
const PREVIEW_RETRIES = { limit: 2, delay: "5 seconds", backoff: "exponential" } as const;
const CONTENT_RETRIES = { limit: 1, delay: "10 seconds", backoff: "exponential" } as const;
type Failed = { failed: FailureReason };

// One attempt of a retried step. A transient failure with attempts left rethrows so Workflows retries it;
// the last or a fail-fast failure is returned, so its reason survives the step boundary as data.
async function attempt<T>(
  { env, job, link }: Pick<JobContext, "env" | "job" | "link">,
  ctx: WorkflowStepContext,
  at: { step: "preview" | "content"; label: string; limit: number },
  run: () => Promise<T>,
): Promise<T | Failed> {
  const max = at.limit + 1;
  await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET step=?,attempt=?,max_attempts=?${ctx.attempt === 1 ? ",reason=NULL" : ""} WHERE id=?`)
      .bind(at.label, ctx.attempt, max, job.id),
    // Retries and backoff run while holding the slot; keep the lease alive.
    env.DB.prepare("UPDATE provider_leases SET expires_at=? WHERE job_id=?").bind(Date.now() + 300000, job.id),
  ]);
  try {
    return await run();
  } catch (error) {
    const failure = classify(error);
    const final = !failure.retryable || ctx.attempt >= max;
    logFailure(failure, { link_id: link.id, job_id: job.id, step: at.step, url: link.url || link.original_url, attempt: ctx.attempt, max_attempts: max, final });
    await env.DB.prepare("UPDATE jobs SET reason=?,attempt=? WHERE id=?").bind(failure.reason, final ? ctx.attempt : ctx.attempt + 1, job.id).run();
    if (final) return { failed: failure.reason };
    throw failure;
  }
}

export const extractHandler: JobHandler = {
  // The saved URL may redirect to a social source, so reserve discovery capacity up front.
  pool: () => "browser",
  async run({ env, step, job, link, config }) {
    const linkJob = { id: job.id, batch_id: job.batch_id, link_id: link.id };
    const preview = await step.do("resolve-and-preview", { retries: PREVIEW_RETRIES },
      (ctx) => attempt({ env, job, link }, ctx, { step: "preview", label: "Fetching preview", limit: PREVIEW_RETRIES.limit }, () => extractMetadata(link.original_url)))
      .catch((error): Failed => {
        // Only reached when the step itself fails (for example its bookkeeping write); treat it as a final failure.
        const failure = classify(error);
        logFailure(failure, { link_id: link.id, job_id: job.id, step: "preview", url: link.url, attempt: PREVIEW_RETRIES.limit + 1, max_attempts: PREVIEW_RETRIES.limit + 1, final: true });
        return { failed: failure.reason };
      });
    const previewFailed = "failed" in preview ? preview.failed : null;
    await step.do("save-preview", async () => {
      if ("failed" in preview)
        // A preview that worked before is kept, like content: the failure is only recorded in Activity.
        await env.DB.prepare("UPDATE links SET preview_reason=CASE WHEN status='ready' THEN preview_reason ELSE ? END,status=CASE WHEN status='ready' THEN 'ready' ELSE 'failed' END WHERE id=?")
          .bind(preview.failed, link.id).run();
      else
        await env.DB.prepare("UPDATE links SET url=?,domain=?,title=?,description=?,image=?,favicon=?,status='ready',preview_reason=NULL WHERE id=?")
          .bind(preview.url, preview.domain, preview.title, preview.description, preview.image, preview.favicon, link.id).run();
      await env.DB.prepare("UPDATE jobs SET step='Extracting content',attempt=NULL,max_attempts=NULL,reason=NULL,preview_reason=? WHERE id=?").bind(previewFailed, job.id).run();
    });
    const metadata = { url: "failed" in preview ? link.url : preview.url };
    const adapter = adapterFor(metadata.url);
    if (!adapter.discover) {
      const content = await step.do("extract-content", { retries: CONTENT_RETRIES, timeout: "2 minutes" },
        (ctx) => attempt({ env, job, link }, ctx, { step: "content", label: "Extracting content", limit: CONTENT_RETRIES.limit }, async () => {
          const result = await adapter.extract(env, metadata.url, linkJob);
          if (new TextEncoder().encode(result.markdown).length > 2_000_000) throw new LinkFailure("too_large");
          const key = `links/${link.id}/${job.id}.md`;
          await env.CONTENT.put(key, result.markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
          return { key, source: result.source };
        }));
      if ("failed" in content) throw new LinkFailure(content.failed);
      await step.do("save-content", async () => {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM media_items WHERE link_id=?").bind(link.id),
          env.DB.prepare("UPDATE links SET content_key=?,content_version=content_version+1,content_source=?,content_state='ready',content_error=NULL,content_reason=NULL,content_details=NULL,content_updated_at=? WHERE id=?")
            .bind(content.key, content.source, new Date().toISOString(), link.id),
        ]);
      });
      return;
    }
    let previousManual: string | undefined;
    try {
      const details = link.content_details ? JSON.parse(link.content_details) as ContentDetails : null;
      if (details?.transcript?.reason === "manual") previousManual = details.transcript.selectedLanguage || undefined;
    } catch { /* old content has no details */ }
    const chosenTrack = config.track === "auto" ? undefined : config.track || previousManual;
    const discovered = await step.do("discover-content", { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" },
      () => adapter.discover!(env, metadata.url, linkJob, chosenTrack));
    await step.do("save-discovered-media", async () => {
      const now = new Date().toISOString();
      const oldRows = await env.DB.prepare("SELECT media_key,url FROM media_items WHERE link_id=?").bind(link.id).all<{media_key:string;url:string}>();
      const oldUrl = new Map(oldRows.results.map((row) => [row.media_key, row.url]));
      const statements = discovered.media.map((item) => {
        const prior = oldUrl.get(item.media_key);
        const changedAsset = prior ? mediaAssetIdentity(prior) !== mediaAssetIdentity(item.url) : false;
        return env.DB.prepare(MEDIA_UPSERT_SQL).bind(link.id, item.media_key, item.position, item.kind, item.url, item.preview_url, "pending", now, Number(changedAsset), Number(changedAsset), Number(changedAsset), Number(changedAsset));
      });
      if (statements.length) await env.DB.batch(statements);
      if (discovered.media.length) {
        await env.DB.prepare(`DELETE FROM media_items WHERE link_id=? AND media_key NOT IN (${discovered.media.map(() => "?").join(",")})`)
          .bind(link.id, ...discovered.media.map((item) => item.media_key)).run();
      } else await env.DB.prepare("DELETE FROM media_items WHERE link_id=?").bind(link.id).run();
      await env.DB.prepare("UPDATE jobs SET step='Reading images' WHERE id=?").bind(job.id).run();
    });
    const ocrMedia = discovered.media;
    for (const item of ocrMedia.slice(0, MAX_OCR_PREVIEWS)) {
      const existing = await step.do(`plan-ocr-${item.position}`, () => env.DB.prepare("SELECT ocr_state FROM media_items WHERE link_id=? AND media_key=?")
        .bind(link.id, item.media_key).first<{ ocr_state: string }>());
      if (existing?.ocr_state === "done" || existing?.ocr_state === "no_text") continue;
      const result = await step.do(`ocr-image-${item.position}`, { retries: { limit: 0, delay: "1 second" }, timeout: "2 minutes" }, async () => {
        try { return await transcribeImage(env, linkJob, item.media_key, item.url, item.preview_url || undefined); }
        catch (error) { return { state: "failed" as const, text: "", error: error instanceof Error ? error.message : "OCR failed" }; }
      });
      await step.do(`save-ocr-image-${item.position}`, async () => {
        await env.DB.prepare("UPDATE media_items SET ocr_state=?,ocr_text=?,ocr_error=?,ocr_model=?,updated_at=? WHERE link_id=? AND media_key=?")
          .bind(result.state, result.state === "done" ? result.text : null, "error" in result ? result.error : null, OCR_MODEL, new Date().toISOString(), link.id, item.media_key).run();
      });
    }
    const media = await step.do("load-composed-media", () => storedMedia(env, link.id));
    if (ocrMedia.length > MAX_OCR_PREVIEWS)
      discovered.details.issues.push(`Only the first ${MAX_OCR_PREVIEWS} images and video previews were processed; the remainder are pending.`);
    const content = composeSocial(discovered, media);
    const key = `links/${link.id}/${job.id}.md`;
    await step.do("store-composed-content", async () => {
      if (new TextEncoder().encode(content.markdown).length > 2_000_000) throw new Error("The extracted content exceeds 2 MB.");
      await env.CONTENT.put(key, content.markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    });
    await step.do("save-composed-content", async () => {
      await env.DB.prepare("UPDATE links SET content_key=?,content_version=content_version+1,content_source=?,content_state=?,content_error=?,content_reason=NULL,content_details=?,content_updated_at=? WHERE id=?")
        .bind(key, discovered.source, content.state, content.details.issues[0] || null, JSON.stringify(content.details), new Date().toISOString(), link.id).run();
    });
  },
};
