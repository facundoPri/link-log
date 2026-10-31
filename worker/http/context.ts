import type { Context } from "hono";
import type { Auth } from "../auth";
import type { AppConfig } from "../config";

/**
 * Who is calling. Resolved on the server, never from the request body: the session cookie on the
 * private API, a verified API key (its owner, id and name) on the public API.
 */
export type Principal =
  | { kind: "session"; userId: string; sessionId: string }
  | { kind: "apiKey"; userId: string; keyId: string; keyName: string };

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
/** Invalid input from the caller: its message is shown to the user. Any other error answers 500. */
export const badRequest = (message: string) => new HttpError(400, message);
// Foreign, legacy (unassigned) and deleted IDs all answer the same way: existence is not revealed.
export const notFound = (what = "link") => new HttpError(404, `The ${what} no longer exists.`);

/** Owner of the request; only available behind requireSession or requireApiKey. */
export const ownerOf = (c: AppContext) => c.get("principal").userId;

/** The verified API key behind a public API request; anything else is not authenticated for it. */
export function apiKeyOf(c: AppContext) {
  const principal = c.get("principal");
  if (principal.kind !== "apiKey") throw new HttpError(401, "A valid API key is required.");
  return principal;
}

/** Why something failed, short enough for a log line: error name and message, never key material. */
export function failureDetail(error: unknown) {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/lk_[A-Za-z]+/g, "lk_…").slice(0, 200);
}
