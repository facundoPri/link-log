// Test-only Better Auth instance: the production options plus Test Utils, which creates users and
// sessions without HTTP routes. Never imported by worker/ (tests/bundle.test.ts checks the bundle).
// It does not exercise passwords or magic links: tests/auth.test.ts covers those with real flows.
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { authOptions } from "../../worker/auth";
import { readConfig } from "../../worker/config";

export function createTestAuth(env: Env) {
  const base = authOptions(readConfig(env), env.DB, { send() {} }, () => {}, env.DB);
  return betterAuth({ ...base, plugins: [...base.plugins, testUtils()] });
}

/** Creates a verified user and a real D1 session; returns its cookie header for the Worker. */
export async function testSession(env: Env, email: string) {
  const ctx = await createTestAuth(env).$context;
  const user = await ctx.test.saveUser(ctx.test.createUser({ email, name: email.split("@")[0], emailVerified: true }));
  const { cookies } = await ctx.test.login({ userId: user.id });
  return { userId: user.id, cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
}

/** Creates an active API key owned by `userId`; returns its id and the full `lk_` secret. */
export async function testApiKey(env: Env, userId: string, name = "Test key") {
  const created = await createTestAuth(env).api.createApiKey({ body: { name, userId } });
  return { id: created.id, key: created.key };
}
