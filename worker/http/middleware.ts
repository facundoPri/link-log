import { createMiddleware } from "hono/factory";
import { createAuth } from "../auth";
import { ConfigError, hostAllowed, readConfig } from "../config";
import { consume, LIMITS, LimitError } from "../limits";
import { json } from "../store";
import { HttpError, type AppEnv } from "./context";

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

/** Every private route: a valid D1 session becomes the request Principal. */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  let session;
  try {
    session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
  } catch {
    console.error(JSON.stringify({ event: "session_lookup_failed" }));
  }
  if (!session) return json({ error: "Sign in to continue." }, 401);
  c.set("principal", { kind: "session", userId: session.user.id, sessionId: session.session.id });
  await next();
});

/** Per-user write quota, then a bounded JSON object body. */
export const writeQuotaAndBody = createMiddleware<AppEnv>(async (c, next) => {
  let body: Record<string, unknown> = {};
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    if (!(await consume(c.env.DB, `writes:${c.get("principal").userId}`, LIMITS.writesPerUser))) throw new LimitError();
    if (Number(c.req.header("content-length") || 0) > 2100000) throw new HttpError(413, "Request too large.");
    const raw = await c.req.text();
    if (raw.length > 2100000) throw new HttpError(413, "Request too large.");
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError(400, "Invalid request.");
    }
    if (!body || Array.isArray(body) || typeof body !== "object") throw new HttpError(400, "Invalid request.");
  }
  c.set("body", body);
  await next();
});
