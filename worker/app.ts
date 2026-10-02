import { normalizeUrl, domainOf } from "../src/url";
import { extractMetadata } from "./metadata";
import type { LensOption, LensLevel, Tag } from "../src/types";
import type { Job, JobUsage, UsageEvent } from "../src/types";
import { contentKeyBelongs, contentPrefix, getOwnedLink, json, library, text, threshold } from "./store";
import { enqueue } from "./jobs";
import { preservedContentStateSql } from "./content-state";
import { OCR_USAGE_COLUMNS } from "./usage";
import { AUTH_BASE_PATH, createAuth, type Auth } from "./auth";
import { ConfigError, hostAllowed, readConfig, type AppConfig } from "./config";
import { consume, LIMITS, LimitError } from "./limits";

type JobUsageRow = {
  job_id: string;
  provider: string;
  input_tokens: number | null;
  output_tokens: number | null;
  browser_ms: number | null;
  duration_ms: number | null;
  model: string | null;
  usd: number | null;
  unknown_cost_calls: number;
  ocr_images: number;
  ocr_input_tokens: number | null;
  ocr_output_tokens: number | null;
  ocr_model: string | null;
  ocr_usd: number | null;
  ocr_unknown_cost_calls: number;
};
type UsageTotalsRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  browser_ms: number | null;
  calls: number;
  usd: number | null;
  unknown_cost_calls: number;
};

/**
 * Who is calling. Resolved on the server from the session cookie, never from the request body.
 * FAC-44 will add `{ kind: "apiKey", userId, capabilities, credentialId }` for upload routes.
 */
export type Principal = { kind: "session"; userId: string; sessionId: string };
type Policy = "session";
type Ctx = {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  principal: Principal;
  userId: string;
  body: Record<string, unknown>;
  params: string[];
};
type Route = { method: string; pattern: RegExp; policy: Policy; run: (c: Ctx) => Promise<Response> };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
// Foreign, legacy (unassigned) and deleted IDs all answer the same way: existence is not revealed.
const notFound = (what = "link") => new HttpError(404, `The ${what} no longer exists.`);

