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
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function capabilities(env: Env) {
  const provider = env.JEV_PROVIDER || "cloudflare";
  return {
    provider,
    markdown: !!env.BROWSER,
    jev:
      provider === "typesafe"
        ? !!env.TYPESAFE_API_KEY
        : provider === "fixture"
          ? env.ALLOW_FIXTURE_JEV === "1"
          : !!env.AI,
  };
}
const PREVIEW_RETRY_WINDOW_MS = 30000;
export async function library(env: Env) {
  const [links, tags, joins, evaluations, batches, lensRows, lensResults, usageRows, mediaRows, hiddenRows] =
    await Promise.all([
    env.DB.prepare(
      "SELECT l.*,(SELECT b.kind FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=l.id AND j.status IN ('queued','running') LIMIT 1) active_kind FROM links l ORDER BY l.created_at DESC",
    ).all<
      Omit<Link, "processing" | "previewing"> & { metadata_started_at: string | null; active_kind: string | null }
    >(),
    env.DB.prepare(
      "SELECT * FROM tags ORDER BY name COLLATE NOCASE",
    ).all<Tag>(),
    env.DB.prepare("SELECT * FROM link_tags").all<{
      link_id: string;
      tag_id: string;
      origin: "manual" | "auto";
    }>(),
    env.DB.prepare("SELECT * FROM tag_evaluations").all<
      Evaluation & { link_id: string }
    >(),
    env.DB.prepare(
      "SELECT b.*,count(j.id) total,coalesce(sum(j.status='done'),0) done,coalesce(sum(j.status='failed'),0) failed,coalesce(sum(j.status IN ('queued','running')),0) active FROM batches b LEFT JOIN jobs j ON j.batch_id=b.id GROUP BY b.id HAVING count(j.id)>0 ORDER BY b.created_at DESC LIMIT 30",
    ).all<Batch>(),
    env.DB.prepare("SELECT * FROM lenses ORDER BY name COLLATE NOCASE").all<
      Omit<Lens, "options" | "levels"> & { options: string }
    >(),
    env.DB.prepare("SELECT * FROM lens_results").all<
      Omit<LensResult, "answer"> & { link_id: string; answer: string }
    >(),
    env.DB.prepare(
      `SELECT batch_id,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,max(model) model,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls,${OCR_USAGE_COLUMNS} FROM usage_events WHERE status IN ('done','failed') GROUP BY batch_id`,
    ).all<{
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
    env.DB.prepare("SELECT link_id,media_key,position,kind,url,preview_url,ocr_state,ocr_text,ocr_error,ocr_model FROM media_items ORDER BY position").all<MediaItem & {link_id: string}>(),
    env.DB.prepare("SELECT link_id,url FROM hidden_related_links ORDER BY hidden_at").all<{link_id: string; url: string}>(),
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
    links: links.results.map(({ active_kind, ...l }) => {
      // "Retry preview" runs outside the queue; if the Worker dies mid-fetch the link turns neutral.
      const retrying =
        l.status === "pending" &&
        !!l.metadata_started_at &&
        Date.now() - Date.parse(l.metadata_started_at) < PREVIEW_RETRY_WINDOW_MS;
      return {
        ...l,
        processing: !!active_kind || retrying,
        previewing: retrying || (l.status === "pending" && active_kind === "extract"),
        tags: membership.get(l.id) || [],
        evaluations: scores.get(l.id) || [],
        lens_results: lensByLink.get(l.id) || [],
        media: mediaByLink.get(l.id) || [],
        hidden_related_urls: hiddenByLink.get(l.id) || [],
      };
    }),
    tags: tags.results,
    lenses,
    batches: batches.results.map((b) => ({
      ...b,
      usage: usageByBatch.get(b.id) ?? null,
    })),
    capabilities: capabilities(env),
  };
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
    throw new Error("Invalid or too-long text.");
  return value.trim();
}
export function threshold(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new Error("The threshold must be between 0 and 100%.");
  return value;
}
