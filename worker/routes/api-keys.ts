import { isAPIError } from "better-auth/api";
import { Hono } from "hono";
import type { ApiKey } from "../../src/types";
import { API_KEY_NAME_MAX } from "../auth";
import { json, text } from "../store";
import { badRequest, HttpError, notFound, ownerOf, type AppContext, type AppEnv } from "../http/context";

type PluginKey = { id: string; name: string | null; start: string | null; createdAt: Date; lastRequest: Date | null; enabled: boolean };

// Only what Settings shows. The hash and the plugin's bookkeeping never leave the server.
const view = (k: PluginKey): ApiKey => ({
  id: k.id,
  name: k.name ?? "",
  prefix: k.start ?? "",
  createdAt: new Date(k.createdAt).toISOString(),
  lastUsedAt: k.lastRequest ? new Date(k.lastRequest).toISOString() : null,
  status: k.enabled ? "active" : "revoked",
});

/** Most active API keys one user holds at a time. Revoked keys do not count. */
const API_KEY_ACTIVE_MAX = 10;

/**
 * API keys of the signed-in owner. The plugin's own HTTP routes are disabled (worker/auth.ts);
 * these call it server-side with the owner from the session. Revoking keeps the row: a Revoked API
 * key stays listed and there is no delete or re-enable.
 *
 * D1 has no transaction across the plugin's calls, so the rules that must hold under concurrent
 * requests are re-checked after the write and undone by revoking the key just created: at most 10
 * active keys, and one new key per regenerated key. Under a race that can refuse more requests
 * than strictly needed, never fewer.
 */
export const apiKeyRoutes = new Hono<AppEnv>()
  .get("/api-keys", async (c) => json({ apiKeys: (await ownKeys(c)).map(view) }))
  .post("/api-keys", async (c) => {
    const name = text(c.get("body").name, API_KEY_NAME_MAX);
    if (!name) throw badRequest("Name the API key.");
    if ((await activeCount(c)) >= API_KEY_ACTIVE_MAX) throw roomError();
    const created = await c.get("auth").api.createApiKey({ body: { name, userId: ownerOf(c) } });
    // Requests that passed the check together each created a key: whoever then sees more than the
    // cap takes its own key back, so the key that lands last never stays.
    if ((await activeCount(c)) > API_KEY_ACTIVE_MAX) {
      await takeBack(c, created.id);
      throw roomError();
    }
    // The full secret is returned here once; the database only keeps its hash.
    return json({ apiKey: view(created), secret: created.key }, 201);
  })
  .post("/api-keys/:id/regenerate", async (c) => {
    const oldId = c.req.param("id");
    const old = await c.env.DB.prepare("SELECT name,enabled FROM apikey WHERE id=? AND referenceId=?")
      .bind(oldId, ownerOf(c))
      .first<{ name: string | null; enabled: number }>();
    if (!old) throw notFound("API key");
    if (!old.enabled) throw revokedError();
    // The new key replaces an active one, so the cap does not apply: a user at 10 can regenerate.
    // Create first: if that fails the old key stays active.
    const created = await c.get("auth").api.createApiKey({ body: { name: old.name ?? "", userId: ownerOf(c) } });
    try {
      // Only one request can turn the old key off. A concurrent regenerate of it loses and takes
      // its own new key back, so a key never gets two replacements.
      if (!(await claimRevoke(c, oldId))) throw revokedError();
    } catch (error) {
      // Never leave both keys active: the secret would be lost with this error.
      await takeBack(c, created.id);
      throw error;
    }
    return json({ apiKey: view(created), secret: created.key }, 201);
  })
  .post("/api-keys/:id/revoke", async (c) => json({ apiKey: view(await revoke(c, c.req.param("id"))) }));

const roomError = () => new HttpError(409, `You have ${API_KEY_ACTIVE_MAX} active API keys. Revoke one to create another.`, "api_key_limit");
const revokedError = () => new HttpError(409, "That API key is revoked. Create a new one instead.", "api_key_revoked");

async function revoke(c: AppContext, keyId: string) {
  try {
    return await c.get("auth").api.updateApiKey({ body: { keyId, userId: ownerOf(c), enabled: false } });
  } catch (error) {
    // The plugin answers NOT_FOUND for missing and foreign keys alike.
    if (isAPIError(error) && error.statusCode === 404) throw notFound("API key");
    throw error;
  }
}

/** Turns the key off only if it is still on; false when another request got there first. */
async function claimRevoke(c: AppContext, keyId: string) {
  const { meta } = await c.env.DB.prepare("UPDATE apikey SET enabled=0,updatedAt=? WHERE id=? AND referenceId=? AND enabled=1")
    .bind(new Date().toISOString(), keyId, ownerOf(c))
    .run();
  return meta.changes > 0;
}

/**
 * Compensating revoke for a key whose secret nobody saw: the guarded update used by claimRevoke,
 * once more if it fails. If it still fails an active key nobody can use stays behind, so it is
 * logged by id (never the secret) for the owner to revoke.
 */
async function takeBack(c: AppContext, keyId: string) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await claimRevoke(c, keyId);
      return;
    } catch {}
  }
  console.error(JSON.stringify({ event: "api_key_rollback_failed", keyId }));
}

// Only the Settings list loads every key. listApiKeys resolves the owner from the request's own
// session cookie. Newest first: sorted by creation time ascending and reversed. Keys created in the
// same millisecond have no defined order beyond what the database returns (insertion order in
// practice), so nothing relies on it.
async function ownKeys(c: AppContext) {
  const { apiKeys } = await c.get("auth").api.listApiKeys({ headers: c.req.raw.headers, query: { sortBy: "createdAt", sortDirection: "asc" } });
  return apiKeys.reverse();
}

/**
 * How many active keys the owner holds, in one query. Raw SQL on the plugin's table
 * (migrations/0026_api_keys.sql): "referenceId" is the owning user and "enabled" is 1 for an active
 * key, 0 once revoked. claimRevoke and the regenerate lookup rely on the same columns; if the
 * plugin changes them, those change together.
 */
async function activeCount(c: AppContext) {
  const row = await c.env.DB.prepare('SELECT count(*) AS n FROM apikey WHERE "referenceId"=? AND enabled=1').bind(ownerOf(c)).first<{ n: number }>();
  return row?.n ?? 0;
}