async function enrich(db: D1Database, userId: string, id: string, url: string) {
  try {
    const m = await extractMetadata(url);
    await db
      .prepare(
        "UPDATE links SET url=?, domain=?, title=?, description=?, image=?, favicon=?, status=? WHERE id=? AND user_id=?",
      )
      .bind(m.url, m.domain, m.title, m.description, m.image, m.favicon, m.status, id, userId)
      .run();
  } catch {
    await db
      .prepare("UPDATE links SET status='failed' WHERE id=? AND user_id=?")
      .bind(id, userId)
      .run();
  }
}
function tagNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((t) => typeof t !== "string" || t.trim().length > 40)
  )
    throw new Error("Use up to 20 tags of 40 characters.");
  return [
    ...new Set(
      value
        .map((t) => (t as string).trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
}
function lensFields(body: Record<string, unknown>) {
  const name = text(body.name, 60);
  if (!name) throw new Error("Name the lens.");
  const type = String(body.type);
  if (!["noul", "choice", "multi", "score"].includes(type))
    throw new Error("Invalid lens type.");
  const question = text(body.question, 2000);
  if (!question) throw new Error("Write a question.");
  let options: LensOption[] = [];
  let levels: LensLevel[] = [];
  const criteria = { yes: "", no: "" };
  if (type === "choice" || type === "multi") {
    if (!Array.isArray(body.options))
      throw new Error("Invalid options.");
    if (body.options.length < 2 || body.options.length > 11)
      throw new Error("Use between 2 and 11 options.");
    const seen = new Set<string>();
    for (const raw of body.options as Record<string, unknown>[]) {
      const key = String(raw?.key ?? "");
      if (!/^[a-z0-9_]{1,40}$/.test(key) || key === "other")
        throw new Error("Invalid option.");
      if (seen.has(key)) throw new Error("Duplicate option.");
      seen.add(key);
      const label = text(raw?.label, 60);
      if (!label) throw new Error("Fill in the options.");
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
      throw new Error("Use between 2 and 10 levels.");
    for (const raw of body.levels as Record<string, unknown>[]) {
      const label = text(raw?.label, 60);
      if (!label) throw new Error("Fill in the levels.");
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
function setTags(
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
async function assertNoActiveJob(db: D1Database, linkId: string) {
  const active = await db
    .prepare("SELECT id FROM jobs WHERE link_id=? AND status IN ('queued','running')")
    .bind(linkId)
    .first();
  if (active) throw new Error("Wait for the running job to finish.");
}
async function ownedBatch(db: D1Database, userId: string, id: string) {
  const batch = await db
    .prepare("SELECT id,kind FROM batches WHERE id=? AND user_id=?")
    .bind(id, userId)
    .first<{ id: string; kind: string }>();
  if (!batch) throw notFound("batch");
  return batch;
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/library$/,
    policy: "session",
    run: async ({ env, userId }) => json(await library(env, userId)),
  },
  {
    method: "POST",
    pattern: /^\/api\/import$/,
    policy: "session",
    run: async ({ env, userId, body }) => {
      if (
        !Array.isArray(body.urls) ||
        !body.urls.length ||
        body.urls.length > 100 ||
        body.urls.some((u) => typeof u !== "string")
      )
        throw new Error("Import up to 100 URLs per batch.");
      const urls = [...new Set((body.urls as string[]).map(normalizeUrl))],
        now = new Date().toISOString();
      if (!(await consume(env.DB, `links:${userId}`, LIMITS.linksPerUser, urls.length)))
        throw new LimitError("Link limit reached. Try again later.");
      const proposed = urls.map((url) => ({ id: crypto.randomUUID(), url }));
      const results = await env.DB.batch(
        proposed.map((p) =>
          env.DB.prepare(
            "INSERT OR IGNORE INTO links(id,user_id,original_url,url,domain,title,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM links WHERE user_id=? AND (original_url=? OR url=?))",
          ).bind(p.id, userId, p.url, p.url, domainOf(p.url), domainOf(p.url), now, userId, p.url, p.url),
        ),
      );
      const ids = proposed
        .filter((_, i) => results[i]!.meta.changes > 0)
        .map((p) => p.id);
      if (ids.length) await enqueue(env, userId, ids, "extract");
      return json({
        ...(await library(env, userId)),
        imported: ids.length,
        duplicates: urls.length - ids.length,
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/links$/,
    policy: "session",
    run: async ({ env, userId, body }) => {
      if (typeof body.url !== "string") throw new Error("Missing link.");
      const url = normalizeUrl(body.url);
      const names = tagNames(body.tags || []);
      const existing = await env.DB.prepare(
        "SELECT id FROM links WHERE user_id=? AND (original_url=? OR url=?)",
      )
        .bind(userId, url, url)
        .first<{ id: string }>();
      if (!existing && !(await consume(env.DB, `links:${userId}`, LIMITS.linksPerUser)))
        throw new LimitError("Link limit reached. Try again later.");
      const inserted = existing
        ? null
        : await env.DB.prepare(
            "INSERT OR IGNORE INTO links (id,user_id,original_url,url,domain,title,created_at) VALUES (?,?,?,?,?,?,?) RETURNING id",
          )
            .bind(crypto.randomUUID(), userId, url, url, domainOf(url), domainOf(url), new Date().toISOString())
            .first<{ id: string }>();
      const stored =
        existing ||
        inserted ||
        (await env.DB.prepare("SELECT id FROM links WHERE user_id=? AND original_url=?")
          .bind(userId, url)
          .first<{ id: string }>());
      if (!stored) throw new Error("Could not save the link.");
      const id = stored.id;
      const statements = setTags(env.DB, userId, id, names, false);
      if (statements.length) await env.DB.batch(statements);
      if (inserted) await enqueue(env, userId, [id], "extract");
      return json(
        { id, duplicate: !inserted, ...(await library(env, userId)) },
        inserted ? 201 : 200,
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/batches$/,
    policy: "session",
    run: async ({ env, userId, body }) => {
      if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string"))
        throw new Error("Invalid selection.");
      if (!["extract", "autotag", "lens"].includes(String(body.kind)))
        throw new Error("Invalid action.");
      if (body.kind === "lens" && typeof body.lensId !== "string")
        throw new Error("Pick a lens.");
      const batchId = await enqueue(
        env,
        userId,
        body.ids as string[],
        body.kind as "extract" | "autotag" | "lens",
        body.lensId as string | undefined,
      );
      return json({ ...(await library(env, userId)), batchId });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/links\/([^/]+)\/transcript$/,
    policy: "session",
    run: async ({ env, userId, body, params }) => {
      const language = String(body.language || "");
      if (language !== "auto" && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(language))
        throw new Error("Choose an available subtitle language.");
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      const details = link.content_details
        ? (JSON.parse(link.content_details) as { transcript?: { tracks?: { languageCode: string }[] } })
        : {};
      if (!details.transcript?.tracks || (language !== "auto" && !details.transcript.tracks.some((track) => track.languageCode === language)))
        throw new Error("That subtitle track is not available for this video.");
      const batchId = await enqueue(env, userId, [link.id], "extract", undefined, language);
      return json({ ...(await library(env, userId)), batchId });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/batches\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, params }) => {
      const batch = await ownedBatch(env.DB, userId, params[0]!);
      const pending = await env.DB.prepare(
        "SELECT link_id FROM jobs WHERE batch_id=? AND status='queued'",
      )
        .bind(batch.id)
        .all<{ link_id: string }>();
      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          "UPDATE jobs SET status='failed',step='Cancelled',error='Cancelled',completed_at=? WHERE batch_id=? AND status='queued'",
        ).bind(new Date().toISOString(), batch.id),
      ];
      if (batch.kind === "extract" && pending.results.length)
        statements.push(
          env.DB.prepare(
            `UPDATE links SET content_state=${preservedContentStateSql("missing")},content_error=NULL WHERE user_id=? AND id IN (${pending.results.map(() => "?").join(",")}) AND content_state='queued'`,
          ).bind(userId, ...pending.results.map((r) => r.link_id)),
        );
      await env.DB.batch(statements);
      return json({ ...(await library(env, userId)), cancelled: pending.results.length });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/batches\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, params }) => {
      const batch = await ownedBatch(env.DB, userId, params[0]!);
      const [jobs, usage] = await Promise.all([
        env.DB.prepare(
          "SELECT j.*,l.title FROM jobs j JOIN links l ON l.id=j.link_id AND l.user_id=? WHERE j.batch_id=? ORDER BY j.created_at",
        )
          .bind(userId, batch.id)
          .all<Job>(),
        env.DB.prepare(
          `SELECT job_id,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,sum(duration_ms) duration_ms,max(model) model,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls,${OCR_USAGE_COLUMNS} FROM usage_events WHERE user_id=? AND batch_id=? AND status IN ('done','failed') GROUP BY job_id`,
        )
          .bind(userId, batch.id)
          .all<JobUsageRow>(),
      ]);
      const byJob = new Map<string, JobUsage>();
      for (const row of usage.results) {
        let u = byJob.get(row.job_id);
        if (!u)
          byJob.set(
            row.job_id,
            (u = {
              input_tokens: 0,
              output_tokens: 0,
              browser_ms: 0,
              duration_ms: 0,
              model: row.model,
              usd: null,
              unknown_cost_calls: 0,
              ocr: null,
            }),
          );
        u.input_tokens += row.input_tokens ?? 0;
        u.output_tokens += row.output_tokens ?? 0;
        u.browser_ms += row.browser_ms ?? 0;
        u.duration_ms += row.duration_ms ?? 0;
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
      return json({
        jobs: jobs.results.map((j) => ({ ...j, usage: byJob.get(j.id) ?? null })),
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/usage$/,
    policy: "session",
    run: async ({ env, userId }) => {
      const [events, grouped] = await Promise.all([
        env.DB.prepare(
          "SELECT u.id,u.batch_id,u.job_id,u.link_id,u.provider,u.service,u.model,u.operation,u.status,u.input_tokens,u.output_tokens,u.browser_ms,u.estimated_usd,u.rate_snapshot,u.created_at,u.duration_ms,u.error,l.title FROM usage_events u LEFT JOIN links l ON l.id=u.link_id AND l.user_id=u.user_id WHERE u.user_id=? ORDER BY u.created_at DESC LIMIT 1000",
        ).bind(userId).all<UsageEvent>(),
        env.DB.prepare(
          "SELECT sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,count(*) calls,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls FROM usage_events WHERE user_id=? AND status IN ('done','failed')",
        ).bind(userId).all<UsageTotalsRow>(),
      ]);
      const totals = {
        usd: null as number | null,
        input_tokens: 0,
        output_tokens: 0,
        browser_ms: 0,
        calls: 0,
        unknown_cost_calls: 0,
      };
      for (const row of grouped.results) {
        totals.input_tokens += row.input_tokens ?? 0;
        totals.output_tokens += row.output_tokens ?? 0;
        totals.browser_ms += row.browser_ms ?? 0;
        totals.calls += row.calls;
        totals.unknown_cost_calls += row.unknown_cost_calls ?? 0;
        if (row.usd !== null) totals.usd = (totals.usd ?? 0) + row.usd;
      }
      return json({
        events: events.results.map((e) => ({
          ...e,
          usd: e.status === "done" || e.status === "failed" ? e.estimated_usd : null,
        })),
        totals,
      });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/links\/([^/]+)\/related-links$/,
    policy: "session",
    run: async ({ env, userId, body, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url) || typeof body.hidden !== "boolean")
        throw new HttpError(400, "Invalid related link.");
      const url = normalizeUrl(body.url);
      if (body.hidden) {
        await env.DB.prepare("INSERT OR IGNORE INTO hidden_related_links(link_id,url,hidden_at) VALUES(?,?,?)")
          .bind(link.id, url, new Date().toISOString()).run();
      } else {
        await env.DB.prepare("DELETE FROM hidden_related_links WHERE link_id=? AND url=?")
          .bind(link.id, url).run();
      }
      return json(await library(env, userId));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/links\/([^/]+)\/content$/,
    policy: "session",
    run: async ({ env, userId, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      // R2 has no ACLs of its own: only a key recorded on an owned row, under that row's prefix, is read.
      const object =
        link.content_key && contentKeyBelongs(link.content_key, userId, link.id)
          ? await env.CONTENT.get(link.content_key)
          : null;
      return json({ markdown: object ? await object.text() : "" });
    },
  },
  {
    method: "PUT",
    pattern: /^\/api\/links\/([^/]+)\/content$/,
    policy: "session",
    run: async ({ env, userId, body, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      await assertNoActiveJob(env.DB, link.id);
      const markdown = text(body.markdown, 500000);
      if (!markdown) throw new Error("Paste the content.");
      const key = `${contentPrefix(userId, link.id)}${crypto.randomUUID()}.md`;
      await env.CONTENT.put(key, markdown, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
      await env.DB.prepare("UPDATE links SET content_key=?,content_version=content_version+1,content_source='manual',content_state=CASE WHEN content_state='partial' THEN 'partial' ELSE 'ready' END,content_error=NULL,content_updated_at=? WHERE id=? AND user_id=?")
        .bind(key, new Date().toISOString(), link.id, userId).run();
      return json(await library(env, userId));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/links\/([^/]+)\/lenses\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      await env.DB.prepare(
        "DELETE FROM lens_results WHERE link_id=? AND lens_id IN (SELECT id FROM lenses WHERE id=? AND user_id=?)",
      )
        .bind(link.id, params[1], userId)
        .run();
      return json(await library(env, userId));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/lenses$/,
    policy: "session",
    run: async ({ env, userId, body }) => {
      const f = lensFields(body);
      const existing = await env.DB.prepare("SELECT id FROM lenses WHERE user_id=? AND name=?")
        .bind(userId, f.name)
        .first();
      if (existing) throw new HttpError(409, "A lens with that name already exists.");
      await env.DB.prepare(
        "INSERT INTO lenses(id,user_id,name,type,question,options,threshold,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
        .bind(
          crypto.randomUUID(),
          userId,
          f.name,
          f.type,
          f.question,
          JSON.stringify({ options: f.options, levels: f.levels, criteria: f.criteria }),
          f.threshold,
          new Date().toISOString(),
        )
        .run();
      return json(await library(env, userId));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/lenses\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, params }) => {
      const result = await env.DB.prepare("DELETE FROM lenses WHERE id=? AND user_id=?")
        .bind(params[0], userId)
        .run();
      if (!result.meta.changes) throw notFound("lens");
      return json(await library(env, userId));
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/lenses\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, body, params }) => {
      const current = await env.DB.prepare("SELECT id,type FROM lenses WHERE id=? AND user_id=?")
        .bind(params[0], userId)
        .first<{ id: string; type: string }>();
      if (!current) throw notFound("lens");
      const f = lensFields(body);
      const same = await env.DB.prepare("SELECT id FROM lenses WHERE user_id=? AND name=? AND id<>?")
        .bind(userId, f.name, current.id)
        .first();
      if (same) throw new HttpError(409, "A lens with that name already exists.");
      if (current.type !== f.type) throw new HttpError(400, "The lens type can't be changed.");
      await env.DB.prepare(
        "UPDATE lenses SET name=?,type=?,question=?,options=?,threshold=?,version=version+1 WHERE id=? AND user_id=?",
      )
        .bind(
          f.name,
          f.type,
          f.question,
          JSON.stringify({ options: f.options, levels: f.levels, criteria: f.criteria }),
          f.threshold,
          current.id,
          userId,
        )
        .run();
      return json(await library(env, userId));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/links\/([^/]+)\/retry$/,
    policy: "session",
    run: async ({ env, ctx, userId, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      await assertNoActiveJob(env.DB, link.id);
      await env.DB.prepare("UPDATE links SET status='pending', metadata_started_at=? WHERE id=? AND user_id=?")
        .bind(new Date().toISOString(), link.id, userId)
        .run();
      ctx.waitUntil(enrich(env.DB, userId, link.id, link.original_url));
      return json(await library(env, userId));
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/links\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, body, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      await assertNoActiveJob(env.DB, link.id);
      await env.DB.batch(setTags(env.DB, userId, link.id, tagNames(body.tags), true));
      return json(await library(env, userId));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/links\/([^/]+)$/,
    policy: "session",
    run: async ({ env, ctx, userId, params }) => {
      const link = await getOwnedLink(env.DB, userId, params[0]!);
      if (!link) throw notFound();
      await assertNoActiveJob(env.DB, link.id);
      await env.DB.prepare("DELETE FROM links WHERE id=? AND user_id=?").bind(link.id, userId).run();
      // Remove both the owner-scoped prefix and the legacy one used before FAC-41.
      ctx.waitUntil(
        (async () => {
          for (const prefix of [contentPrefix(userId, link.id), `links/${link.id}/`]) {
            let cursor: string | undefined;
            do {
              const page = await env.CONTENT.list({ prefix, cursor });
              if (page.objects.length) await env.CONTENT.delete(page.objects.map((o) => o.key));
              cursor = page.truncated ? page.cursor : undefined;
            } while (cursor);
          }
        })(),
      );
      return json(await library(env, userId));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/tags$/,
    policy: "session",
    run: async ({ env, userId, body }) => {
      const name = tagNames([body.name])[0];
      if (!name) throw new Error("Enter a name.");
      await env.DB.prepare("INSERT OR IGNORE INTO tags (id,user_id,name) VALUES (?,?,?)")
        .bind(crypto.randomUUID(), userId, name)
        .run();
      return json(await library(env, userId));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/tags\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, params }) => {
      const result = await env.DB.prepare("DELETE FROM tags WHERE id=? AND user_id=?")
        .bind(params[0], userId)
        .run();
      if (!result.meta.changes) throw notFound("tag");
      return json(await library(env, userId));
    },
  },
  {
    method: "PATCH",
    pattern: /^\/api\/tags\/([^/]+)$/,
    policy: "session",
    run: async ({ env, userId, body, params }) => {
      const current = await env.DB.prepare("SELECT id,name,description,threshold,version FROM tags WHERE id=? AND user_id=?")
        .bind(params[0], userId)
        .first<Tag>();
      if (!current) throw notFound("tag");
      const name = tagNames([body.name])[0];
      if (!name) throw new Error("Enter a name.");
      const same = await env.DB.prepare("SELECT id FROM tags WHERE user_id=? AND name=? AND id<>?")
        .bind(userId, name, current.id)
        .first();
      if (same) throw new HttpError(409, "A tag with that name already exists.");
      await env.DB.prepare(
        "UPDATE tags SET name=?,description=?,threshold=?,version=version+1 WHERE id=? AND user_id=?",
      )
        .bind(
          name,
          body.description === undefined ? current.description : text(body.description, 2000),
          body.threshold === undefined ? current.threshold : threshold(body.threshold),
          current.id,
          userId,
        )
        .run();
      return json(await library(env, userId));
    },
  },
];

function match(method: string, path: string) {
  let pathMatched = false;
  for (const route of routes) {
    const m = path.match(route.pattern);
    if (!m) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    try {
      return { route, params: m.slice(1).map(decodeURIComponent) };
    } catch {
      return null;
    }
  }
  return pathMatched ? "method" : null;
}

let configErrorLogged = false;

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  let config: AppConfig;
  try {
    config = readConfig(env);
  } catch (error) {
    if (!configErrorLogged) {
      configErrorLogged = true;
      console.error(JSON.stringify({ event: "config_error", message: error instanceof ConfigError ? error.message : "invalid" }));
    }
    return json({ error: "Linklog is not configured. Authentication is unavailable." }, 503);
  }
  if (!hostAllowed(config, url)) return json({ error: "Host not allowed." }, 403);

  // 1. Auth protocol first, with the untouched Request (own methods, bodies, GET callbacks, CSRF).
  if (url.pathname === AUTH_BASE_PATH || url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    try {
      return await createAuth(env, ctx, config).handler(request);
    } catch {
      console.error(JSON.stringify({ event: "auth_handler_error" }));
      return json({ error: "Authentication failed. Try again." }, 500);
    }
  }

  // 2. Undeclared routes get nothing, not even a session lookup.
  const found = match(request.method, url.pathname);
  if (!found) return json({ error: "Not found." }, 404);
  if (found === "method") return json({ error: "Method not allowed." }, 405);
  const { route, params } = found;

  // 3. Same-origin JSON for writes. Origin is required: the browser always sends it on these
  //    fetches, and cookies alone must never authorize a cross-site write.
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (origin !== config.baseURL) return json({ error: "Origin not allowed." }, 403);
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin") return json({ error: "Origin not allowed." }, 403);
    if (!request.headers.get("content-type")?.includes("application/json"))
      return json({ error: "JSON required." }, 415);
  }

  // 4. Policy: every current app route needs a valid session.
  let principal: Principal;
  const auth: Auth = createAuth(env, ctx, config);
  try {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return json({ error: "Sign in to continue." }, 401);
    principal = { kind: "session", userId: session.user.id, sessionId: session.session.id };
  } catch {
    console.error(JSON.stringify({ event: "session_lookup_failed" }));
    return json({ error: "Sign in to continue." }, 401);
  }

  try {
    if (request.method !== "GET" && !(await consume(env.DB, `writes:${principal.userId}`, LIMITS.writesPerUser)))
      throw new LimitError();
    if (Number(request.headers.get("content-length") || 0) > 2100000)
      return json({ error: "Request too large." }, 413);
    let body: Record<string, unknown> = {};
    if (request.method !== "GET") {
      const raw = await request.text();
      if (raw.length > 2100000) return json({ error: "Request too large." }, 413);
      body = raw ? JSON.parse(raw) : {};
      if (!body || Array.isArray(body) || typeof body !== "object")
        throw new Error("Invalid request.");
    }
    return await route.run({ request, env, ctx, principal, userId: principal.userId, body, params });
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    if (error instanceof LimitError) return json({ error: error.message }, 429);
    const message = error instanceof Error ? error.message : "";
    if (/D1_|SQLITE|constraint|owner|cross-owner/i.test(message)) {
      console.error("Database operation failed");
      return json({ error: "Could not save. Try again." }, 500);
    }
    return json({ error: message || "Invalid request." }, 400);
  }
}
