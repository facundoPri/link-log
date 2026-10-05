import { Hono } from "hono";
import type { Tag } from "../../src/types";
import { json, library, text, threshold } from "../store";
import { badRequest, HttpError, notFound, ownerOf, type AppEnv } from "../http/context";
import { lensFields, tagNames } from "./shared";

/** Tags and lenses: names are unique per owner, never across owners. */
export const taxonomyRoutes = new Hono<AppEnv>()
  .post("/tags", async (c) => {
    const userId = ownerOf(c);
    const name = tagNames([c.get("body").name])[0];
    if (!name) throw badRequest("Enter a name.");
    await c.env.DB.prepare("INSERT OR IGNORE INTO tags (id,user_id,name) VALUES (?,?,?)")
      .bind(crypto.randomUUID(), userId, name).run();
    return json(await library(c.env, userId));
  })
  .delete("/tags/:id", async (c) => {
    const userId = ownerOf(c);
    const result = await c.env.DB.prepare("DELETE FROM tags WHERE id=? AND user_id=?").bind(c.req.param("id"), userId).run();
    if (!result.meta.changes) throw notFound("tag");
    return json(await library(c.env, userId));
  })
  .patch("/tags/:id", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const current = await env.DB.prepare("SELECT id,name,description,threshold,version FROM tags WHERE id=? AND user_id=?")
      .bind(c.req.param("id"), userId).first<Tag>();
    if (!current) throw notFound("tag");
    const name = tagNames([body.name])[0];
    if (!name) throw badRequest("Enter a name.");
    const same = await env.DB.prepare("SELECT id FROM tags WHERE user_id=? AND name=? AND id<>?").bind(userId, name, current.id).first();
    if (same) throw new HttpError(409, "A tag with that name already exists.");
    await env.DB.prepare("UPDATE tags SET name=?,description=?,threshold=?,version=version+1 WHERE id=? AND user_id=?")
      .bind(
        name,
        body.description === undefined ? current.description : text(body.description, 2000),
        body.threshold === undefined ? current.threshold : threshold(body.threshold),
        current.id,
        userId,
      )
      .run();
    return json(await library(env, userId));
  })
  .post("/lenses", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const f = lensFields(body);
    const existing = await env.DB.prepare("SELECT id FROM lenses WHERE user_id=? AND name=?").bind(userId, f.name).first();
    if (existing) throw new HttpError(409, "A lens with that name already exists.");
    const scope = body.scope === undefined ? "library" : String(body.scope);
    if (scope !== "library" && scope !== "browser") throw badRequest("Invalid lens scope.");
    await env.DB.prepare(
      "INSERT INTO lenses(id,user_id,name,type,question,options,threshold,created_at,scope) VALUES(?,?,?,?,?,?,?,?,?)",
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
        scope,
      )
      .run();
    return json(await library(env, userId));
  })
  .delete("/lenses/:id", async (c) => {
    const userId = ownerOf(c);
    const result = await c.env.DB.prepare("DELETE FROM lenses WHERE id=? AND user_id=?").bind(c.req.param("id"), userId).run();
    if (!result.meta.changes) throw notFound("lens");
    return json(await library(c.env, userId));
  })
  .patch("/lenses/:id", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const current = await env.DB.prepare("SELECT id,type FROM lenses WHERE id=? AND user_id=?")
      .bind(c.req.param("id"), userId).first<{ id: string; type: string }>();
    if (!current) throw notFound("lens");
    const f = lensFields(c.get("body"));
    const same = await env.DB.prepare("SELECT id FROM lenses WHERE user_id=? AND name=? AND id<>?").bind(userId, f.name, current.id).first();
    if (same) throw new HttpError(409, "A lens with that name already exists.");
    if (current.type !== f.type) throw new HttpError(400, "The lens type can't be changed.");
    await env.DB.prepare("UPDATE lenses SET name=?,type=?,question=?,options=?,threshold=?,version=version+1 WHERE id=? AND user_id=?")
      .bind(f.name, f.type, f.question, JSON.stringify({ options: f.options, levels: f.levels, criteria: f.criteria }), f.threshold, current.id, userId)
      .run();
    return json(await library(env, userId));
  });
