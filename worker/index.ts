import { normalizeUrl, domainOf } from "../src/url";
import type { LensOption, LensLevel, Link, Tag } from "../src/types";

import { json, library, text, threshold } from "./store";
import { enqueue, dispatch, recover, LinkWorkflow } from "./jobs";
import { restoredContentStateSql } from "./content-state";
import type { Job, JobUsage, UsageEvent } from "../src/types";
import { OCR_USAGE_COLUMNS } from "./usage";
import { browserRoute, cleanupBrowser } from "./browser";
import { addLink } from "./links";
import { settleAttention } from "./attention";
export { LinkWorkflow };
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
function setTags(
  db: D1Database,
  id: string,
  names: string[],
  replace: boolean,
) {
  const statements = replace
    ? [db.prepare("DELETE FROM link_tags WHERE link_id=?").bind(id)]
    : [];
  for (const name of names) {
    statements.push(
      db
        .prepare("INSERT OR IGNORE INTO tags (id,name) VALUES (?,?)")
        .bind(crypto.randomUUID(), name),
    );
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO link_tags (link_id,tag_id) SELECT ?,id FROM tags WHERE name=?",
        )
        .bind(id, name),
    );
  }
  return statements;
}
export default {
  queue: dispatch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(recover(env));
    ctx.waitUntil(cleanupBrowser(env));
  },
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
    // This personal MVP is local-only until a real authentication boundary is configured.
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(request.url).hostname,
      )
    )
      return json(
        {
          error:
            "The remote library requires configuring authentication before it can be enabled.",
        },
        403,
      );
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin)
        return json({ error: "Origin not allowed." }, 403);
      if (!request.headers.get("content-type")?.includes("application/json"))
        return json({ error: "JSON required." }, 415);
    }
    try {
      if (path === "/api/library" && request.method === "GET")
        return json(await library(env));
      if (Number(request.headers.get("content-length") || 0) > 2100000)
        return json({ error: "Request too large." }, 413);
      let body: Record<string, unknown> = {};
      if (request.method !== "GET") {
        const raw = await request.text();
        if (raw.length > 2100000)
          return json({ error: "Request too large." }, 413);
        body = raw ? JSON.parse(raw) : {};
        if (!body || Array.isArray(body) || typeof body !== "object")
          throw new Error("Invalid request.");
      }
      if (path.startsWith("/api/browser/")) {
        const response = await browserRoute(env, path, request.method, body);
        if (response) return response;
      }
      if (path === "/api/import" && request.method === "POST") {
        if (
          !Array.isArray(body.urls) ||
          !body.urls.length ||
          body.urls.length > 100 ||
          body.urls.some((u) => typeof u !== "string")
        )
          throw new Error("Import up to 100 URLs per batch.");
        const urls = [...new Set((body.urls as string[]).map(normalizeUrl))],
          now = new Date().toISOString();
        const proposed = urls.map((url) => ({ id: crypto.randomUUID(), url }));
        const results = await env.DB.batch(
          proposed.map((p) =>
            env.DB.prepare(
              "INSERT OR IGNORE INTO links(id,original_url,url,domain,title,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM links WHERE original_url=? OR url=?)",
            ).bind(
              p.id,
              p.url,
              p.url,
              domainOf(p.url),
              domainOf(p.url),
              now,
              p.url,
              p.url,
            ),
          ),
        );
        const ids = proposed
          .filter((_, i) => results[i]!.meta.changes > 0)
          .map((p) => p.id);
        if (ids.length) await enqueue(env, ids, "extract");
        return json({
          ...(await library(env)),
          imported: ids.length,
          duplicates: urls.length - ids.length,
        });
      }
      if (path === "/api/links" && request.method === "POST") {
        if (typeof body.url !== "string") throw new Error("Missing link.");
        const names = tagNames(body.tags || []);
        const { id, created } = await addLink(env, body.url);
        const statements = setTags(env.DB, id, names, false);
        if (statements.length) await env.DB.batch(statements);
        if (created) await enqueue(env, [id], "extract");
        return json(
          { id, duplicate: !created, ...(await library(env)) },
          created ? 201 : 200,
        );
      }

      if (path === "/api/batches" && request.method === "POST") {
        if (
          !Array.isArray(body.ids) ||
          body.ids.some((id) => typeof id !== "string")
        )
          throw new Error("Invalid selection.");
        if (!["extract", "autotag", "lens"].includes(String(body.kind)))
          throw new Error("Invalid action.");
        if (body.kind === "lens" && typeof body.lensId !== "string")
          throw new Error("Pick a lens.");
        const batchId = await enqueue(
          env,
          body.ids as string[],
          body.kind as "extract" | "autotag" | "lens",
          body.lensId as string | undefined,
        );
        return json({ ...(await library(env)), batchId });
      }
      const transcriptMatch = path.match(/^\/api\/links\/([^/]+)\/transcript$/);
      if (transcriptMatch && request.method === "POST") {
        const language = String(body.language || "");
        if (language !== "auto" && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(language)) throw new Error("Choose an available subtitle language.");
        const link = await env.DB.prepare("SELECT url,content_details FROM links WHERE id=?")
          .bind(transcriptMatch[1]).first<{url: string; content_details: string | null}>();
        if (!link) return json({ error: "The link no longer exists." }, 404);
        const details = link.content_details ? JSON.parse(link.content_details) as { transcript?: { tracks?: { languageCode: string }[] } } : {};
        if (!details.transcript?.tracks || (language !== "auto" && !details.transcript.tracks.some((track) => track.languageCode === language)))
          throw new Error("That subtitle track is not available for this video.");
        const batchId = await enqueue(env, [transcriptMatch[1]!], "extract", undefined, { track: language });
        return json({ ...(await library(env)), batchId });
      }
      const batchMatch = path.match(/^\/api\/batches\/([^/]+)$/);
      if (batchMatch && request.method === "DELETE") {
        const batchId = batchMatch[1]!;
        const batch = await env.DB.prepare(
          "SELECT kind FROM batches WHERE id=?",
        )
          .bind(batchId)
          .first<{ kind: string }>();
        if (!batch)
          return json({ error: "The batch no longer exists." }, 404);
        const pending = await env.DB.prepare(
          "SELECT link_id FROM jobs WHERE batch_id=? AND status='queued'",
        )
          .bind(batchId)
          .all<{ link_id: string }>();
        const statements: D1PreparedStatement[] = [
          env.DB.prepare(
            "UPDATE jobs SET status='failed',step='Cancelled',error='Cancelled',completed_at=? WHERE batch_id=? AND status='queued'",
          ).bind(new Date().toISOString(), batchId),
        ];
        if (batch.kind === "extract" && pending.results.length)
          statements.push(
            env.DB.prepare(
              `UPDATE links SET content_state=${restoredContentStateSql} WHERE id IN (${pending.results.map(() => "?").join(",")}) AND content_state='queued'`,
            ).bind(...pending.results.map((r) => r.link_id)),
          );
        await env.DB.batch(statements);
        return json({
          ...(await library(env)),
          cancelled: pending.results.length,
        });
      }
      if (batchMatch && request.method === "GET") {
        const [jobs, usage] = await Promise.all([
          env.DB.prepare(
            "SELECT j.*,coalesce(l.title,bt.title) title FROM jobs j LEFT JOIN links l ON l.id=j.link_id LEFT JOIN browser_targets bt ON bt.id=j.target_id WHERE batch_id=? ORDER BY j.created_at",
          )
            .bind(batchMatch[1])
            .all<Job>(),
          env.DB.prepare(
            `SELECT job_id,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,sum(duration_ms) duration_ms,max(model) model,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls,${OCR_USAGE_COLUMNS} FROM usage_events WHERE batch_id=? AND status IN ('done','failed') GROUP BY job_id`,
          )
            .bind(batchMatch[1])
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
          jobs: jobs.results.map((j) => ({
            ...j,
            usage: byJob.get(j.id) ?? null,
          })),
        });
      }
      if (path === "/api/usage" && request.method === "GET") {
        const [events, grouped] = await Promise.all([
          env.DB.prepare(
            "SELECT u.*,coalesce(l.title,bt.title) title FROM usage_events u LEFT JOIN links l ON l.id=u.link_id LEFT JOIN jobs j ON j.id=u.job_id LEFT JOIN browser_targets bt ON bt.id=j.target_id ORDER BY u.created_at DESC LIMIT 1000",
          ).all<UsageEvent>(),
          env.DB.prepare(
            "SELECT sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,count(*) calls,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls FROM usage_events WHERE status IN ('done','failed')",
          ).all<UsageTotalsRow>(),
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
      }
      const relatedMatch = path.match(/^\/api\/links\/([^/]+)\/related-links$/);
      if (relatedMatch) {
        if (request.method !== "PUT") return json({ error: "Method not allowed." }, 405);
        const link = await env.DB.prepare("SELECT id FROM links WHERE id=?")
          .bind(relatedMatch[1]).first<{ id: string }>();
        if (!link) return json({ error: "The link no longer exists." }, 404);
        if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url) || typeof body.hidden !== "boolean")
          return json({ error: "Invalid related link." }, 400);
        const url = normalizeUrl(body.url);
        if (body.hidden) {
          await env.DB.prepare("INSERT OR IGNORE INTO hidden_related_links(link_id,url,hidden_at) VALUES(?,?,?)")
            .bind(link.id, url, new Date().toISOString()).run();
        } else {
          await env.DB.prepare("DELETE FROM hidden_related_links WHERE link_id=? AND url=?")
            .bind(link.id, url).run();
        }
        return json(await library(env));
      }
      const contentMatch = path.match(/^\/api\/links\/([^/]+)\/content$/);
      if (contentMatch) {
        const link = await env.DB.prepare("SELECT * FROM links WHERE id=?")
          .bind(contentMatch[1])
          .first<Link>();
        if (!link) return json({ error: "The link no longer exists." }, 404);
        if (request.method === "GET") {
          const object = link.content_key
            ? await env.CONTENT.get(link.content_key)
            : null;
          return json({ markdown: object ? await object.text() : "" });
        }
        if (request.method === "PUT") {
          const active = await env.DB.prepare(
            "SELECT id FROM jobs WHERE link_id=? AND status IN ('queued','running')",
          )
            .bind(link.id)
            .first();
          if (active)
            throw new Error("Wait for the running job to finish.");
          const markdown = text(body.markdown, 500000);
          if (!markdown) throw new Error("Paste the content.");
          const key = `links/${link.id}/${crypto.randomUUID()}.md`;
          await env.CONTENT.put(key, markdown, {
            httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          });
          await env.DB.prepare("UPDATE links SET content_key=?,content_version=content_version+1,content_source='manual',content_state=CASE WHEN content_state='partial' THEN 'partial' ELSE 'ready' END,content_error=NULL,content_reason=NULL,content_updated_at=? WHERE id=?")
            .bind(key, new Date().toISOString(), link.id).run();
          // Pasted content resolves a failed extraction like a successful one.
          await settleAttention(env.DB, link.id, { content: "ok" });
          return json(await library(env));
        }
        return json({ error: "Method not allowed." }, 405);
      }
      const lensResultMatch = path.match(
        /^\/api\/links\/([^/]+)\/lenses\/([^/]+)$/,
      );
      if (lensResultMatch && request.method === "DELETE") {
        await env.DB.prepare(
          "DELETE FROM lens_results WHERE link_id=? AND lens_id=?",
        )
          .bind(lensResultMatch[1], lensResultMatch[2])
          .run();
        return json(await library(env));
      }
      if (path === "/api/lenses" && request.method === "POST") {
        const f = lensFields(body);
        const existing = await env.DB.prepare(
          "SELECT id FROM lenses WHERE name=?",
        )
          .bind(f.name)
          .first();
        if (existing)
          return json(
            { error: "A lens with that name already exists." },
            409,
          );
        const scope = body.scope === undefined ? "library" : String(body.scope);
        if (scope !== "library" && scope !== "browser")
          throw new Error("Invalid lens scope.");
        await env.DB.prepare(
          "INSERT INTO lenses(id,name,type,question,options,threshold,created_at,scope) VALUES(?,?,?,?,?,?,?,?)",
        )
          .bind(
            crypto.randomUUID(),
            f.name,
            f.type,
            f.question,
            JSON.stringify({ options: f.options, levels: f.levels, criteria: f.criteria }),
            f.threshold,
            new Date().toISOString(),
            scope,
          )
          .run();
        return json(await library(env));
      }
      const lensMatch = path.match(/^\/api\/lenses\/([^/]+)$/);
      if (lensMatch) {
        if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM lenses WHERE id=?")
            .bind(lensMatch[1])
            .run();
        } else if (request.method === "PATCH") {
          const f = lensFields(body);
          const same = await env.DB.prepare(
            "SELECT id FROM lenses WHERE name=? AND id<>?",
          )
            .bind(f.name, lensMatch[1])
            .first();
          if (same)
            return json(
              { error: "A lens with that name already exists." },
              409,
            );
          const current = await env.DB.prepare(
            "SELECT id,type FROM lenses WHERE id=?",
          )
            .bind(lensMatch[1])
            .first<{ type: string }>();
          if (!current)
            return json({ error: "The lens no longer exists." }, 404);
          if (current.type !== f.type)
            return json(
              { error: "The lens type can't be changed." },
              400,
            );
          await env.DB.prepare(
            "UPDATE lenses SET name=?,type=?,question=?,options=?,threshold=?,version=version+1 WHERE id=?",
          )
            .bind(
              f.name,
              f.type,
              f.question,
              JSON.stringify({ options: f.options, levels: f.levels, criteria: f.criteria }),
              f.threshold,
              lensMatch[1],
            )
            .run();
        } else return json({ error: "Method not allowed." }, 405);
        return json(await library(env));
      }
      const dismissMatch = path.match(/^\/api\/links\/([^/]+)\/dismiss$/);
      if (dismissMatch && request.method === "POST") {
        // Only leaves the Needs attention list; a later final failure brings it back.
        await env.DB.prepare("UPDATE links SET attention_kind=NULL,attention_reason=NULL,attention_at=NULL WHERE id=?")
          .bind(dismissMatch[1]).run();
        return json(await library(env));
      }
      const match = path.match(/^\/api\/links\/([^/]+)(\/retry)?$/);
      if (match) {
        const id = match[1]!;
        const link = await env.DB.prepare("SELECT * FROM links WHERE id=?")
          .bind(id)
          .first<Link>();
        if (!link) return json({ error: "The link no longer exists." }, 404);
        if (request.method !== "GET") {
          const active = await env.DB.prepare(
            "SELECT id FROM jobs WHERE link_id=? AND status IN ('queued','running')",
          )
            .bind(id)
            .first();
          if (active)
            throw new Error("Wait for the running job to finish.");
        }
        if (match[2] && request.method === "POST") {
          // Runs only the failed step, through the queue. Needs attention stays until that step succeeds.
          const batchId = body.step === "content"
            ? await enqueue(env, [id], "extract", undefined, { step: "content" })
            : await enqueue(env, [id], "preview");
          return json({ ...(await library(env)), batchId });
        } else if (request.method === "PATCH") {
          await env.DB.batch(setTags(env.DB, id, tagNames(body.tags), true));
        } else if (request.method === "DELETE") {
          await env.DB.prepare("DELETE FROM links WHERE id=?").bind(id).run();
          ctx.waitUntil(
            (async () => {
              let cursor: string | undefined;
              do {
                const page = await env.CONTENT.list({
                  prefix: `links/${id}/`,
                  cursor,
                });
                if (page.objects.length)
                  await env.CONTENT.delete(page.objects.map((o) => o.key));
                cursor = page.truncated ? page.cursor : undefined;
              } while (cursor);
            })(),
          );
        } else return json({ error: "Method not allowed." }, 405);
        return json(await library(env));
      }
      if (path === "/api/tags" && request.method === "POST") {
        const name = tagNames([body.name])[0];
        if (!name) throw new Error("Enter a name.");
        await env.DB.prepare(
          "INSERT OR IGNORE INTO tags (id,name) VALUES (?,?)",
        )
          .bind(crypto.randomUUID(), name)
          .run();
        return json(await library(env));
      }
      const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
      if (tagMatch) {
        if (request.method === "DELETE")
          await env.DB.prepare("DELETE FROM tags WHERE id=?")
            .bind(tagMatch[1])
            .run();
        else if (request.method === "PATCH") {
          const name = tagNames([body.name])[0];
          if (!name) throw new Error("Enter a name.");
          const same = await env.DB.prepare(
            "SELECT id FROM tags WHERE name=? AND id<>?",
          )
            .bind(name, tagMatch[1])
            .first();
          if (same)
            return json(
              { error: "A tag with that name already exists." },
              409,
            );
          const current = await env.DB.prepare("SELECT * FROM tags WHERE id=?")
            .bind(tagMatch[1])
            .first<Tag>();
          if (!current)
            return json({ error: "The tag no longer exists." }, 404);
          await env.DB.prepare(
            "UPDATE tags SET name=?,description=?,threshold=?,version=version+1 WHERE id=?",
          )
            .bind(
              name,
              body.description === undefined
                ? current.description
                : text(body.description, 2000),
              body.threshold === undefined
                ? current.threshold
                : threshold(body.threshold),
              tagMatch[1],
            )
            .run();
        } else return json({ error: "Method not allowed." }, 405);
        return json(await library(env));
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/D1_|SQLITE|constraint/i.test(message)) {
        console.error("Database operation failed");
        return json({ error: "Could not save. Try again." }, 500);
      }
      return json({ error: message || "Invalid request." }, 400);
    }
  },
} satisfies ExportedHandler<Env, { id: string }>;
