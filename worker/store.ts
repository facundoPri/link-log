import type {
  Link,
  Tag,
  Evaluation,
  Batch,
  Lens,
  LensResult,
  BatchUsage,
  MediaItem,
} from "../src/types";
import { OCR_USAGE_COLUMNS } from "./usage";
import { fixtureJevAllowed } from "./config";
import { badRequest } from "./http/context";
import { browserRunAvailable } from "./adapters/browser-run";
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function capabilities(env: Env) {
  const provider = env.JEV_PROVIDER || "cloudflare";
  return {
    provider,
    markdown: browserRunAvailable(env),
    jev:
      provider === "typesafe"
        ? !!env.TYPESAFE_API_KEY
        : provider === "fixture"
          ? fixtureJevAllowed(env)
          : !!env.AI,
  };
}
export async function library(env: Env, userId: string) {
  // Every query is scoped to the owner directly or through an owned link/batch.
  const ownedLinks = "SELECT id FROM links WHERE user_id=?1";
  const [links, tags, joins, evaluations, batches, lensRows, lensResults, usageRows, mediaRows, hiddenRows] =
    await Promise.all([
    env.DB.prepare("SELECT * FROM links WHERE user_id=?1 ORDER BY created_at DESC").bind(userId).all<
      Link & { metadata_started_at: string | null; user_id?: string }
    >(),
    env.DB.prepare(
      "SELECT id,name,description,threshold,version FROM tags WHERE user_id=?1 ORDER BY name COLLATE NOCASE",
    ).bind(userId).all<Tag>(),
    env.DB.prepare(`SELECT * FROM link_tags WHERE link_id IN (${ownedLinks})`).bind(userId).all<{
      link_id: string;
      tag_id: string;
      origin: "manual" | "auto";
    }>(),
    env.DB.prepare(`SELECT * FROM tag_evaluations WHERE link_id IN (${ownedLinks})`).bind(userId).all<
      Evaluation & { link_id: string }
    >(),
    env.DB.prepare(
      "SELECT b.id,b.kind,b.config,b.created_at,count(j.id) total,coalesce(sum(j.status='done'),0) done,coalesce(sum(j.status='failed'),0) failed,coalesce(sum(j.status IN ('queued','running')),0) active FROM batches b LEFT JOIN jobs j ON j.batch_id=b.id WHERE b.user_id=?1 GROUP BY b.id HAVING count(j.id)>0 ORDER BY b.created_at DESC LIMIT 30",
    ).bind(userId).all<Batch>(),
    env.DB.prepare("SELECT id,name,type,question,options,threshold,version,created_at,scope FROM lenses WHERE user_id=?1 ORDER BY name COLLATE NOCASE").bind(userId).all<
      Omit<Lens, "options" | "levels"> & { options: string }
    >(),
    env.DB.prepare(`SELECT * FROM lens_results WHERE link_id IN (${ownedLinks})`).bind(userId).all<
      Omit<LensResult, "answer"> & { link_id: string; answer: string }
    >(),
    env.DB.prepare(
      `SELECT batch_id,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,max(model) model,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls,${OCR_USAGE_COLUMNS} FROM usage_events WHERE user_id=?1 AND status IN ('done','failed') GROUP BY batch_id`,
    ).bind(userId).all<{
      batch_id: string;
      input_tokens: number | null;
      output_tokens: number | null;
      browser_ms: number | null;
      model: string | null;
      usd: number | null;
      unknown_cost_calls: number;
      ocr_images: number;
      ocr_input_tokens: number | null;
      ocr_output_tokens: number | null;
      ocr_model: string | null;
      ocr_usd: number | null;
      ocr_unknown_cost_calls: number;
    }>(),
    env.DB.prepare(`SELECT link_id,media_key,position,kind,url,preview_url,ocr_state,ocr_text,ocr_error,ocr_model FROM media_items WHERE link_id IN (${ownedLinks}) ORDER BY position`).bind(userId).all<MediaItem & {link_id: string}>(),
    env.DB.prepare(`SELECT link_id,url FROM hidden_related_links WHERE link_id IN (${ownedLinks}) ORDER BY hidden_at`).bind(userId).all<{link_id: string; url: string}>(),
  ]);
  const hiddenByLink = new Map<string, string[]>();
  for (const row of hiddenRows.results)
    hiddenByLink.set(row.link_id, [...(hiddenByLink.get(row.link_id) || []), row.url]);
  const mediaByLink = new Map<string, MediaItem[]>();
  for (const { link_id, ...media } of mediaRows.results)
    mediaByLink.set(link_id, [...(mediaByLink.get(link_id) || []), media]);
  const usageByBatch = new Map<string, BatchUsage>();
  for (const row of usageRows.results) {
    let u = usageByBatch.get(row.batch_id);
    if (!u)
      usageByBatch.set(
        row.batch_id,
        (u = {
          input_tokens: 0,
          output_tokens: 0,
          browser_ms: 0,
          model: null,
          usd: null,
          unknown_cost_calls: 0,
          ocr: null,
        }),
      );
    u.input_tokens += row.input_tokens ?? 0;
    u.output_tokens += row.output_tokens ?? 0;
    u.browser_ms += row.browser_ms ?? 0;
    u.model ??= row.model;
    if (row.usd !== null) u.usd = (u.usd ?? 0) + row.usd;
    u.unknown_cost_calls += row.unknown_cost_calls;
    if (row.ocr_images) u.ocr = {
      images: row.ocr_images,
      input_tokens: row.ocr_input_tokens ?? 0,
      output_tokens: row.ocr_output_tokens ?? 0,
      model: row.ocr_model,
      usd: row.ocr_usd,
      unknown_cost_calls: row.ocr_unknown_cost_calls,
    };
  }
  const tagsById = new Map(tags.results.map((t) => [t.id, t]));
  const membership = new Map<string, Tag[]>();
  for (const j of joins.results) {
    const tag = tagsById.get(j.tag_id);
    if (tag)
      membership.set(j.link_id, [
        ...(membership.get(j.link_id) || []),
        { ...tag, origin: j.origin },
      ]);
  }
  const scores = new Map<string, Evaluation[]>();
  for (const e of evaluations.results)
    scores.set(e.link_id, [...(scores.get(e.link_id) || []), e]);
  const lenses: Lens[] = lensRows.results.map((row) => ({
    ...row,
    ...parseLensDefinition(row.type, row.options),
  }));
  const lensByLink = new Map<string, LensResult[]>();
  for (const r of lensResults.results) {
    let answer: LensResult["answer"] | null = null;
    try {
      answer = JSON.parse(r.answer);
    } catch {}
    if (!answer) continue;
    const { link_id, answer: _raw, ...rest } = r;
    lensByLink.set(link_id, [
      ...(lensByLink.get(link_id) || []),
      { ...rest, answer },
    ]);
  }
  return {
    links: links.results.map(({ user_id: _owner, ...l }) => ({
      ...l,
      status:
        l.status === "pending" &&
        Date.now() - Date.parse(l.metadata_started_at || l.created_at) > 30000
          ? "failed"
          : l.status,
      tags: membership.get(l.id) || [],
      evaluations: scores.get(l.id) || [],
      lens_results: lensByLink.get(l.id) || [],
      media: mediaByLink.get(l.id) || [],
      hidden_related_urls: hiddenByLink.get(l.id) || [],
    })),
    tags: tags.results,
    lenses,
    batches: batches.results.map((b) => ({
      ...b,
      usage: usageByBatch.get(b.id) ?? null,
    })),
    capabilities: capabilities(env),
  };
}
export type OwnedLink = Link & { user_id: string; content_details?: string | null };
/** The only way handlers load a link by ID: a foreign or legacy (unassigned) ID reads as missing. */
export function getOwnedLink(db: D1Database, userId: string, id: string) {
  return db.prepare("SELECT * FROM links WHERE id=? AND user_id=?").bind(id, userId).first<OwnedLink>();
}
/** R2 prefix for new content. Legacy objects keep `links/<id>/`; reads always go through the owned row. */
export const contentPrefix = (userId: string, linkId: string) => `users/${userId}/links/${linkId}/`;
export function contentKeyBelongs(key: string, userId: string, linkId: string) {
  return key.startsWith(contentPrefix(userId, linkId)) || key.startsWith(`links/${linkId}/`);
}
export function parseLensDefinition(
  _type: Lens["type"],
  raw: string,
): Pick<Lens, "options" | "levels" | "criteria"> {
  const out: Pick<Lens, "options" | "levels" | "criteria"> = {
    options: [],
    levels: [],
    criteria: { yes: "", no: "" },
  };
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch {}
  if (Array.isArray(parsed)) {
    // legacy score shape: ordered string[]
    out.levels = parsed.map((l) => ({ label: String(l), description: "" }));
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const o = parsed as Record<string, unknown>;
  if (Array.isArray(o.options)) {
    out.options = (o.options as Record<string, unknown>[]).map((p) => ({
      key: String(p.key),
      label: String(p.label ?? p.key),
      description: typeof p.description === "string" ? p.description : "",
    }));
  } else {
    // legacy choice shape: flat Record<key, label>
    const entries = Object.entries(o).filter(
      ([k, v]) =>
        typeof v === "string" &&
        !["options", "levels", "criteria"].includes(k),
    );
    if (entries.length)
      out.options = entries.map(([key, label]) => ({
        key,
        label: key === "other" ? "Other" : String(label),
        description: "",
      }));
  }
  if (Array.isArray(o.levels))
    out.levels = (o.levels as Record<string, unknown>[]).map((l) => ({
      label: String(l.label ?? ""),
      description: typeof l.description === "string" ? l.description : "",
    }));
  if (o.criteria && typeof o.criteria === "object") {
    const c = o.criteria as Record<string, unknown>;
    out.criteria = {
      yes: typeof c.yes === "string" ? c.yes : "",
      no: typeof c.no === "string" ? c.no : "",
    };
  }
  return out;
}
export function text(value: unknown, max = 1000) {
  if (typeof value !== "string" || value.trim().length > max)
    throw badRequest("Invalid or too-long text.");
  return value.trim();
}
export function threshold(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw badRequest("The threshold must be between 0 and 100%.");
  return value;
}
