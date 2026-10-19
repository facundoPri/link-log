import { extractMetadata, metadataStatement } from "../metadata";
import { adapterFor } from "../adapters";
import type { Discovered } from "../adapters/types";
import { transcribeImage, OCR_MODEL } from "../ocr";
import type { MediaItem, ContentDetails } from "../../src/types";
import type { WorkflowStepContext } from "cloudflare:workers";
import { classify, logFailure, logResidualFailure, LinkFailure } from "../failures";
import type { FailureReason } from "../../src/failures";
import type { JobContext, JobHandler } from "./index";
import { displayMetadataStatement } from "../display-metadata";
import { contentPrefix } from "../store";
import { jobRunning, settleAttention } from "../attention";

const MAX_OCR_PREVIEWS = 20;
// Bound as: the 8 row values, the extraction's job id (written only while it runs), then the 4 asset-changed flags.
export const MEDIA_UPSERT_SQL = "INSERT INTO media_items(link_id,media_key,position,kind,url,preview_url,ocr_state,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='running') ON CONFLICT(link_id,media_key) DO UPDATE SET position=excluded.position,kind=excluded.kind,url=excluded.url,preview_url=excluded.preview_url,ocr_state=CASE WHEN ? THEN excluded.ocr_state WHEN media_items.ocr_state='skipped' AND excluded.ocr_state='pending' THEN 'pending' ELSE media_items.ocr_state END,ocr_text=CASE WHEN ? THEN NULL ELSE media_items.ocr_text END,ocr_error=CASE WHEN ? THEN NULL ELSE media_items.ocr_error END,ocr_model=CASE WHEN ? THEN NULL ELSE media_items.ocr_model END,updated_at=excluded.updated_at";

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
// Each attempt gives up before the step's own timeout, so a hang is recorded and classified like any failure.
export const ATTEMPT_BUDGET_MS = { preview: 20_000, content: 100_000 };
type Failed = { failed: FailureReason };

