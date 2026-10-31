import { Hono } from "hono";
import { AUTH_BASE_PATH } from "../auth";
import { NothingToRun } from "../jobs";
import { LimitError } from "../limits";
import { json } from "../store";
import { activityRoutes } from "../routes/activity";
import { apiKeyRoutes } from "../routes/api-keys";
import { browserRoutes } from "../routes/browser";
import { linkRoutes } from "../routes/links";
import { taxonomyRoutes } from "../routes/taxonomy";
import { HttpError, type AppEnv } from "./context";
import { requireSession, sameOriginWrites, withConfig, writeQuotaAndBody } from "./middleware";

/**
 * HTTP layer. Order matters:
 *  1. /api/* validates config (fail closed) and the host, and binds a per-request auth instance.
 *  2. Better Auth gets the untouched Request for /api/auth/* (its own methods, bodies, callbacks
 *     and CSRF/origin checks) before any app middleware or body parsing.
 *  3. Everything else under /api is private by default: same-origin JSON writes, a valid session,
 *     the per-user write quota and a bounded JSON body, then the route modules. Ownership is
 *     enforced again in every query (see worker/store.ts and the routes).
 *  4. Non-API paths are static assets (the public SPA shell; no library data).
 * Public API routes, if any are ever added, must be declared before the private group.
 */
export function createApp() {
  const app = new Hono<AppEnv>();
  app.use("/api/*", withConfig);
  app.on(["GET", "POST"], `${AUTH_BASE_PATH}/*`, async (c) => {
    try {
      return await c.get("auth").handler(c.req.raw);
    } catch {
      console.error(JSON.stringify({ event: "auth_handler_error" }));
      return json({ error: "Authentication failed. Try again." }, 500);
    }
  });
  app.all(`${AUTH_BASE_PATH}/*`, () => json({ error: "Method not allowed." }, 405));

  const privateApi = new Hono<AppEnv>();
  privateApi.use("*", sameOriginWrites, requireSession, writeQuotaAndBody);
  privateApi.route("/", linkRoutes);
  privateApi.route("/", taxonomyRoutes);
  privateApi.route("/", activityRoutes);
  privateApi.route("/", browserRoutes);
  privateApi.route("/", apiKeyRoutes);
  privateApi.notFound(() => json({ error: "Not found." }, 404));
  app.route("/api", privateApi);

  app.all("/api/*", () => json({ error: "Not found." }, 404));
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

  // Only deliberate errors (HttpError, LimitError) reach the client with their message. Anything
  // else is a server fault: a generic 500, logged by type only (messages can quote stored data).
  app.onError((error, c) => {
    if (error instanceof NothingToRun) return json({ error: error.message, skipped: error.skipped }, 400);
    if (error instanceof HttpError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    if (error instanceof LimitError) return json({ error: error.message }, 429);
    const message = error instanceof Error ? error.message : "";
    if (/D1_|SQLITE|constraint|owner|cross-owner/i.test(message)) {
      console.error("Database operation failed");
      return json({ error: "Could not save. Try again." }, 500);
    }
    console.error(JSON.stringify({ event: "unhandled_error", type: error instanceof Error ? error.name : typeof error, method: c.req.method, route: c.req.routePath }));
    return json({ error: "Something went wrong. Try again." }, 500);
  });
  return app;
}
