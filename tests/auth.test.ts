// Real Better Auth flows through the Worker entry (router -> Better Auth -> D1 dialect over SQLite).
// Login is never simulated here: sign-up, verification, magic link and reset use the emailed links.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, cookieOf, linkFrom, makeEnv, signUpVerified, TEST_ORIGIN } from "./support/env";
import { testSession } from "./support/auth.test-instance";

const PASSWORD = "correct horse battery";
let logs: string[] = [];
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  logs = [];
  spies = (["log", "info", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" "))),
  );
});
afterEach(() => spies.forEach((s) => s.mockRestore()));

async function setup(overrides: Record<string, unknown> = {}) {
  const db = await TestD1.migrated();
  const { env, outbox } = makeEnv(db, overrides);
  return { db, env, outbox, call: client(env) };
}
const tokenOf = (url: URL) => url.searchParams.get("token") ?? url.pathname.split("/").pop()!;

describe("email + password", () => {
  test("sign-up requires verification, then the emailed link signs in", async () => {
    const { call, outbox, db } = await setup();
    const signUp = await call("/api/auth/sign-up/email", { body: { email: "a@example.test", password: PASSWORD, name: "a" } });
    expect(signUp.status).toBe(200);
    expect(cookieOf(signUp)).toBe("");

    // Unverified sign-in is refused and re-sends the verification email.
    const early = await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: PASSWORD } });
    expect(early.status).toBe(403);
    expect(((await early.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
    expect(outbox.filter((m) => m.subject.includes("Confirm")).length).toBe(2);

    const verify = linkFrom(outbox, "a@example.test", "Confirm email");
    expect(verify.origin).toBe(TEST_ORIGIN);
    const verified = await call(verify.pathname + verify.search);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe("/");
    const setCookie = verified.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("linklog.session_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect((await call("/api/library", { cookie: cookieOf(verified) })).status).toBe(200);
    expect(db.sqlite.query('SELECT "emailVerified" v FROM "user"').get()).toEqual({ v: 1 });

    // Replaying the (stateless, signed) verification link after use never mints another session.
    const again = await call(verify.pathname + verify.search);
    expect(cookieOf(again)).toBe("");
  });

  test("password sign-in, wrong password and sign-out", async () => {
    const { call, outbox } = await setup();
    await signUpVerified(call, outbox, "a@example.test", PASSWORD);
    expect((await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: "wrong password!!" } })).status).toBe(401);
    const signIn = await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: PASSWORD } });
    expect(signIn.status).toBe(200);
    const cookie = cookieOf(signIn);
    expect((await call("/api/library", { cookie })).status).toBe(200);
    const out = await call("/api/auth/sign-out", { body: {}, cookie });
    expect(out.status).toBe(200);
    expect((await call("/api/library", { cookie })).status).toBe(401);
  });

  test("an expired or revoked session is rejected on the next request", async () => {
    const { call, outbox, db } = await setup();
    const cookie = await signUpVerified(call, outbox, "a@example.test");
    expect((await call("/api/library", { cookie })).status).toBe(200);
    db.sqlite.exec(`UPDATE "session" SET "expiresAt"='2000-01-01T00:00:00.000Z'`);
    expect((await call("/api/library", { cookie })).status).toBe(401);

    const fresh = cookieOf(await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: PASSWORD } }));
    expect((await call("/api/library", { cookie: fresh })).status).toBe(200);
    db.sqlite.exec(`DELETE FROM "session"`);
    expect((await call("/api/library", { cookie: fresh })).status).toBe(401);
  });

  test("password reset revokes old sessions and the token works once", async () => {
    const { call, outbox } = await setup();
    const oldCookie = await signUpVerified(call, outbox, "a@example.test");
    const request = await call("/api/auth/request-password-reset", { body: { email: "a@example.test", redirectTo: "/reset-password" } });
    expect(request.status).toBe(200);
    // Unknown addresses get the same answer and no email.
    const unknown = await call("/api/auth/request-password-reset", { body: { email: "nobody@example.test", redirectTo: "/reset-password" }, ip: "203.0.113.99" });
    expect(unknown.status).toBe(200);
    expect(outbox.some((m) => m.to === "nobody@example.test")).toBe(false);

    const link = linkFrom(outbox, "a@example.test", "Choose a new password");
    const callback = await call(link.pathname + link.search);
    expect(callback.status).toBe(302);
    const target = new URL(callback.headers.get("location")!, TEST_ORIGIN);
    expect(target.pathname).toBe("/reset-password");
    const token = target.searchParams.get("token")!;

    const reset = await call("/api/auth/reset-password", { body: { newPassword: "a brand new password", token } });
    expect(reset.status).toBe(200);
    expect((await call("/api/library", { cookie: oldCookie })).status).toBe(401);
    expect((await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: PASSWORD }, ip: "203.0.113.30" })).status).toBe(401);
    expect((await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: "a brand new password" }, ip: "203.0.113.31" })).status).toBe(200);
    expect((await call("/api/auth/reset-password", { body: { newPassword: "yet another password", token }, ip: "203.0.113.32" })).status).toBe(400);
  });
});

