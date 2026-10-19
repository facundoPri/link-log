import type { Link } from "../src/types";
import { metadataText } from "../src/metadata-text";

// FAC-56: when the content can't be extracted for good, the preview (title + description) can stand in for
// it, so Jev has something to work with. Only that text is stored: the "from preview" label is derived from
// content_source and is never part of what Jev reads.
type Preview = Pick<Link, "status" | "title" | "description" | "content_key"> & Partial<Pick<Link, "content_state" | "domain" | "url" | "title_source">> & { user_id: string };
export const previewText = metadataText;
// Usable only when genuine metadata text exists and there is no valid content to show instead. The per-link action also
// needs a final content failure on record (content_state='failed', which Dismiss keeps).
export const canUsePreview = (l: Preview) => !l.content_key && !!previewText(l);

export const readPreview = (db: D1Database, userId: string, linkId: string) =>
  db.prepare("SELECT user_id,status,title,title_source,domain,url,description,content_key,content_state FROM links WHERE id=? AND user_id=?").bind(linkId, userId).first<Preview>();

// A few quick attempts; false when the text could not be stored (logged), so the caller goes on without it.
export async function storePreview(env: Env, key: string, link: Preview, where: Record<string, string>, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      await env.CONTENT.put(key, previewText(link), { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
      return true;
    } catch (error) {
      console.error(JSON.stringify({ event: "preview_fallback_store_failed", ...where, attempt, final: attempt >= attempts, detail: String(error) }));
      if (attempt >= attempts) return false;
    }
  }
}

// The stored text is removed when the link didn't take it (the job was settled elsewhere, the row changed), so no object is left without a reference. Best effort: a failure is only logged.
export async function dropUnusedPreview(env: Env, linkId: string, key: string) {
  try {
    if (await env.DB.prepare("SELECT 1 FROM links WHERE id=? AND content_key=?").bind(linkId, key).first()) return;
    await env.CONTENT.delete(key);
  } catch (error) {
    console.error(JSON.stringify({ event: "preview_fallback_cleanup_failed", link_id: linkId, key, detail: String(error).slice(0, 300) }));
  }
}

// Applies the stored preview text as the link's content, only if the row is still the one it was made from
// (no content yet, the same preview) and `guard` holds. Content attention goes away: the link has a usable path.
export const usePreviewStatement = (db: D1Database, linkId: string, key: string, link: Preview, guard: string, ...guardParams: unknown[]) =>
  db.prepare(`UPDATE links SET content_key=?,content_version=content_version+1,content_source='preview',content_state='partial',content_updated_at=?,
attention_kind=CASE WHEN attention_kind='content' THEN NULL ELSE attention_kind END,attention_reason=CASE WHEN attention_kind='content' THEN NULL ELSE attention_reason END,attention_at=CASE WHEN attention_kind='content' THEN NULL ELSE attention_at END
WHERE id=? AND content_key IS NULL AND user_id=? AND title_source IS ? AND title IS ? AND description IS ? AND ${guard}`)
    .bind(key, new Date().toISOString(), linkId, link.user_id, link.title_source, link.title, link.description, ...guardParams);
