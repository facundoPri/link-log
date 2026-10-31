import { Hono } from "hono";
import { contentKeyBelongs, contentPrefix, getOwnedLink, json, library, text } from "../store";
import { enqueue, linkIdle } from "../jobs";
import { settleAttention } from "../attention";
import { canUsePreview, readPreview, storePreview, usePreviewStatement, dropUnusedPreview } from "../preview-content";
import { addLinks } from "../links";
import { badRequest, HttpError, notFound, ownerOf, type AppEnv } from "../http/context";
import { assertNoActiveJob, enrich, setTags, tagNames, urlInput } from "./shared";

/** Library, links and their content. Every handler runs behind requireSession. */
export const linkRoutes = new Hono<AppEnv>()
  .get("/library", async (c) => json(await library(c.env, ownerOf(c))))
  .post("/import", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    if (
      !Array.isArray(body.urls) ||
      !body.urls.length ||
      body.urls.length > 100 ||
      body.urls.some((u) => typeof u !== "string")
    )
      throw badRequest("Import up to 100 URLs per batch.");
    // Every URL must be valid; quotas are admitted before anything is saved (see addLinks).
    const urls = [...new Set((body.urls as string[]).map(urlInput))];
    const results = await addLinks(env, userId, urls);
    const imported = results.filter((r) => "created" in r && r.created).length;
    return json({ ...(await library(env, userId)), imported, duplicates: urls.length - imported });
  })
  .post("/links", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    if (typeof body.url !== "string") throw badRequest("Missing link.");
    const names = tagNames(body.tags || []);
    const [result] = await addLinks(env, userId, [body.url]);
    if (!result || "error" in result) throw badRequest(result?.error ?? "Invalid link.");
    const { id, created } = result;
    const statements = setTags(env.DB, userId, id, names, false);
    if (statements.length) await env.DB.batch(statements);
    return json({ id, duplicate: !created, ...(await library(env, userId)) }, created ? 201 : 200);
  })
  .post("/links/:id/transcript", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const language = String(body.language || "");
    if (language !== "auto" && !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/.test(language))
      throw badRequest("Choose an available subtitle language.");
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    const details = link.content_details
      ? (JSON.parse(link.content_details) as { transcript?: { tracks?: { languageCode: string }[] } })
      : {};
    if (!details.transcript?.tracks || (language !== "auto" && !details.transcript.tracks.some((track) => track.languageCode === language)))
      throw badRequest("That subtitle track is not available for this video.");
    const { id: batchId } = await enqueue(env, userId, [link.id], "extract", undefined, { track: language });
    return json({ ...(await library(env, userId)), batchId });
  })
  .put("/links/:id/related-links", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    if (typeof body.url !== "string" || !/^https?:\/\//i.test(body.url) || typeof body.hidden !== "boolean")
      throw new HttpError(400, "Invalid related link.");
    const url = urlInput(body.url);
    if (body.hidden)
      await env.DB.prepare("INSERT OR IGNORE INTO hidden_related_links(link_id,url,hidden_at) VALUES(?,?,?)")
        .bind(link.id, url, new Date().toISOString()).run();
    else
      await env.DB.prepare("DELETE FROM hidden_related_links WHERE link_id=? AND url=?").bind(link.id, url).run();
    return json(await library(env, userId));
  })
  .get("/links/:id/content", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    // R2 has no ACLs of its own: only a key recorded on an owned row, under that row's prefix, is read.
    const object =
      link.content_key && contentKeyBelongs(link.content_key, userId, link.id)
        ? await env.CONTENT.get(link.content_key)
        : null;
    return json({ markdown: object ? await object.text() : "" });
  })
  .put("/links/:id/content", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    await assertNoActiveJob(env.DB, link.id);
    const markdown = text(body.markdown, 500000);
    if (!markdown) throw badRequest("Paste the content.");
    const key = `${contentPrefix(userId, link.id)}${crypto.randomUUID()}.md`;
    await env.CONTENT.put(key, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    await env.DB.prepare("UPDATE links SET content_key=?,content_version=content_version+1,content_source='manual',content_state=CASE WHEN content_state='partial' AND content_source IS NOT 'preview' THEN 'partial' ELSE 'ready' END,content_error=NULL,content_reason=NULL,content_updated_at=? WHERE id=? AND user_id=?")
      .bind(key, new Date().toISOString(), link.id, userId).run();
    await settleAttention(env.DB, link.id, { content: "ok" });
    return json(await library(env, userId));
  })
  .delete("/links/:id/lenses/:lensId", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    await env.DB.prepare("DELETE FROM lens_results WHERE link_id=? AND lens_id IN (SELECT id FROM lenses WHERE id=? AND user_id=?)")
      .bind(link.id, c.req.param("lensId"), userId).run();
    return json(await library(env, userId));
  })
  .post("/links/:id/retry", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    await assertNoActiveJob(env.DB, link.id);
    const { id: batchId } = c.get("body").step === "content"
      ? await enqueue(env, userId, [link.id], "extract", undefined, { step: "content" })
      : await enqueue(env, userId, [link.id], "preview");
    return json({ ...(await library(env, userId)), batchId });
  })
  .post("/links/:id/dismiss", async (c) => {
    const userId = ownerOf(c), id = c.req.param("id");
    if (!await getOwnedLink(c.env.DB, userId, id)) throw notFound();
    await c.env.DB.prepare("UPDATE links SET attention_kind=NULL,attention_reason=NULL,attention_at=NULL WHERE id=? AND user_id=?").bind(id, userId).run();
    return json(await library(c.env, userId));
  })
  .post("/links/:id/use-preview", async (c) => {
    const env = c.env, userId = ownerOf(c), id = c.req.param("id");
    const link = await readPreview(env.DB, userId, id);
    if (!link) throw notFound();
    await assertNoActiveJob(env.DB, id);
    if (link.content_key) throw badRequest("This link already has content.");
    if (link.content_state !== "failed") throw badRequest("The content hasn't failed; extract it first.");
    if (!canUsePreview(link)) throw badRequest("There is no preview to use.");
    const key = `${contentPrefix(userId, id)}${crypto.randomUUID()}-preview.md`;
    if (!await storePreview(env, key, link, { link_id: id })) throw new Error("Could not store metadata");
    try {
      const used = await usePreviewStatement(env.DB, id, key, link, `content_state='failed' AND ${linkIdle}`, id).run();
      if (!used.meta.changes) throw badRequest("The link changed meanwhile. Try again.");
    } finally { await dropUnusedPreview(env, id, key); }
    return json(await library(env, userId));
  })
  .patch("/links/:id", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    await assertNoActiveJob(env.DB, link.id);
    await env.DB.batch(setTags(env.DB, userId, link.id, tagNames(c.get("body").tags), true));
    return json(await library(env, userId));
  })
  .delete("/links/:id", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const link = await getOwnedLink(env.DB, userId, c.req.param("id"));
    if (!link) throw notFound();
    await assertNoActiveJob(env.DB, link.id);
    await env.DB.prepare("DELETE FROM links WHERE id=? AND user_id=?").bind(link.id, userId).run();
    // Remove both the owner-scoped prefix and the legacy one used before FAC-41.
    c.executionCtx.waitUntil(
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
  });