describe("magic link", () => {
  test("creates a verified account; the link is single-use", async () => {
    const { call, outbox, db } = await setup();
    const sent = await call("/api/auth/sign-in/magic-link", { body: { email: "new@example.test", callbackURL: "/", errorCallbackURL: "/" } });
    expect(sent.status).toBe(200);
    const link = linkFrom(outbox, "new@example.test", "Sign in");
    expect(link.pathname).toBe("/api/auth/magic-link/verify");
    // Stored hashed: the emailed token is not what D1 holds.
    expect(JSON.stringify(db.sqlite.query('SELECT identifier,value FROM "verification"').all())).not.toContain(tokenOf(link));

    const first = await call(link.pathname + link.search);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location")!, TEST_ORIGIN).href).toBe(`${TEST_ORIGIN}/`);
    const cookie = cookieOf(first);
    expect((await call("/api/library", { cookie })).status).toBe(200);
    expect(db.sqlite.query('SELECT "emailVerified" v FROM "user" WHERE email=?').get("new@example.test")).toEqual({ v: 1 });

    const second = await call(link.pathname + link.search);
    expect(second.status).toBe(302);
    expect(second.headers.get("location")).toContain("error=");
    expect(cookieOf(second)).toBe("");
  });

  test("an expired link is rejected", async () => {
    const { call, outbox, db } = await setup();
    await call("/api/auth/sign-in/magic-link", { body: { email: "late@example.test", callbackURL: "/", errorCallbackURL: "/" } });
    const link = linkFrom(outbox, "late@example.test", "Sign in");
    db.sqlite.exec(`UPDATE "verification" SET "expiresAt"='2000-01-01T00:00:00.000Z'`);
    const response = await call(link.pathname + link.search);
    expect(response.headers.get("location")).toContain("error=");
    expect(cookieOf(response)).toBe("");
  });

  test("on an unverified account with a password, it removes that password and its sessions", async () => {
    const { call, outbox, db } = await setup();
    // Someone registers the address with a password but never confirms it.
    await call("/api/auth/sign-up/email", { body: { email: "victim@example.test", password: "attacker password", name: "x" } });
    await call("/api/auth/sign-in/magic-link", { body: { email: "victim@example.test", callbackURL: "/", errorCallbackURL: "/" } });
    const link = linkFrom(outbox, "victim@example.test", "Sign in");
    const owner = await call(link.pathname + link.search);
    expect(owner.status).toBe(302);
    expect((await call("/api/library", { cookie: cookieOf(owner) })).status).toBe(200);
    // The pre-verification password no longer opens the account.
    const reuse = await call("/api/auth/sign-in/email", { body: { email: "victim@example.test", password: "attacker password" } });
    expect(reuse.status).toBe(401);
    expect(db.sqlite.query(`SELECT count(*) c FROM "account" WHERE password IS NOT NULL`).get()).toEqual({ c: 0 });
  });
});

