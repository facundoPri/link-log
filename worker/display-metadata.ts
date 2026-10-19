import { realTitle } from "../src/metadata-text";
import { jobRunning } from "./attention";

/** Deterministic fields identified by an adapter. Never summarize arbitrary body text. */
export function displayMetadataStatement(db: D1Database, userId: string, linkId: string, jobId: string, fields: { title?: string; image?: string | null; description?: string }, url: string) {
  const title = realTitle(fields.title, new URL(url).hostname, url).slice(0, 500);
  let image: string | null = null;
  try { const candidate = new URL(fields.image || ""); if (candidate.protocol === "https:" && !candidate.username && !candidate.password) image = candidate.href; } catch {}
  return db.prepare(`UPDATE links SET
    title=CASE WHEN (title_source='placeholder' OR trim(title)='') AND ?<>'' THEN ? ELSE title END,
    title_source=CASE WHEN (title_source='placeholder' OR trim(title)='') AND ?<>'' THEN 'extraction' ELSE title_source END,
    description=CASE WHEN trim(description)='' THEN ? ELSE description END,
    image=coalesce(image,?) WHERE id=? AND user_id=? AND ${jobRunning}`)
    .bind(title, title, title, fields.description?.trim().slice(0, 1000) ?? "", image, linkId, userId, jobId);
}
