import type { Link, Tag, Evaluation, Batch } from "../src/types";
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function capabilities(env: Env) {
  const provider = env.JEV_PROVIDER || "cloudflare";
  return {
    provider,
    markdown: !!env.BROWSER,
    jev: provider === "typesafe" ? !!env.TYPESAFE_API_KEY : !!env.AI,
  };
}
export async function library(env: Env) {
  const [links, tags, joins, evaluations, batches] = await Promise.all([
    env.DB.prepare("SELECT * FROM links ORDER BY created_at DESC").all<
      Link & { metadata_started_at: string | null }
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
  ]);
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
  return {
    links: links.results.map((l) => ({
      ...l,
      status:
        l.status === "pending" &&
        Date.now() - Date.parse(l.metadata_started_at || l.created_at) > 30000
          ? "failed"
          : l.status,
      tags: membership.get(l.id) || [],
      evaluations: scores.get(l.id) || [],
    })),
    tags: tags.results,
    batches: batches.results,
    capabilities: capabilities(env),
  };
}
export function text(value: unknown, max = 1000) {
  if (typeof value !== "string" || value.trim().length > max)
    throw new Error("Texto inválido o demasiado largo.");
  return value.trim();
}
export function threshold(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new Error("El umbral debe estar entre 0 y 100%.");
  return value;
}
