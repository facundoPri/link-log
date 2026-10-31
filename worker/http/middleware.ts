import { defaultKeyHasher } from "@better-auth/api-key";
import { isAPIError } from "better-auth/api";
import { createMiddleware } from "hono/factory";
import { createAuth } from "../auth";
import { ConfigError, hostAllowed, readConfig } from "../config";
import { LIMITS, chargeOrThrow } from "../limits";
import { json } from "../store";
import { HttpError, apiKeyOf, type AppContext, type AppEnv } from "./context";

let configErrorLogged = false;

/** Validates runtime config per request (fail closed) and binds a per-request auth instance. */
export const withConfig = createMiddleware<AppEnv>(async (c, next) => {
  let config;
  try {
    config = readConfig(c.env);
  } catch (error) {
    if (!configErrorLogged) {
      configErrorLogged = true;
      console.error(JSON.stringify({ event: "config_error", message: error instanceof ConfigError ? error.message : "invalid" }));
    }
    return json({ error: "Linklog is not configured. Authentication is unavailable." }, 503);
  }
  if (!hostAllowed(config, new URL(c.req.url))) return json({ error: "Host not allowed." }, 403);
  c.set("config", config);
  c.set("auth", createAuth(c.env, c.executionCtx, config));
  await next();
});

/**
 * Same-origin JSON for writes. Origin is required: the browser always sends it on these fetches,
 * and a cookie alone must never authorize a cross-site write.
 */
export const sameOriginWrites = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (c.req.header("origin") !== c.get("config").baseURL) return json({ error: "Origin not allowed." }, 403);
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin") return json({ error: "Origin not allowed." }, 403);
    if (!c.req.header("content-type")?.includes("application/json")) return json({ error: "JSON required." }, 415);
  }
  await next();
});

/**
 * Every private route: a valid D1 session becomes the request Principal. Only a missing, expired
 * or revoked session is 401 (the UI then shows sign-in). A lookup that failed (D1 outage, timeout)
 * says nothing about the session: 503, so the client keeps the user, the page and the extension.
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  let session;
  try {
    session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  } catch (error) {
    // Better Auth answers 401 itself when the session vanished mid-refresh (concurrent revocation).
    if (!(isAPIError(error) && error.statusCode === 401)) {
      console.error(JSON.stringify({ event: "session_lookup_failed" }));
      return json({ error: "Could not check your session. Try again.", code: "session-unavailable" }, 503);
    }
  }
  if (!session) return json({ error: "Sign in to continue." }, 401);
  c.set("principal", { kind: "session", userId: session.user.id, sessionId: session.session.id });
  await next();
});

export const MAX_BODY_BYTES = 2_100_000;

/**
 * Reads at most `max` bytes of the body (counted as bytes, not characters, and without trusting
 * Content-Length, which chunked requests omit); larger bodies stop reading and answer 413.
 */
export async function readBounded(request: Request, max: number) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, "Request too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** A bounded JSON object body ({} for GET and HEAD). */
async function readJsonObject(c: AppContext): Promise<Record<string, unknown>> {
  if (c.req.method === "GET" || c.req.method === "HEAD") return {};
  if (Number(c.req.header("content-length") || 0) > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
  const raw = await readBounded(c.req.raw, MAX_BODY_BYTES);
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "Invalid request.");
  }
  if (!body || Array.isArray(body) || typeof body !== "object") throw new HttpError(400, "Invalid request.");
  return body as Record<string, unknown>;
}

/** Per-user write quota, then a bounded JSON object body. */
export const writeQuotaAndBody = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    await chargeOrThrow(c.env.DB, [{ key: `writes:${c.get("principal").userId}`, limit: LIMITS.writesPerUser, cost: 1, code: "writes" }]);
  }
  c.set("body", await readJsonObject(c));
  await next();
});

/**
 * Public API: `Authorization: Bearer lk_…`, verified by the API key plugin, becomes an API key
 * Principal whose owner is the key's owner. Cookies are ignored. A missing, invalid or Revoked API
 * key is 401, logged to Workers Logs only (never the key itself). A failed lookup is 503, so the
 * integration retries instead of treating its key as dead.
 */
export const requireApiKey = createMiddleware<AppEnv>(async (c, next) => {
  const key = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  let verified;
  if (key) {
    try {
      verified = await c.get("auth").api.verifyApiKey({ body: { key } });
      // The plugin catches every error while validating and answers it like an unknown key, so a
      // D1 failure looks like a 401. A genuinely unknown key has no active row; one that has a
      // row, or a lookup that fails again, was a failure.
      if (!verified.valid && verified.error?.code === "INVALID_API_KEY" && (await activeKeyExists(c.env.DB, key)))
        throw new Error("API key validation failed");
    } catch (error) {
      if (!isAPIError(error)) {
        console.error(JSON.stringify({ event: "api_key_lookup_failed" }));
        return json({ error: "Could not check the API key. Try again." }, 503);
      }
    }
  }
  if (!verified?.valid || !verified.key) {
    console.warn(JSON.stringify({ event: "api_key_rejected", reason: key ? "invalid" : "missing", method: c.req.method, path: c.req.path }));
    return json({ error: "A valid API key is required." }, 401);
  }
  c.set("principal", { kind: "apiKey", userId: verified.key.referenceId, keyId: verified.key.id, keyName: verified.key.name ?? "" });
  await next();
});

/** Whether an active key with this secret exists. Throws when the lookup itself fails. */
async function activeKeyExists(db: D1Database, key: string) {
  // Couples to the plugin's apikey table: "key" holds the SHA-256 hash (defaultKeyHasher) and
  // "enabled" is 1 for an active key. migrations/0026_api_keys.sql indexes "key".
  const row = await db.prepare('SELECT 1 AS found FROM apikey WHERE "key"=? AND enabled=1').bind(await defaultKeyHasher(key)).first();
  return row !== null;
}

/** Per-key request limit (every request counts), then a bounded JSON object body. */
export const apiKeyQuotaAndBody = createMiddleware<AppEnv>(async (c, next) => {
  await chargeOrThrow(c.env.DB, [{ key: `apikey:${apiKeyOf(c).keyId}`, limit: LIMITS.requestsPerApiKey, cost: 1, code: "api_key" }], "API key request limit reached. Try again later.");
  c.set("body", await readJsonObject(c));
  await next();
});