describe("abuse limits", () => {
  test("concurrent sign-in attempts from one IP stop at the D1-backed limit", async () => {
    const { call, outbox } = await setup();
    await signUpVerified(call, outbox, "a@example.test");
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: "wrong password!!" }, ip: "198.51.100.7" }),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBe(7);
    expect(statuses.filter((s) => s === 401).length).toBe(5);
  });

  test("auth email per recipient is capped even across IPs, without changing the answer", async () => {
    const { call, outbox } = await setup();
    for (let i = 0; i < 8; i++) {
      const response = await call("/api/auth/sign-in/magic-link", { body: { email: "flood@example.test", callbackURL: "/" }, ip: `192.0.2.${i + 1}` });
      expect(response.status).toBe(200);
    }
    expect(outbox.filter((m) => m.to === "flood@example.test").length).toBe(5);
    expect(logs.some((l) => l.includes("suppressed_limit"))).toBe(true);
  });

  test("the global daily email budget suppresses sends once spent", async () => {
    const { call, outbox } = await setup({ AUTH_EMAIL_DAILY_LIMIT: "2" });
    for (let i = 0; i < 4; i++)
      await call("/api/auth/sign-in/magic-link", { body: { email: `u${i}@example.test`, callbackURL: "/" }, ip: `192.0.2.${i + 50}` });
    expect(outbox.length).toBe(2);
  });
});

