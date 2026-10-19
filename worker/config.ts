// Runtime configuration for auth. Anything missing or inconsistent fails closed: the API answers 503
// instead of running with a weaker setup. Local/test relax only HTTPS and the email sender, never checks.
export type AppEnv = "local" | "test" | "preview" | "production";
export type AppConfig = {
  appEnv: AppEnv;
  /** Public origin seen by the browser, e.g. https://linklog.example or http://localhost:3000. */
  baseURL: string;
  secret: string;
  emailFrom: string;
  emailDailyLimit: number;
};
export class ConfigError extends Error {}

const APP_ENVS: AppEnv[] = ["local", "test", "preview", "production"];
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
// Development-only secrets must never reach a deployed Worker.
const KNOWN_WEAK = /^(changeme|secret|password|better-auth-secret|linklog-dev|test)/i;

export const isLocalEnv = (env: AppEnv) => env === "local" || env === "test";
/**
 * The deterministic test provider. Checked where it runs (Queue/Workflow included), not only by
 * readConfig on HTTP requests: both flags plus a local/test APP_ENV, or nothing.
 */
export const fixtureJevAllowed = (env: Env) =>
  env.JEV_PROVIDER === "fixture" && env.ALLOW_FIXTURE_JEV === "1" && isLocalEnv(String(env.APP_ENV ?? "") as AppEnv);
export const isLoopbackHost = (hostname: string) => LOOPBACK.includes(hostname);

export function readConfig(env: Env): AppConfig {
  const appEnv = String(env.APP_ENV ?? "") as AppEnv;
  if (!APP_ENVS.includes(appEnv)) throw new ConfigError("APP_ENV is missing or unknown.");
  const local = isLocalEnv(appEnv);

  let url: URL;
  try {
    url = new URL(String(env.BETTER_AUTH_URL ?? ""));
  } catch {
    throw new ConfigError("BETTER_AUTH_URL is missing or invalid.");
  }
  if (url.origin === "null" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new ConfigError("BETTER_AUTH_URL must be a bare origin.");
  if (local) {
    if (!isLoopbackHost(url.hostname))
      throw new ConfigError("Local and test environments only run on loopback origins.");
  } else if (url.protocol !== "https:" || isLoopbackHost(url.hostname)) {
    throw new ConfigError("Preview and production require a public HTTPS BETTER_AUTH_URL.");
  }

  const secret = String(env.BETTER_AUTH_SECRET ?? "");
  if (secret.length < 32) throw new ConfigError("BETTER_AUTH_SECRET must have at least 32 characters.");
  if (!local && KNOWN_WEAK.test(secret)) throw new ConfigError("BETTER_AUTH_SECRET looks like a development value.");

  if (!env.EMAIL || typeof env.EMAIL.send !== "function") throw new ConfigError("The EMAIL binding is missing.");
  const emailFrom = env.EMAIL_FROM?.trim() || (local ? "Linklog <no-reply@linklog.localhost>" : "");
  if (!/^(?:[^<>@\s][^<>@]*<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(emailFrom))
    throw new ConfigError("EMAIL_FROM is missing or invalid.");

  // The deterministic test provider answers without a model: never in a deployed Worker. Only an
  // explicit "off" (unset, "", "0", "false") passes; "1" or anything ambiguous fails closed.
  if (!local && (env.JEV_PROVIDER === "fixture" || !["", "0", "false"].includes(String(env.ALLOW_FIXTURE_JEV ?? "").trim().toLowerCase())))
    throw new ConfigError("The fixture Jev provider is only available in local and test environments.");

  const limit = Number(env.AUTH_EMAIL_DAILY_LIMIT ?? 200);
  if (!Number.isInteger(limit) || limit < 1) throw new ConfigError("AUTH_EMAIL_DAILY_LIMIT must be a positive integer.");

  return { appEnv, baseURL: url.origin, secret, emailFrom, emailDailyLimit: limit };
}

/** Requests must target the configured host; local runs also accept the loopback API port. */
export function hostAllowed(config: AppConfig, requestUrl: URL) {
  if (isLocalEnv(config.appEnv)) return isLoopbackHost(requestUrl.hostname);
  return requestUrl.host === new URL(config.baseURL).host;
}
