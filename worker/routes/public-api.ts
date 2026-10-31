import { Hono } from "hono";
import { normalizeUrl } from "../../src/url";
import { json } from "../store";
import { addLinks } from "../links";
import { badRequest, type AppEnv } from "../http/context";

/**
 * Public API (POST /api/v1/links), behind requireApiKey: a thin adapter over the add-links service.
 * The owner and the batch source come from the verified key only. Repeated URLs in one request
 * collapse into one result; invalid ones are listed in `rejected`.
 */
export const publicApiRoutes = new Hono<AppEnv>().post("/links", async (c) => {
  const principal = c.get("principal");
  if (principal.kind !== "apiKey") return json({ error: "A valid API key is required." }, 401);
  const body = c.get("body");
  if (!Array.isArray(body.urls) || !body.urls.length || body.urls.length > 100 || body.urls.some((u) => typeof u !== "string"))
    throw badRequest("Send `urls`: 1 to 100 strings.");
  const accepted = new Map<string, string>();
  const rejected: { input: string; error: string }[] = [];
  for (const input of body.urls as string[]) {
    try {
      const url = normalizeUrl(input);
      if (!accepted.has(url)) accepted.set(url, input);
    } catch (error) {
      rejected.push({ input, error: error instanceof Error && error.message ? error.message : "Invalid link." });
    }
  }
  const saved = await addLinks(c.env, principal.userId, [...accepted.keys()], { source: "api", apiKeyId: principal.keyId, apiKeyName: principal.keyName });
  const inputs = [...accepted.values()];
  const results = [];
  let batchId: string | undefined;
  for (const [i, r] of saved.entries()) {
    if ("error" in r) {
      rejected.push({ input: inputs[i]!, error: r.error });
      continue;
    }
    batchId ??= r.batchId;
    results.push({ input: inputs[i]!, url: r.input, id: r.id, status: r.created ? "created" : "duplicate" });
  }
  return json({ results, rejected, ...(batchId ? { batchId } : {}) }, 202);
});
