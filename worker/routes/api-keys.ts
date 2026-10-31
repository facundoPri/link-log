import { isAPIError } from "better-auth/api";
import { Hono } from "hono";
import type { ApiKey } from "../../src/types";
import { API_KEY_NAME_MAX } from "../auth";
import { json, text } from "../store";
import { badRequest, notFound, ownerOf, type AppContext, type AppEnv } from "../http/context";

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

/**
 * API keys of the signed-in owner. The plugin's own HTTP routes are disabled (worker/auth.ts);
 * these call it server-side with the owner from the session. Revoking keeps the row: a Revoked API
 * key stays listed and there is no delete or re-enable.
 */
export const apiKeyRoutes = new Hono<AppEnv>()
  .get("/api-keys", async (c) => {
    // listApiKeys resolves the owner from the request's own session cookie.
    const { apiKeys } = await c.get("auth").api.listApiKeys({ headers: c.req.raw.headers, query: { sortBy: "createdAt", sortDirection: "desc" } });
    return json({ apiKeys: apiKeys.map(view) });
  })
  .post("/api-keys", async (c) => {
    const name = text(c.get("body").name, API_KEY_NAME_MAX);
    if (!name) throw badRequest("Name the API key.");
    const created = await c.get("auth").api.createApiKey({ body: { name, userId: ownerOf(c) } });
    // The full secret is returned here once; the database only keeps its hash.
    return json({ apiKey: view(created), secret: created.key }, 201);
  })
  .post("/api-keys/:id/revoke", async (c) => json({ apiKey: view(await revoke(c, c.req.param("id"))) }));

async function revoke(c: AppContext, keyId: string) {
  try {
    return await c.get("auth").api.updateApiKey({ body: { keyId, userId: ownerOf(c), enabled: false } });
  } catch (error) {
    // The plugin answers NOT_FOUND for missing and foreign keys alike.
    if (isAPIError(error) && error.statusCode === 404) throw notFound("API key");
    throw error;
  }
}
