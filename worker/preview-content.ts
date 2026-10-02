import type { Link } from "../src/types";

// FAC-56: when the content can't be extracted for good, the preview (title + description) can stand in for
// it, so Jev has something to work with. Only that text is stored: the "from preview" label is derived from
// content_source and is never part of what Jev reads.
export const PREVIEW_FALLBACK_KEY = "preview_fallback";
export const previewFallbackSetting = `EXISTS (SELECT 1 FROM settings WHERE key='${PREVIEW_FALLBACK_KEY}' AND value='1')`;
export const previewFallbackOn = async (db: D1Database) => !!(await db.prepare(`SELECT ${previewFallbackSetting} on_`).first<{ on_: number }>())?.on_;
type Preview = Pick<Link, "status" | "title" | "description" | "content_key">;
export const previewText = (l: Pick<Link, "title" | "description">) =>
  [l.title, l.description].map((s) => s?.trim()).filter(Boolean).join("\n\n");
// Usable only when the preview was obtained and there is no content to show instead.
export const canUsePreview = (l: Preview) => l.status === "ready" && !l.content_key && !!previewText(l);

export const readPreview = (db: D1Database, linkId: string) =>
  db.prepare("SELECT status,title,description,content_key FROM links WHERE id=?").bind(linkId).first<Preview>();

export const storePreview = (env: Env, key: string, link: Preview) =>
  env.CONTENT.put(key, previewText(link), { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });

// Applies the stored preview text as the link's content, only if the row is still the one it was made from
// (no content yet, the same preview) and `guard` holds. Content attention goes away: the link has a usable path.
export const usePreviewStatement = (db: D1Database, linkId: string, key: string, link: Preview, guard: string, ...guardParams: unknown[]) =>
  db.prepare(`UPDATE links SET content_key=?,content_version=content_version+1,content_source='preview',content_state='partial',content_details=NULL,content_updated_at=?,
attention_kind=CASE WHEN attention_kind='content' THEN NULL ELSE attention_kind END,attention_reason=CASE WHEN attention_kind='content' THEN NULL ELSE attention_reason END,attention_at=CASE WHEN attention_kind='content' THEN NULL ELSE attention_at END
WHERE id=? AND content_key IS NULL AND status='ready' AND title IS ? AND description IS ? AND ${guard}`)
    .bind(key, new Date().toISOString(), linkId, link.title, link.description, ...guardParams);