// One attempt of a retried step. A transient failure with attempts left rethrows so Workflows retries it;
// the last or a fail-fast failure is returned, so its reason survives the step boundary as data.
// `run` is raced against the budget and must have no side effects: a timed-out run may still finish later,
// so it is aborted and its result dropped. Only the accepted result reaches `accept` (which may write).
async function attempt<R, T = R>(
  { env, job, link }: Pick<JobContext, "env" | "job" | "link">,
  ctx: WorkflowStepContext,
  at: { step: "preview" | "content"; label: string; limit: number; adapter: string },
  run: (signal: AbortSignal) => Promise<R>,
  accept: (result: R) => Promise<T> = async (result) => result as unknown as T,
): Promise<T | Failed> {
  const max = at.limit + 1, budget = ATTEMPT_BUDGET_MS[at.step];
  const where = { link_id: link.id, job_id: job.id, step: at.step, adapter: at.adapter, url: link.url || link.original_url, max_attempts: max };
  // A previous attempt that never reached its catch was ended by the engine (step timeout or eviction).
  const prior = ctx.attempt > 1
    ? await env.DB.prepare("SELECT attempt,attempt_started_at FROM jobs WHERE id=?").bind(job.id).first<{ attempt: number | null; attempt_started_at: number | null }>()
    : null;
  const killed = !!prior?.attempt_started_at && prior.attempt === ctx.attempt - 1;
  if (killed) logFailure(new LinkFailure("timeout", { technical: "Attempt ended by the Workflow engine" }), { ...where, attempt: ctx.attempt - 1, final: false });
  await env.DB.batch([
    env.DB.prepare(`UPDATE jobs SET step=?,attempt=?,max_attempts=?,attempt_started_at=?,attempt_budget_ms=?,adapter=?${ctx.attempt === 1 ? ",reason=NULL" : killed ? ",reason='timeout'" : ""} WHERE id=? AND status='running'`)
      .bind(at.label, ctx.attempt, max, Date.now(), budget, at.adapter, job.id),
    // Retries and backoff run while holding the slot; keep the lease alive.
    env.DB.prepare("UPDATE provider_leases SET expires_at=? WHERE job_id=?").bind(Date.now() + 300000, job.id),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandon = new AbortController();
  try {
    const result = await Promise.race([
      run(abandon.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abandon.abort();
          reject(new LinkFailure("timeout", { technical: `Attempt exceeded ${budget} ms` }));
        }, budget);
      }),
    ]);
    clearTimeout(timer);
    return await accept(result);
  } catch (error) {
    const failure = classify(error);
    const final = !failure.retryable || ctx.attempt >= max;
    logFailure(failure, { ...where, attempt: ctx.attempt, final });
    await env.DB.prepare("UPDATE jobs SET reason=?,attempt=?,attempt_started_at=NULL WHERE id=? AND status='running'").bind(failure.reason, final ? ctx.attempt : ctx.attempt + 1, job.id).run();
    if (final) return { failed: failure.reason };
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

// Preview attempts, with their retries. A failure that ends the step itself (engine timeout, bookkeeping
// write) is a final preview failure too.
async function fetchPreview({ env, step, job, link }: JobContext) {
  return step.do("resolve-and-preview", { retries: PREVIEW_RETRIES, timeout: "30 seconds" },
    (ctx) => attempt({ env, job, link }, ctx, { step: "preview", label: "Fetching preview", limit: PREVIEW_RETRIES.limit, adapter: "preview" }, async () => {
      const result = await extractMetadata(link.original_url);
      if (result.status === "failed") throw new LinkFailure(result.failure?.reason ?? "unknown", result.failure?.detail);
      return result;
    }))
    .catch((error) => step.do("record-preview-failure", async (): Promise<Failed> => {
      const failure = classify(error);
      await logResidualFailure(env, failure, { link_id: link.id, job_id: job.id, url: link.url });
      return { failed: failure.reason };
    }));
}
type Preview = Awaited<ReturnType<typeof fetchPreview>>;
// A preview that worked before is kept, like content: the failure is only recorded in Activity.
// Published only while the job runs: a cancelled job leaves the preview as it was.
const savePreview = (env: Env, linkId: string, jobId: string, preview: Preview, userId: string) =>
  metadataStatement(env.DB, userId, linkId, "failed" in preview ? {
    url: "", domain: "", title: "", description: "", image: null, favicon: null, status: "failed",
    error: new LinkFailure(preview.failed).message, failure: { reason: preview.failed, detail: {} },
  } : preview, jobRunning, [jobId]);

// "Retry preview": only the preview step, through the queue like any job.
export const previewHandler: JobHandler = {
  pool: () => null,
  async run(ctx) {
    const { env, step, job, link } = ctx;
    const preview = await fetchPreview(ctx);
    ctx.progress.preview = "failed" in preview ? "failed" : "ok";
    await step.do("save-preview", async () => {
      await env.DB.batch([
        savePreview(env, link.id, job.id, preview, job.user_id),
        env.DB.prepare("UPDATE jobs SET attempt_started_at=NULL WHERE id=? AND status='running'").bind(job.id),
      ]);
      await settleAttention(env.DB, link.id, { preview: ctx.progress.preview }, job.id);
    });
    if ("failed" in preview) throw new LinkFailure(preview.failed);
  },
};

export const extractHandler: JobHandler = {
  // The saved URL may redirect to a social source, so reserve discovery capacity up front.
  pool: () => "browser",
  async run(ctx) {
    const { env, step, job, link, config } = ctx;
    const linkJob = { id: job.id, batch_id: job.batch_id, link_id: link.id };
    // Retrying failed content re-runs only the content step, from the URL the preview resolved before.
    const preview = config.step === "content" ? null : await fetchPreview(ctx);
    if (preview) ctx.progress.preview = "failed" in preview ? "failed" : "ok";
    const previewFailed = preview && "failed" in preview ? preview.failed : null;
    const metadata = { url: preview && !("failed" in preview) ? preview.url : link.url };
    const adapter = adapterFor(metadata.url);
    await step.do("save-preview", async () => {
      if (preview) await savePreview(env, link.id, job.id, preview, job.user_id).run();
      await env.DB.prepare("UPDATE jobs SET step='Extracting content',attempt=NULL,max_attempts=NULL,reason=NULL,attempt_started_at=NULL,attempt_budget_ms=NULL,adapter=?,preview_reason=? WHERE id=? AND status='running'")
        .bind(adapter.name, previewFailed, job.id).run();
    });
    // A job cancelled meanwhile (FAC-55) stores no content or media and settles nothing: every write below
    // requires the job to be still running, inside the statement itself.
    const running = jobRunning;
    const settle = () => step.do("settle-attention", () => settleAttention(env.DB, link.id, { content: "ok", preview: ctx.progress.preview }, job.id));
    if (!adapter.discover) {
      const content = await step.do("extract-content", { retries: CONTENT_RETRIES, timeout: "2 minutes" },
        (ctx) => attempt({ env, job, link }, ctx, { step: "content", label: "Extracting content", limit: CONTENT_RETRIES.limit, adapter: adapter.name },
          async (signal) => {
            const result = await adapter.extract(env, metadata.url, linkJob, signal);
            if (new TextEncoder().encode(result.markdown).length > 2_000_000) throw new LinkFailure("too_large");
            return result;
          },
          // A per-attempt key: a step callback the engine abandoned can never overwrite the accepted content.
          async (result) => {
            const key = `${contentPrefix(job.user_id, link.id)}${job.id}-${ctx.attempt}.md`;
            await env.CONTENT.put(key, result.markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
            return { key, source: result.source, display: result.display };
          }));
      if ("failed" in content) throw new LinkFailure(content.failed);
      await step.do("save-content", async () => {
        await env.DB.batch([
          displayMetadataStatement(env.DB, job.user_id, link.id, job.id, content.display ?? {}, metadata.url),
          env.DB.prepare(`DELETE FROM media_items WHERE link_id=? AND ${running}`).bind(link.id, job.id),
          env.DB.prepare(`UPDATE links SET content_key=?,content_version=content_version+1,content_source=?,content_state='ready',content_error=NULL,content_reason=NULL,content_details=NULL,content_updated_at=? WHERE id=? AND ${running}`)
            .bind(content.key, content.source, new Date().toISOString(), link.id, job.id),
        ]);
      });
      await settle();
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
        return env.DB.prepare(MEDIA_UPSERT_SQL).bind(link.id, item.media_key, item.position, item.kind, item.url, item.preview_url, "pending", now, job.id, Number(changedAsset), Number(changedAsset), Number(changedAsset), Number(changedAsset));
      });
      // One transaction: the discovered media replace the old ones only while the job runs.
      await env.DB.batch([
        ...statements,
        env.DB.prepare(`DELETE FROM media_items WHERE link_id=?${discovered.media.length ? ` AND media_key NOT IN (${discovered.media.map(() => "?").join(",")})` : ""} AND ${running}`)
          .bind(link.id, ...discovered.media.map((item) => item.media_key), job.id),
        env.DB.prepare("UPDATE jobs SET step='Reading images' WHERE id=? AND status='running'").bind(job.id),
      ]);
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
        await env.DB.prepare(`UPDATE media_items SET ocr_state=?,ocr_text=?,ocr_error=?,ocr_model=?,updated_at=? WHERE link_id=? AND media_key=? AND ${running}`)
          .bind(result.state, result.state === "done" ? result.text : null, "error" in result ? result.error : null, OCR_MODEL, new Date().toISOString(), link.id, item.media_key, job.id).run();
      });
    }
    const media = await step.do("load-composed-media", () => storedMedia(env, link.id));
    if (ocrMedia.length > MAX_OCR_PREVIEWS)
      discovered.details.issues.push(`Only the first ${MAX_OCR_PREVIEWS} images and video previews were processed; the remainder are pending.`);
    const content = composeSocial(discovered, media);
    await step.do("fill-display-metadata", async () => {
      await displayMetadataStatement(env.DB, job.user_id, link.id, job.id, {
        title: discovered.title,
        image: [...discovered.media].sort((a,b) => a.position - b.position).find(m => m.preview_url)?.preview_url,
        description: discovered.details.type === "instagram-post" || discovered.details.type === "x-post" ? discovered.text : undefined,
      }, metadata.url).run();
    });
    // A generic adapter heading, extraction notes, or an image alone is not page content.
    // Keep details for manual transcript recovery, then let terminal fallback use genuine metadata.
    if (!discovered.text.trim() && !media.some(m => m.ocr_state === "done" && m.ocr_text?.trim())) {
      await step.do("save-unavailable-details", async () => {
        await env.DB.prepare(`UPDATE links SET content_details=? WHERE id=? AND content_key IS NULL AND ${running}`).bind(JSON.stringify(content.details), link.id, job.id).run();
      });
      throw new LinkFailure("empty");
    }
    const key = `${contentPrefix(job.user_id, link.id)}${job.id}.md`;
    await step.do("store-composed-content", async () => {
      if (new TextEncoder().encode(content.markdown).length > 2_000_000) throw new Error("The extracted content exceeds 2 MB.");
      await env.CONTENT.put(key, content.markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    });
    await step.do("save-composed-content", async () => {
      await env.DB.prepare(`UPDATE links SET content_key=?,content_version=content_version+1,content_source=?,content_state=?,content_error=?,content_reason=NULL,content_details=?,content_updated_at=? WHERE id=? AND ${running}`)
        .bind(key, discovered.source, content.state, content.details.issues[0] || null, JSON.stringify(content.details), new Date().toISOString(), link.id, job.id).run();
    });
    await settle();
  },
};
