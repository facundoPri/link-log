import { betterAuth, type BetterAuthOptions } from "better-auth";
import { magicLink } from "better-auth/plugins/magic-link";
import { isLocalEnv, readConfig, type AppConfig } from "./config";
import { createMailer } from "./email";

export const AUTH_BASE_PATH = "/api/auth";
export const SESSION_EXPIRES_IN = 60 * 60 * 24 * 7;
export const SESSION_UPDATE_AGE = 60 * 60 * 24;
export const MAGIC_LINK_EXPIRES_IN = 60 * 5;

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

/**
 * Shared Better Auth options. The production factory below and the test-only instance in
 * tests/support use this same function so they cannot drift; only tests add Test Utils.
 */
export function authOptions(
  config: AppConfig,
  database: NonNullable<BetterAuthOptions["database"]>,
  mailer: Mailer,
  waitUntil: (p: Promise<unknown>) => void,
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
    telemetry: { enabled: false },
    logger: {
      level: "warn",
      // Better Auth may pass request details as extra arguments; keep only its message.
      log: (level, message) => console[level === "debug" ? "log" : level](`[auth] ${message}`),
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
    ],
  } satisfies BetterAuthOptions;
}

export function createAuth(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, config: AppConfig = readConfig(env)) {
  const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);
  return betterAuth(authOptions(config, env.DB, createMailer(env, config, waitUntil), waitUntil));
}

export type Auth = ReturnType<typeof createAuth>;
