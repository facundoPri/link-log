import type { Context } from "hono";
import type { Auth } from "../auth";
import type { AppConfig } from "../config";

/**
 * Who is calling. Resolved on the server from the session cookie, never from the request body.
 * FAC-44 will add `{ kind: "apiKey", userId, capabilities, credentialId }` behind its own group.
 */
export type Principal = { kind: "session"; userId: string; sessionId: string };

/** Hono typing shared by every module: Worker bindings plus per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: {
    config: AppConfig;
    /** Per-request Better Auth instance bound to this request's env and ExecutionContext. */
    auth: Auth;
    principal: Principal;
    /** Parsed JSON object for writes on private routes ({} for GET). */
    body: Record<string, unknown>;
  };
};
export type AppContext = Context<AppEnv>;

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 429 | 500 | 503,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
// Foreign, legacy (unassigned) and deleted IDs all answer the same way: existence is not revealed.
export const notFound = (what = "link") => new HttpError(404, `The ${what} no longer exists.`);

/** Owner of the request; only available behind requireSession. */
export const ownerOf = (c: AppContext) => c.get("principal").userId;
