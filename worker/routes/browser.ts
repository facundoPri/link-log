import { Hono } from "hono";
import { BROWSER_LIMITS, type PinnedGroup } from "@linklog/browser-protocol";
import { catalog, color, createEvaluation, evaluationStatus, idOk, saveUrls } from "../browser";
import { json, library, text } from "../store";
import { badRequest, HttpError, ownerOf, type AppEnv } from "../http/context";

const REQUEST_ID = "[A-Za-z0-9_-]{1,80}";

/** Requests owned by the signed-in user; foreign or unknown ids read as unknown. */
async function ownedRequest(db: D1Database, userId: string, requestId: string) {
  return db.prepare("SELECT request_id FROM browser_requests WHERE request_id=? AND user_id=?").bind(requestId, userId).first();
}
function targetKeys(body: Record<string, unknown>) {
  return Array.isArray(body.targetKeys) && body.targetKeys.every((k) => typeof k === "string" && k.length <= 400)
    ? (body.targetKeys as string[]).slice(0, BROWSER_LIMITS.maxTargets)
    : null;
}
// The keys travel as ONE JSON-array parameter: D1 allows at most 100 bound parameters per
// statement, and a full evaluation has 100 targets plus the request id (and a timestamp).
const KEYS_IN = "(SELECT value FROM json_each(?))";
const unknownRequest = () => new HttpError(404, "Unknown request.", "unknown-request");

/** Browser view API (contracts from @linklog/browser-protocol), scoped to the session owner. */
export const browserRoutes = new Hono<AppEnv>()
  .get("/browser/catalog", async (c) => json(await catalog(c.env, ownerOf(c))))
  .post("/browser/evaluations", async (c) => createEvaluation(c.env, ownerOf(c), c.get("body")))
  .get(`/browser/evaluations/:requestId{${REQUEST_ID}}`, async (c) => {
    const status = await evaluationStatus(c.env, ownerOf(c), c.req.param("requestId"));
    if (!status) throw unknownRequest();
    return json(status);
  })
  .post(`/browser/evaluations/:requestId{${REQUEST_ID}}/ack`, async (c) => {
    const env = c.env, userId = ownerOf(c), requestId = c.req.param("requestId");
    const keys = targetKeys(c.get("body"));
    if (!keys?.length) throw badRequest("Nothing to confirm.");
    if (!(await ownedRequest(env.DB, userId, requestId))) throw unknownRequest();
    // Stored in the extension: the payload can go; the receipt and usage stay. Only answered
    // targets are confirmed; the rest keep their snapshot until retention.
    const rows = await env.DB.prepare(
      `SELECT id,capture_key FROM browser_targets WHERE request_id=? AND answer IS NOT NULL AND target_key IN ${KEYS_IN}`,
    )
      .bind(requestId, JSON.stringify(keys))
      .all<{ id: string; capture_key: string | null }>();
    const captureKeys = rows.results.map((r) => r.capture_key).filter((k): k is string => !!k);
    if (captureKeys.length) await env.CONTENT.delete(captureKeys);
    await env.DB.prepare(
      `UPDATE browser_targets SET acked_at=coalesce(acked_at,?),answer=NULL,capture_key=NULL WHERE request_id=? AND answer IS NOT NULL AND target_key IN ${KEYS_IN}`,
    )
      .bind(new Date().toISOString(), requestId, JSON.stringify(keys))
      .run();
    return json({ acked: rows.results.length });
  })
  .delete(`/browser/evaluations/:requestId{${REQUEST_ID}}`, async (c) => {
    const env = c.env, userId = ownerOf(c), requestId = c.req.param("requestId");
    if (!(await ownedRequest(env.DB, userId, requestId))) throw unknownRequest();
    // Clean, close or navigation: cancel work that has not started. A call already sent to the
    // provider may still be billed and stays in Activity.
    const keys = targetKeys(c.get("body"));
    const filter = keys?.length ? ` AND target_key IN ${KEYS_IN}` : "";
    const result = await env.DB.prepare(
      `UPDATE jobs SET status='failed',step='Cancelled',error='Cancelled',completed_at=? WHERE status='queued' AND target_id IN (SELECT id FROM browser_targets WHERE request_id=?${filter})`,
    )
      .bind(new Date().toISOString(), requestId, ...(keys?.length ? [JSON.stringify(keys)] : []))
      .run();
    return json({ cancelled: result.meta.changes });
  })
  .post("/browser/groups", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const name = text(body.name, 80);
    const now = new Date().toISOString();
    // A client-chosen id is accepted only if free; ids never move between owners, and a taken id
    // answers like any id conflict without revealing whose it is.
    const inserted = await env.DB.prepare(
      "INSERT INTO browser_groups(id,user_id,name,description,color,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
    )
      .bind(typeof body.id === "string" && idOk(body.id) ? body.id : crypto.randomUUID(), userId, name, text(body.description ?? "", 2000), color(body.color), now, now)
      .run();
    if (!inserted.meta.changes) throw new HttpError(409, "That group id is already in use.", "conflict");
    return json(await catalog(env, userId), 201);
  })
  .delete(`/browser/groups/:id{${REQUEST_ID}}`, async (c) => {
    const env = c.env, userId = ownerOf(c);
    // Unpin: future destinations disappear; native groups and local metadata stay.
    await env.DB.prepare("DELETE FROM browser_groups WHERE id=? AND user_id=?").bind(c.req.param("id"), userId).run();
    return json(await catalog(env, userId));
  })
  .patch(`/browser/groups/:id{${REQUEST_ID}}`, async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    const current = await env.DB.prepare("SELECT id,name,description,color FROM browser_groups WHERE id=? AND user_id=?")
      .bind(c.req.param("id"), userId)
      .first<PinnedGroup>();
    if (!current) throw new HttpError(404, "The pinned group no longer exists.");
    await env.DB.prepare("UPDATE browser_groups SET name=?,description=?,color=?,version=version+1,updated_at=? WHERE id=? AND user_id=?")
      .bind(
        body.name === undefined ? current.name : text(body.name, 80),
        body.description === undefined ? current.description : text(body.description, 2000),
        body.color === undefined ? current.color : color(body.color),
        new Date().toISOString(),
        current.id,
        userId,
      )
      .run();
    return json(await catalog(env, userId));
  })
  .post("/browser/save", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const results = await saveUrls(env, userId, c.get("body"));
    return json({ results, ...(await library(env, userId)) });
  });
