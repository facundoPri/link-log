import { normalizeUrl, domainOf } from "../src/url";
import { extractMetadata } from "./metadata";
import type { Link, Tag } from "../src/types";

import { json, library, text, threshold } from "./store";
import { enqueue, dispatch, recover, LinkWorkflow } from "./jobs";
import { getRates, emptyRates } from "./usage";
import type { QueryConfig, Rates } from "../src/types";
export { LinkWorkflow };
async function enrich(db: D1Database, id: string, url: string) {
  try {
    const m = await extractMetadata(url);
    await db
      .prepare(
        "UPDATE links SET url=?, domain=?, title=?, description=?, image=?, favicon=?, status=? WHERE id=?",
      )
      .bind(
        m.url,
        m.domain,
        m.title,
        m.description,
        m.image,
        m.favicon,
        m.status,
        id,
      )
      .run();
  } catch {
    await db
      .prepare("UPDATE links SET status='failed' WHERE id=?")
      .bind(id)
      .run();
  }
}
function tagNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((t) => typeof t !== "string" || t.trim().length > 40)
  )
    throw new Error("Usá hasta 20 etiquetas de 40 caracteres.");
  return [
    ...new Set(
      value
        .map((t) => (t as string).trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ];
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
            "La biblioteca remota requiere configurar autenticación antes de habilitarse.",
        },
        403,
      );
    if (request.method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin)
        return json({ error: "Origen no permitido." }, 403);
      if (!request.headers.get("content-type")?.includes("application/json"))
        return json({ error: "Se requiere JSON." }, 415);
    }
    try {
      if (path === "/api/library" && request.method === "GET")
        return json(await library(env));
      if (Number(request.headers.get("content-length") || 0) > 2100000)
        return json({ error: "Solicitud demasiado grande." }, 413);
      let body: Record<string, unknown> = {};
      if (request.method !== "GET") {
        const raw = await request.text();
        if (raw.length > 2100000)
          return json({ error: "Solicitud demasiado grande." }, 413);
        body = JSON.parse(raw);
        if (!body || Array.isArray(body) || typeof body !== "object")
          throw new Error("Solicitud inválida.");
      }
      if (path === "/api/import" && request.method === "POST") {
        if (
          !Array.isArray(body.urls) ||
          !body.urls.length ||
          body.urls.length > 100 ||
          body.urls.some((u) => typeof u !== "string")
        )
          throw new Error("Importá hasta 100 URLs por lote.");
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
        if (typeof body.url !== "string") throw new Error("Falta el link.");
        const url = normalizeUrl(body.url);
        const names = tagNames(body.tags || []);
        const existing = await env.DB.prepare(
          "SELECT id FROM links WHERE original_url=? OR url=?",
        )
          .bind(url, url)
          .first<{ id: string }>();
        const proposedId = crypto.randomUUID();
        const inserted = existing
          ? null
          : await env.DB.prepare(
              "INSERT OR IGNORE INTO links (id,original_url,url,domain,title,created_at) VALUES (?,?,?,?,?,?) RETURNING id",
            )
              .bind(
                proposedId,
                url,
                url,
                domainOf(url),
                domainOf(url),
                new Date().toISOString(),
              )
              .first<{ id: string }>();
        const stored =
          existing ||
          inserted ||
          (await env.DB.prepare("SELECT id FROM links WHERE original_url=?")
            .bind(url)
            .first<{ id: string }>());
        if (!stored) throw new Error("No se pudo guardar el link.");
        const id = stored.id;
        const statements = setTags(env.DB, id, names, false);
        if (statements.length) await env.DB.batch(statements);
        if (inserted) await enqueue(env, [id], "extract");
        return json(
          { id, duplicate: !inserted, ...(await library(env)) },
          inserted ? 201 : 200,
        );
      }

      if (path === "/api/batches" && request.method === "POST") {
        if (
          !Array.isArray(body.ids) ||
          body.ids.some((id) => typeof id !== "string")
        )
          throw new Error("Selección inválida.");
        if (!["extract", "autotag", "query"].includes(String(body.kind)))
          throw new Error("Acción inválida.");
        let query: QueryConfig | undefined;
        if (body.kind === "query") {
          const q = body.query as QueryConfig;
          if (!q || !["noul", "choice"].includes(q.type))
            throw new Error("Consulta inválida.");
          const question = text(q.question, 2000);
          if (!question) throw new Error("Escribí una pregunta.");
          const options: Record<string, string> = {};
          if (q.type === "choice") {
            if (
              !q.options ||
              typeof q.options !== "object" ||
              Array.isArray(q.options)
            )
              throw new Error("Opciones inválidas.");
            const entries = Object.entries(q.options);
            if (entries.length < 2 || entries.length > 12)
              throw new Error("Usá entre 2 y 12 opciones.");
            for (const [key, value] of entries) {
              if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key))
                throw new Error("Opción inválida.");
              options[key] = text(value, 500);
              if (!options[key]) throw new Error("Completá las opciones.");
            }
          }
          query = {
            type: q.type,
            question,
            options,
            threshold: threshold(q.threshold),
          };
        }
        const batchId = await enqueue(
          env,
          body.ids as string[],
          body.kind as "extract" | "autotag" | "query",
          { query },
        );
        return json({ ...(await library(env)), batchId });
      }
      const batchMatch = path.match(/^\/api\/batches\/([^/]+)$/);
      if (batchMatch && request.method === "GET")
        return json({
          jobs: (
            await env.DB.prepare(
              "SELECT j.*,l.title FROM jobs j JOIN links l ON l.id=j.link_id WHERE batch_id=? ORDER BY j.created_at",
            )
              .bind(batchMatch[1])
              .all()
          ).results,
        });
      if (path === "/api/usage" && request.method === "GET")
        return json({
          events: (
            await env.DB.prepare(
              "SELECT u.*,l.title FROM usage_events u LEFT JOIN links l ON l.id=u.link_id ORDER BY u.created_at DESC LIMIT 1000",
            ).all()
          ).results,
          rates: await getRates(env),
        });
      if (path === "/api/rates" && request.method === "PUT") {
        const rates = { ...emptyRates };
        for (const key of Object.keys(rates) as (keyof Rates)[]) {
          const value = body[key];
          if (
            value !== null &&
            (typeof value !== "number" || !Number.isFinite(value) || value < 0)
          )
            throw new Error("Tarifa inválida.");
          rates[key] = value as number | null;
        }
        await env.DB.prepare(
          "INSERT INTO settings(key,value) VALUES('rates',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
          .bind(JSON.stringify(rates))
          .run();
        return json({ rates });
      }
      const contentMatch = path.match(/^\/api\/links\/([^/]+)\/content$/);
      if (contentMatch) {
        const link = await env.DB.prepare("SELECT * FROM links WHERE id=?")
          .bind(contentMatch[1])
          .first<Link>();
        if (!link) return json({ error: "El link ya no existe." }, 404);
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
            throw new Error("Esperá a que termine el trabajo en curso.");
          const markdown = text(body.markdown, 500000);
          if (!markdown) throw new Error("Pegá el contenido.");
          const key = `links/${link.id}/${crypto.randomUUID()}.md`;
          await env.CONTENT.put(key, markdown, {
            httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          });
          await env.DB.prepare(
            "UPDATE links SET content_key=?,content_version=content_version+1,content_source='manual',content_state='ready',content_error=NULL,content_updated_at=? WHERE id=?",
          )
            .bind(key, new Date().toISOString(), link.id)
            .run();
          return json(await library(env));
        }
        return json({ error: "Método no permitido." }, 405);
      }
      const match = path.match(/^\/api\/links\/([^/]+)(\/retry)?$/);
      if (match) {
        const id = match[1]!;
        const link = await env.DB.prepare("SELECT * FROM links WHERE id=?")
          .bind(id)
          .first<Link>();
        if (!link) return json({ error: "El link ya no existe." }, 404);
        if (request.method !== "GET") {
          const active = await env.DB.prepare(
            "SELECT id FROM jobs WHERE link_id=? AND status IN ('queued','running')",
          )
            .bind(id)
            .first();
          if (active)
            throw new Error("Esperá a que termine el trabajo en curso.");
        }
        if (match[2] && request.method === "POST") {
          await env.DB.prepare(
            "UPDATE links SET status='pending', metadata_started_at=? WHERE id=?",
          )
            .bind(new Date().toISOString(), id)
            .run();
          ctx.waitUntil(enrich(env.DB, id, link.original_url));
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
        } else return json({ error: "Método no permitido." }, 405);
        return json(await library(env));
      }
      if (path === "/api/tags" && request.method === "POST") {
        const name = tagNames([body.name])[0];
        if (!name) throw new Error("Escribí un nombre.");
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
          if (!name) throw new Error("Escribí un nombre.");
          const same = await env.DB.prepare(
            "SELECT id FROM tags WHERE name=? AND id<>?",
          )
            .bind(name, tagMatch[1])
            .first();
          if (same)
            return json(
              { error: "Ya existe una etiqueta con ese nombre." },
              409,
            );
          const current = await env.DB.prepare("SELECT * FROM tags WHERE id=?")
            .bind(tagMatch[1])
            .first<Tag>();
          if (!current)
            return json({ error: "La etiqueta ya no existe." }, 404);
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
        } else return json({ error: "Método no permitido." }, 405);
        return json(await library(env));
      }
      return json({ error: "No encontrado." }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/D1_|SQLITE|constraint/i.test(message)) {
        console.error("Database operation failed");
        return json({ error: "No se pudo guardar. Intentá de nuevo." }, 500);
      }
      return json({ error: message || "Solicitud inválida." }, 400);
    }
  },
} satisfies ExportedHandler<Env, { id: string }>;
