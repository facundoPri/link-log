import { apiKey } from "@better-auth/api-key";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins/magic-link";
import { isLocalEnv, readConfig, type AppConfig } from "./config";
import { createMailer } from "./email";
import { LIMITS, LimitError, chargeOrThrow } from "./limits";

export const AUTH_BASE_PATH = "/api/auth";
export const SESSION_EXPIRES_IN = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE = 60 * 60 * 24;
export const MAGIC_LINK_EXPIRES_IN = 60 * 5;
export const API_KEY_PREFIX = "lk_";
export const API_KEY_LENGTH = 64;
export const API_KEY_NAME_MAX = 32;

// Core endpoints outside the initial scope (social login, account linking, profile/email changes,
// account deletion). Unused routes stay unreachable instead of relying on missing configuration.
const DISABLED_PATHS = [
  "/account-info",
  "/change-email",
  "/delete-user",
  "/delete-user/callback",
  "/get-access-token",
  "/link-social",
  "/list-accounts",
  "/refresh-token",
  "/sign-in/social",
  "/unlink-account",
  "/update-session",
  "/update-user",
  "/verify-password",
];

type Mailer = ReturnType<typeof createMailer>;

// The plugin routes that add or change a key. They never reach app middleware, so this hook charges them.
const KEY_WRITE_PATHS = ["/api-key/create", "/api-key/update"];

// Better Auth logs every error an endpoint throws, so the refusals keyRules is built to give would
// show up as errors. Only those two messages are dropped, by the logger below.
const EXPECTED_REFUSALS = ["Too many requests.", "Keys always start with lk_."];

// Turning a key off and nothing else: the owner's way to stop a leaked key.
const isRevoke = (body: Record<string, unknown>) => body.enabled === false && Object.keys(body).every((k) => k === "keyId" || k === "enabled");

/**
 * Runs before every Better Auth endpoint, for HTTP clients only (a server call such as a test
 * helper passes neither a request nor headers, as the plugin itself tells them apart):
 *  - Creating a key, or changing one in any way but revoking it, with a session takes one from the
 *    user's writes budget, the one the private and public API share, and is refused with a 429 and
 *    Retry-After when it is spent. Better Auth's own per-IP limit cannot bound a user across IPs,
 *    and there is no key cap.
 *  - Revoking a key (an update that only sets enabled to false) and deleting one are never charged
 *    or refused. Whoever holds a leaked key can spend the owner's budget with submissions, and the
 *    owner must still be able to kill it. A revoke that also renames is a change and is charged.
 *  - A key is created with the configured `lk_` prefix and configuration only: the prefix is what
 *    secret scanners recognize and a shorter one would put more of the secret in the stored start.
 */
const keyRules = (db: D1Database) =>
  createAuthMiddleware(async (ctx) => {
    if (!ctx.request && !ctx.headers) return;
    if (ctx.path === "/api-key/create") {
      const body = ctx.body as { prefix?: unknown; configId?: unknown } | undefined;
      if (body?.prefix !== undefined || body?.configId !== undefined)
        throw new APIError("BAD_REQUEST", { message: "Keys always start with lk_. Do not send a prefix or configId.", code: "SERVER_ONLY_PROPERTY" });
    }
    if (!KEY_WRITE_PATHS.includes(ctx.path)) return;
    if (ctx.path === "/api-key/update" && isRevoke((ctx.body ?? {}) as Record<string, unknown>)) return;
    const session = await getSessionFromCtx(ctx, { disableCookieCache: true });
    if (!session) return;
    try {
      await chargeOrThrow(db, [{ key: `writes:${session.user.id}`, limit: LIMITS.writesPerUser, cost: 1, code: "writes" }]);
    } catch (error) {
      if (!(error instanceof LimitError)) throw error;
      throw new APIError("TOO_MANY_REQUESTS", { message: error.message, code: error.code }, { "Retry-After": String(error.retryAfter) });
    }
  });

