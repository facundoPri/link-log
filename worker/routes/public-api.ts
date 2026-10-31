import { Hono } from "hono";
import { scanUrls } from "../../src/url";
import { json } from "../store";
import { addLinks } from "../links";
import { apiKeyOf, badRequest, type AppEnv } from "../http/context";

const MAX_URLS = 100;
// Only an abuse bound on the strings array (the body size is capped separately): the real limit is
// MAX_URLS after extraction, so 50 strings holding 100 URLs must pass.
const MAX_STRINGS = 1000;
// A URL longer than 4096 characters is refused anyway; this bounds the text scanned per string.
const MAX_STRING_LENGTH = 8192;
const NO_LINK = "No valid http or https link found.";

/**
 * Public API (POST /api/v1/links), behind requireApiKey: a thin adapter over the add-links service.
 * The owner and the batch source come from the verified key only. Each string is scanned for http(s)
 * URLs; repeats across the request collapse into one result and strings without a valid URL are
 * listed in `rejected`. Zero valid URLs, or more than 100 after extraction, is 400.
 */
export const publicApiRoutes = new Hono<AppEnv>().post("/links", async (c) => {
  const principal = apiKeyOf(c);
  const body = c.get("body");
  if (!Array.isArray(body.urls) || !body.urls.length || body.urls.length > MAX_STRINGS || body.urls.some((u) => typeof u !== "string"))
    throw badRequest(`Send \`urls\`: 1 to ${MAX_STRINGS} strings.`);
  if ((body.urls as string[]).some((u) => u.length > MAX_STRING_LENGTH)) throw badRequest(`Each string can be at most ${MAX_STRING_LENGTH} characters.`);
  const accepted = new Map<string, string>();
  const rejected: { input: string; error: string }[] = [];
  for (const input of body.urls as string[]) {
    const { urls, reason } = scanUrls(input);
    if (!urls.length) rejected.push({ input, error: reason ?? NO_LINK });
    for (const url of urls) if (!accepted.has(url)) accepted.set(url, input);
    if (accepted.size > MAX_URLS) throw badRequest(`Send at most ${MAX_URLS} links per request.`);
  }
  if (!accepted.size) return json({ error: NO_LINK, rejected }, 400);
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
