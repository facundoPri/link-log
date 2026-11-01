// Test Worker environment: real router + Better Auth + D1 shim, in-memory R2/Queue/Email fakes.
import worker from "../../worker/index";
import { TestD1 } from "./d1";

export type SentEmail = { to: string; from: string; subject: string; text: string; html: string };

export class FakeR2 {
  objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, String(value));
    return { key };
  }
  async get(key: string) {
    const value = this.objects.get(key);
    return value === undefined ? null : { text: async () => value };
  }
  async list({ prefix = "" }: { prefix?: string; cursor?: string }) {
    return { objects: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key);
  }
}

export const TEST_ORIGIN = "http://localhost:3000";

export function makeEnv(db: TestD1, overrides: Record<string, unknown> = {}) {
  const outbox: SentEmail[] = [];
  const queued: { id: string }[] = [];
  const env = {
    DB: db.d1,
    CONTENT: new FakeR2(),
    JOBS: { sendBatch: async (messages: { body: { id: string } }[]) => void queued.push(...messages.map((m) => m.body)) },
    PROCESS_LINK: {},
    EMAIL: { send: async (message: SentEmail) => (outbox.push(message), { messageId: crypto.randomUUID() }) },
    ASSETS: { fetch: async () => new Response("<!doctype html><title>Linklog</title>", { headers: { "content-type": "text/html" } }) },
    APP_ENV: "test",
    BETTER_AUTH_URL: TEST_ORIGIN,
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
    ...overrides,
  } as unknown as Env;
  return { env, outbox, queued, r2: env.CONTENT as unknown as FakeR2 };
}

/** Calls the real Worker fetch handler and waits for its waitUntil work (emails, cleanup). */
export function client(env: Env, base = TEST_ORIGIN) {
  return async function call(
    path: string,
    init: { method?: string; body?: unknown; rawBody?: string; cookie?: string; origin?: string | null; ip?: string; headers?: Record<string, string> } = {},
  ) {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const method = init.method ?? (init.body === undefined && init.rawBody === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "203.0.113.10", ...init.headers };
    // `rawBody` is sent as is (a body that is not valid JSON); `body` is JSON-encoded.
    if (init.body !== undefined || init.rawBody !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET" && init.origin !== null) headers.origin = init.origin ?? TEST_ORIGIN;
    if (init.cookie) headers.cookie = init.cookie;
    const response = await worker.fetch(
      new Request(base + path, { method, headers, body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)), redirect: "manual" }) as never,
      env,
      ctx,
    );
    // Workers run waitUntil after responding; settle it so emails/cleanup are observable.
    for (let i = 0; i < pending.length; i++) await pending[i];
    return response;
  };
}

export const cookieOf = (response: Response) =>
  response.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => !/=$/.test(c)).join("; ");

export function linkFrom(outbox: SentEmail[], to: string, action: string) {
  const mail = [...outbox].reverse().find((m) => m.to === to && m.text.includes(`${action}: `));
  if (!mail) throw new Error(`No "${action}" email for ${to}`);
  return new URL(mail.text.split(`${action}: `)[1]!.split(/\s/)[0]!);
}

/** Real sign-up -> verification email -> verification link. Returns the session cookie. */
export async function signUpVerified(call: ReturnType<typeof client>, outbox: SentEmail[], email: string, password = "correct horse battery", ip = "203.0.113.20") {
  const signUp = await call("/api/auth/sign-up/email", { body: { email, password, name: email.split("@")[0], callbackURL: "/" }, ip });
  if (!signUp.ok) throw new Error(`sign-up ${signUp.status} ${await signUp.text()}`);
  const verify = linkFrom(outbox, email, "Confirm email");
  const response = await call(verify.pathname + verify.search, { ip });
  if (response.status !== 302) throw new Error(`verify ${response.status}`);
  return cookieOf(response);
}