/**
 * Shared Better Auth options. The production factory below and the test-only instance in
 * tests/support use this same function so they cannot drift; only tests add Test Utils.
 */
export function authOptions(
  config: AppConfig,
  database: NonNullable<BetterAuthOptions["database"]>,
  mailer: Mailer,
  waitUntil: (p: Promise<unknown>) => void,
  // The D1 binding keyRules charges against. scripts/auth/print-schema.ts only compiles the
  // schema over bun:sqlite and serves no request, so it leaves this out and gets no hook.
  d1?: D1Database,
) {
  const local = isLocalEnv(config.appEnv);
  return {
    appName: "Linklog",
    baseURL: config.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database,
    trustedOrigins: [config.baseURL],
    disabledPaths: DISABLED_PATHS,
    ...(d1 && { hooks: { before: keyRules(d1) } }),
    // Its default handler logs through a logger of its own, which ignores the one below. This one
    // sends the same errors through it, so expected refusals can be dropped there.
    onAPIError: { onError: (error, ctx) => (isAPIError(error) ? ctx.logger.error(error.message) : ctx.logger.error(error instanceof Error ? error.name : "", error)) },
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      // Better Auth may pass request details as extra arguments; keep only its message.
      // The API key plugin logs every invalid key as an error; requireApiKey records those
      // (api_key_rejected, api_key_lookup_failed), so that line would only duplicate it.
      log: (level, message) => {
        if (message.startsWith("Failed to validate API key") || EXPECTED_REFUSALS.some((m) => message.startsWith(m))) return;
        console[level === "debug" ? "log" : level](`[auth] ${message}`);
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => mailer.send({ kind: "reset", to: user.email, url }),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => mailer.send({ kind: "verify", to: user.email, url }),
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN,
      updateAge: SESSION_UPDATE_AGE,
      // Revocation must be visible on the next request: no signed cookie cache in front of D1.
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
        "/sign-in/magic-link": { window: 60, max: 3 },
        "/request-password-reset": { window: 60, max: 3 },
        "/send-verification-email": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    advanced: {
      cookiePrefix: "linklog",
      useSecureCookies: !local,
      // Explicit so NODE_ENV=test or a stray variable never relaxes CSRF/origin validation.
      disableCSRFCheck: false,
      disableOriginCheck: false,
      // Cloudflare overwrites this header at the edge; wrangler dev sets it for local requests.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      backgroundTasks: { handler: waitUntil },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => mailer.send({ kind: "magic", to: email, url }),
      }),
      // User-owned, hashed, never-expiring keys, managed through the plugin's own session routes
      // (create, get, list, update, delete under /api/auth/api-key). verify and delete-all-expired
      // are server-only and answer 404 over HTTP. The plugin's rate limit stays off: it lives on the
      // key row, so deleting a key would drop it; the per-user quotas in worker/limits.ts cover
      // every key, and keyRules above charges key creation and changes to the same writes budget.
      // deferUpdates stays off: with database storage it defers nothing the request waits on (the
      // use is recorded by an awaited claim) and only adds an expired-key sweep to each verify.
      // Keys are never turned into sessions: enableSessionForAPIKeys stays false.
      apiKey({
        defaultPrefix: API_KEY_PREFIX,
        defaultKeyLength: API_KEY_LENGTH,
        requireName: true,
        maximumNameLength: API_KEY_NAME_MAX,
        startingCharactersConfig: { shouldStore: true, charactersLength: API_KEY_PREFIX.length + 6 },
        keyExpiration: { defaultExpiresIn: null, disableCustomExpiresTime: true },
        rateLimit: { enabled: false },
      }),
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, config: AppConfig = readConfig(env)) {
  const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);
  return betterAuth(authOptions(config, env.DB, createMailer(env, config, waitUntil), waitUntil, env.DB));
}

export type Auth = ReturnType<typeof createAuth>;
