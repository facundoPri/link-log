// Validation and owner-scoped helpers shared by the route modules.
import type { LensLevel, LensOption } from "../../src/types";
import { normalizeUrl } from "../../src/url";
import { extractMetadata, saveMetadata } from "../metadata";
import { text, threshold } from "../store";
import { badRequest, notFound } from "../http/context";

export async function enrich(db: D1Database, userId: string, id: string, url: string) {
  try {
    const m = await extractMetadata(url);
    await saveMetadata(db, userId, id, m);
  } catch {
    await db.prepare("UPDATE links SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'failed' END WHERE id=? AND user_id=?").bind(id, userId).run();
  }
}

/** Normalized public URL, or a 400 with the reason (src/url.ts is shared with the UI). */
export function urlInput(value: string) {
  try {
    return normalizeUrl(value);
  } catch (error) {
    throw badRequest(error instanceof Error && error.message ? error.message : "Invalid link.");
  }
}

export function tagNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((t) => typeof t !== "string" || t.trim().length > 40)
  )
    throw badRequest("Use up to 20 tags of 40 characters.");
  return [
    ...new Set(
      value
        .map((t) => (t as string).trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function lensFields(body: Record<string, unknown>) {
  const name = text(body.name, 60);
  if (!name) throw badRequest("Name the lens.");
  const type = String(body.type);
  if (!["noul", "choice", "multi", "score"].includes(type))
    throw badRequest("Invalid lens type.");
  const question = text(body.question, 2000);
  if (!question) throw badRequest("Write a question.");
  let options: LensOption[] = [];
  let levels: LensLevel[] = [];
  const criteria = { yes: "", no: "" };
  if (type === "choice" || type === "multi") {
    if (!Array.isArray(body.options))
      throw badRequest("Invalid options.");
    if (body.options.length < 2 || body.options.length > 11)
      throw badRequest("Use between 2 and 11 options.");
    const seen = new Set<string>();
    for (const raw of body.options as Record<string, unknown>[]) {
      const key = String(raw?.key ?? "");
      if (!/^[a-z0-9_]{1,40}$/.test(key) || key === "other")
        throw badRequest("Invalid option.");
      if (seen.has(key)) throw badRequest("Duplicate option.");
      seen.add(key);
      const label = text(raw?.label, 60);
      if (!label) throw badRequest("Fill in the options.");
      const description =
        raw?.description === undefined || raw?.description === null
          ? ""
          : text(raw.description, 300);
      options.push({ key, label, description });
    }
    if (type === "choice")
      options.push({
        key: "other",
        label: "Other",
        description: "None of the other options applies.",
      });
  }
  if (type === "score") {
    if (
      !Array.isArray(body.levels) ||
      body.levels.length < 2 ||
      body.levels.length > 10
    )
      throw badRequest("Use between 2 and 10 levels.");
    for (const raw of body.levels as Record<string, unknown>[]) {
      const label = text(raw?.label, 60);
      if (!label) throw badRequest("Fill in the levels.");
      const description =
        raw?.description === undefined || raw?.description === null
          ? ""
          : text(raw.description, 300);
      levels.push({ label, description });
    }
  }
  if (type === "noul") {
    const c =
      body.criteria && typeof body.criteria === "object"
        ? (body.criteria as Record<string, unknown>)
        : {};
    criteria.yes =
      c.yes === undefined || c.yes === null ? "" : text(c.yes, 500);
    criteria.no = c.no === undefined || c.no === null ? "" : text(c.no, 500);
  }
  const thr =
    body.threshold === undefined || body.threshold === null
      ? 0.8
      : threshold(body.threshold);
  return { name, type, question, options, levels, criteria, threshold: thr };
}

/** Tags are created and resolved inside the owner's namespace only. */
export function setTags(
  db: D1Database,
  userId: string,
  id: string,
  names: string[],
  replace: boolean,
) {
  const statements = replace
    ? [db.prepare("DELETE FROM link_tags WHERE link_id=? AND link_id IN (SELECT id FROM links WHERE user_id=?)").bind(id, userId)]
    : [];
  for (const name of names) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO tags (id,user_id,name) VALUES (?,?,?)")
        .bind(crypto.randomUUID(), userId, name),
    );
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO link_tags (link_id,tag_id) SELECT l.id,t.id FROM links l JOIN tags t ON t.user_id=l.user_id WHERE l.id=? AND l.user_id=? AND t.name=?",
        )
        .bind(id, userId, name),
    );
  }
  return statements;
}

export async function assertNoActiveJob(db: D1Database, linkId: string) {
  const active = await db
    .prepare("SELECT id FROM jobs WHERE link_id=? AND status IN ('queued','running','waiting')")
    .bind(linkId)
    .first();
  if (active) throw badRequest("Wait for the running job to finish.");
}

export async function ownedBatch(db: D1Database, userId: string, id: string) {
  const batch = await db
    .prepare("SELECT id,kind,config FROM batches WHERE id=? AND user_id=?")
    .bind(id, userId)
    .first<{ id: string; kind: string; config: string }>();
  if (!batch) throw notFound("batch");
  return batch;
}