describe("CSRF, origins and policies", () => {
  test("auth endpoints reject untrusted origins and callback URLs", async () => {
    const { call, outbox } = await setup();
    const cookie = await signUpVerified(call, outbox, "a@example.test");
    expect((await call("/api/auth/sign-out", { body: {}, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/auth/sign-out", { body: {}, cookie, origin: null })).status).toBe(403);
    const redirect = await call("/api/auth/sign-in/magic-link", { body: { email: "a@example.test", callbackURL: "https://evil.example/steal" } });
    expect(redirect.status).toBe(403);
    expect((await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: PASSWORD }, origin: "http://127.0.0.1:3000" })).status).toBe(403);
  });

  test("app writes need the exact origin, same-site fetch metadata and JSON", async () => {
    const { call, outbox } = await setup();
    const cookie = await signUpVerified(call, outbox, "a@example.test");
    const body = { url: "https://example.com/a" };
    expect((await call("/api/links", { body, cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/links", { body, cookie, origin: null })).status).toBe(403);
    expect((await call("/api/links", { body, cookie, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const form = await call("/api/links", { cookie, method: "POST", headers: { "content-type": "text/plain" } });
    expect(form.status).toBe(415);
    expect((await call("/api/links", { body, cookie })).status).toBe(201);
  });

  test("the API is private by default: no session, no route discovery", async () => {
    const { call, env } = await setup();
    expect((await call("/api/admin")).status).toBe(401);
    expect((await call("/api/library")).status).toBe(401);
    expect((await call("/api/library", { method: "POST", body: {} })).status).toBe(401);
    const { cookie } = await testSession(env, "routes@example.test");
    expect((await call("/api/admin", { cookie })).status).toBe(404);
    expect((await call("/api/library", { method: "POST", body: {}, cookie })).status).toBe(404);
    expect((await call("/api/auth/sign-in/email", { method: "PUT", body: {} })).status).toBe(405);
    expect((await call("/api/auth/update-user", { body: { name: "x" } })).status).toBe(404);
    expect((await call("/api/auth/sign-in/social", { body: { provider: "github" } })).status).toBe(404);
    expect((await call("/api/usage", { cookie: "linklog.session_token=forged.value" })).status).toBe(401);
    // The SPA shell is public and carries no library data.
    const shell = await call("/");
    expect(shell.status).toBe(200);
    expect(await shell.text()).not.toContain("original_url");
  });
});

describe("fail-closed configuration", () => {
  const prod = {
    APP_ENV: "production",
    BETTER_AUTH_URL: "https://linklog.example",
    BETTER_AUTH_SECRET: "q3Vt9w7yZ2pX5rK8mN1bC4dF6gH0jL2sQ9tW",
    EMAIL_FROM: "Linklog <auth@linklog.example>",
  };
  const cases: [string, Record<string, unknown>][] = [
    ["missing APP_ENV", { APP_ENV: undefined }],
    ["unknown APP_ENV", { APP_ENV: "staging" }],
    ["missing URL", { BETTER_AUTH_URL: undefined }],
    ["URL with path", { BETTER_AUTH_URL: "http://localhost:3000/app" }],
    ["short secret", { BETTER_AUTH_SECRET: "short" }],
    ["missing email binding", { EMAIL: undefined }],
    ["local env on a public host", { BETTER_AUTH_URL: "https://linklog.example" }],
    ["production over http", { ...prod, BETTER_AUTH_URL: "http://linklog.example" }],
    ["production on loopback", { ...prod, BETTER_AUTH_URL: "https://localhost" }],
    ["production with a dev secret", { ...prod, BETTER_AUTH_SECRET: "changeme-changeme-changeme-changeme-123" }],
    ["production without sender", { ...prod, EMAIL_FROM: undefined }],
    ["production with the fixture Jev provider", { ...prod, JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" }],
  ];
  for (const [name, overrides] of cases)
    test(`${name} -> 503 on every API route`, async () => {
      const { call } = await setup(overrides);
      expect((await call("/api/library")).status).toBe(503);
      expect((await call("/api/auth/get-session")).status).toBe(503);
      expect(logs.join("\n")).not.toContain(String(overrides.BETTER_AUTH_SECRET ?? "q3Vt9w7y"));
    });

  test("production accepts only its own host and sets __Secure- cookies", async () => {
    const { env, outbox } = await setup(prod);
    const other = client(env, "https://linklog.workers.dev");
    expect((await other("/api/library")).status).toBe(403);
    const call = client(env, prod.BETTER_AUTH_URL);
    expect((await call("/api/library", { origin: prod.BETTER_AUTH_URL })).status).toBe(401);
    await call("/api/auth/sign-up/email", { body: { email: "p@example.test", password: PASSWORD, name: "p" }, origin: prod.BETTER_AUTH_URL });
    const verify = linkFrom(outbox, "p@example.test", "Confirm email");
    expect(verify.origin).toBe(prod.BETTER_AUTH_URL);
    expect(outbox[0]!.from).toBe(prod.EMAIL_FROM);
    const verified = await call(verify.pathname + verify.search);
    const setCookie = verified.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("__Secure-linklog.session_token=");
    expect(setCookie).toContain("Secure");
  });
});

test("logs never contain passwords, tokens, cookies or emailed URLs", async () => {
  const { call, outbox } = await setup();
  const cookie = await signUpVerified(call, outbox, "a@example.test", PASSWORD);
  await call("/api/auth/sign-in/magic-link", { body: { email: "a@example.test", callbackURL: "/" } });
  await call("/api/auth/request-password-reset", { body: { email: "a@example.test", redirectTo: "/reset-password" } });
  await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: "wrong password!!" } });
  await call("/api/auth/sign-in/magic-link", { body: { email: "a@example.test", callbackURL: "https://evil.example" } });
  const text = logs.join("\n");
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain("wrong password!!");
  expect(text).not.toContain(cookie.split("=")[1]!);
  for (const mail of outbox) {
    const url = mail.text.match(/https?:\/\/\S+/)![0];
    expect(text).not.toContain(url);
    expect(text).not.toContain(tokenOf(new URL(url)));
  }
  expect(text).not.toContain("a@example.test");
});
