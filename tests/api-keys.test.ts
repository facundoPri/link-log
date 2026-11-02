// FAC-154: API keys are created, listed, enabled, revoked and deleted from Settings through the API
// key plugin's own session routes (/api/auth/api-key/*), as shipped. The secret is shown once; another
// user's keys answer like missing ones; a client cannot set the plugin's server-only fields.
import { beforeEach, describe, expect, test } from "bun:test";
import { findBySecret } from "../worker/api-key-table";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { createTestAuth, testApiKey, testSession } from "./support/auth.test-instance";
import { keyRoutes, type PluginKey } from "./support/api-key-routes";
import { expect429, setUsed, stayInsideWindow } from "./support/quota";

let db: TestD1, env: Env, call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };

beforeEach(async () => {
  await stayInsideWindow(60);
  db = await TestD1.migrated();
  ({ env } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
});

const as = (who: { cookie: string }) => keyRoutes(call, who);
// Whether the key still authenticates, as the public API checks it. Verifying records last use.
const verified = async (key: string) => (await createTestAuth(env).api.verifyApiKey({ body: { key } })).valid;
const created = async (who: { cookie: string }, name: string) => (await (await as(who).create({ name })).json()) as PluginKey & { key: string };
// A key as the get route answers it, to compare before and after an attempt to change it.
const snapshot = async (who: { cookie: string }, id: string) => (await (await as(who).get(id)).json()) as Record<string, unknown>;
const quiet = async <T>(run: () => Promise<T>) => {
  const { warn, error, log } = console;
  console.warn = console.error = console.log = () => {};
  try {
    return await run();
  } finally {
    Object.assign(console, { warn, error, log });
  }
};

describe("creating and listing", () => {
  test("a named key returns its lk_ secret once; the list shows only the visible start", async () => {
    const res = await as(A).create({ name: "Shortcuts" });
    expect(res.status).toBe(200);
    const key = (await res.json()) as PluginKey & { key: string };
    expect(key.key).toMatch(/^lk_[A-Za-z]{40,}$/);
    expect(key).toMatchObject({ name: "Shortcuts", enabled: true, lastRequest: null, referenceId: A.userId });
    expect(key.key.startsWith(key.start!)).toBe(true);
    expect(key.start!.length).toBeLessThan(12);
    expect(await verified(key.key)).toBe(true);

    const raw = await (await as(A).list()).text();
    expect(raw).not.toContain(key.key);
    expect((JSON.parse(raw) as { apiKeys: { key?: string }[] }).apiKeys.map((k) => k.key)).toEqual([undefined]);
    expect(await (await as(A).get(key.id)).text()).not.toContain(key.key);
  });

  test("a key needs a short name, but names may repeat and there is no cap on keys", async () => {
    expect((await as(A).create({})).status).toBe(400);
    expect((await as(A).create({ name: "" })).status).toBe(400);
    expect((await as(A).create({ name: 42 })).status).toBe(400);
    expect((await as(A).create({ name: "x".repeat(33) })).status).toBe(400);
    expect(await as(A).keys()).toEqual([]);

    for (let i = 0; i < 12; i++) expect((await as(A).create({ name: "Same" })).status).toBe(200);
    expect(await as(A).keys()).toHaveLength(12);
  });

  test("the list shows last use once a key has been verified", async () => {
    const { key, id } = await created(A, "Server");
    expect((await as(A).keys())[0]!.lastRequest).toBeNull();
    expect(await verified(key)).toBe(true);
    const listed = (await as(A).keys()).find((k) => k.id === id)!;
    expect(Date.parse(listed.lastRequest!)).not.toBeNaN();
  });
});

describe("revoking, enabling and deleting", () => {
  test("a Revoked API key stays listed and stops authenticating; enabling it makes it work again", async () => {
    const { id, key } = await created(A, "CI");
    expect((await as(A).revoke(id)).status).toBe(200);
    expect((await as(A).keys()).map((k) => [k.id, k.enabled])).toEqual([[id, false]]);
    expect(await verified(key)).toBe(false);
    // Revoking again is harmless.
    expect((await as(A).revoke(id)).status).toBe(200);

    expect((await as(A).enable(id)).status).toBe(200);
    expect((await as(A).keys()).map((k) => k.enabled)).toEqual([true]);
    expect(await verified(key)).toBe(true);
  });

  test("a deleted key disappears from the list and its secret stops authenticating, active or revoked", async () => {
    const active = await created(A, "Active");
    const revoked = await created(A, "Revoked");
    await as(A).revoke(revoked.id);

    const res = await as(A).remove(active.id);
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ success: true });
    expect((await as(A).remove(revoked.id)).status).toBe(200);
    expect(await as(A).keys()).toEqual([]);
    expect((await as(A).get(active.id)).status).toBe(404);
    expect(await verified(active.key)).toBe(false);
    expect(await verified(revoked.key)).toBe(false);
    expect((await as(A).remove(active.id)).status).toBe(404);
  });

  test("a key can be renamed", async () => {
    const { id } = await created(A, "Old name");
    expect((await as(A).update({ keyId: id, name: "New name" })).status).toBe(200);
    expect((await as(A).keys()).map((k) => k.name)).toEqual(["New name"]);
  });
});

describe("ownership", () => {
  test("another user cannot list, get, update or delete these keys; foreign ids answer like missing ones", async () => {
    const { id, key } = await created(A, "Mine");
    const before = await snapshot(A, id);
    expect(await as(B).keys()).toEqual([]);

    const attempts = (target: string) => [
      as(B).get(target),
      as(B).update({ keyId: target, enabled: false }),
      as(B).update({ keyId: target, name: "Stolen" }),
      as(B).remove(target),
    ];
    const foreign = await Promise.all(attempts(id));
    const missing = await Promise.all(attempts("does-not-exist"));
    for (const [i, res] of foreign.entries()) {
      expect(res.status).toBe(404);
      expect([missing[i]!.status, await missing[i]!.json()]).toEqual([404, await res.json()]);
    }

    expect(await snapshot(A, id)).toEqual(before);
    expect(await verified(key)).toBe(true);
  });

  test("a key created for another user through the body is refused, and the body cannot name another owner on update", async () => {
    expect((await as(A).create({ name: "x", userId: B.userId })).status).toBe(401);
    const { id } = await created(A, "Mine");
    expect((await as(A).update({ keyId: id, userId: B.userId, enabled: false })).status).toBe(401);
    expect(await as(B).keys()).toEqual([]);
    expect((await as(A).keys()).map((k) => k.enabled)).toEqual([true]);
  });
});

describe("what a client cannot set", () => {
  // The plugin's server-only fields (create and update) and the ones this app turns off.
  const serverOnly: Record<string, unknown> = {
    remaining: 1,
    refillAmount: 5,
    refillInterval: 1000,
    rateLimitMax: 1,
    rateLimitTimeWindow: 1000,
    rateLimitEnabled: true,
    permissions: { links: ["write"] },
  };

  test("creating with a server-only field is refused and creates nothing", async () => {
    for (const [field, value] of Object.entries(serverOnly)) {
      const res = await as(A).create({ name: "Sneaky", [field]: value, ...(field === "refillAmount" ? { refillInterval: 1000 } : {}) });
      expect([field, res.status, ((await res.json()) as { code: string }).code]).toEqual([field, 400, "SERVER_ONLY_PROPERTY"]);
    }
    expect(await as(A).keys()).toEqual([]);
  });

  test("updating a server-only field is refused and changes nothing", async () => {
    const { id } = await created(A, "Mine");
    const before = await snapshot(A, id);
    for (const [field, value] of Object.entries(serverOnly)) {
      const res = await as(A).update({ keyId: id, enabled: false, [field]: value });
      expect([field, res.status, ((await res.json()) as { code: string }).code]).toEqual([field, 400, "SERVER_ONLY_PROPERTY"]);
    }
    expect(await snapshot(A, id)).toEqual(before);
  });

  test("keys never expire, carry no metadata and no owner but the signed-in user", async () => {
    const { id } = await created(A, "Mine");
    const before = await snapshot(A, id);
    for (const res of [
      await as(A).create({ name: "x", expiresIn: 60 }),
      await as(A).create({ name: "x", metadata: { a: 1 } }),
      await as(A).update({ keyId: id, expiresIn: 60 }),
      await as(A).update({ keyId: id, expiresIn: null }),
    ])
      expect(res.status).toBe(400);
    // Metadata is not enabled, so an update carrying it changes nothing else but what is allowed.
    expect((await as(A).update({ keyId: id, name: "Renamed", metadata: { a: 1 } })).status).toBe(200);
    const after = await snapshot(A, id);
    expect(after).toMatchObject({ name: "Renamed", expiresAt: null, metadata: null, permissions: null, remaining: null, referenceId: A.userId });
    expect({ ...after, name: 0, updatedAt: 0 }).toEqual({ ...before, name: 0, updatedAt: 0 });
  });

  test("a client cannot choose the prefix or the configuration: keys always start with lk_", async () => {
    for (const extra of [{ prefix: "abc" }, { prefix: "lk_" }, { prefix: "" }, { configId: "default" }, { configId: "other" }]) {
      const res = await as(A).create({ name: "Prefixed", ...extra });
      expect([extra, res.status, ((await res.json()) as { code: string }).code]).toEqual([extra, 400, "SERVER_ONLY_PROPERTY"]);
    }
    expect(await as(A).keys()).toEqual([]);
    // Without them, the key is made as usual.
    const { key, start } = await created(A, "Plain");
    expect(key.startsWith("lk_")).toBe(true);
    expect(start!.startsWith("lk_")).toBe(true);
  });
});

describe("access", () => {
  test("every key route requires a session", async () => {
    const { id } = await created(A, "Mine");
    const attempts: [string, string, unknown?][] = [
      ["POST", "/api/auth/api-key/create", { name: "x" }],
      ["GET", "/api/auth/api-key/list"],
      ["GET", `/api/auth/api-key/get?id=${id}`],
      ["POST", "/api/auth/api-key/update", { keyId: id, enabled: false }],
      ["POST", "/api/auth/api-key/delete", { keyId: id }],
    ];
    await quiet(async () => {
      for (const [method, path, body] of attempts) expect([path, (await call(path, { method, body })).status]).toEqual([path, 401]);
    });
    expect((await as(A).keys()).map((k) => k.enabled)).toEqual([true]);
  });

  test("a write from another origin, or with none, is refused even with a valid session", async () => {
    const { id } = await created(A, "Mine");
    await quiet(async () => {
      for (const origin of ["https://evil.example", null]) {
        for (const res of [await as(A).create({ name: "x" }, { origin }), await as(A).update({ keyId: id, enabled: false }, { origin }), await as(A).remove(id, { origin })])
          expect([origin, res.status]).toEqual([origin, 403]);
      }
    });
    expect((await as(A).keys()).map((k) => [k.id, k.enabled])).toEqual([[id, true]]);
  });

  test("verify and delete-all-expired are unreachable over HTTP, even with a session", async () => {
    const { id, key } = await created(A, "Mine");
    const attempts: [string, string, unknown?][] = [
      ["POST", "/api/auth/api-key/verify", { key }],
      ["POST", "/api/auth/api-key/verify-api-key", { key }],
      ["POST", "/api/auth/api-key/delete-all-expired-api-keys", {}],
      ["POST", "/api/auth/api-key/delete-all-expired", {}],
    ];
    for (const [method, path, body] of attempts)
      expect([path, (await call(path, { method, cookie: A.cookie, body })).status]).toEqual([path, 404]);
    expect((await as(A).keys()).map((k) => k.id)).toEqual([id]);
  });

  test("the app's own key routes are gone", async () => {
    const { id } = await created(A, "Mine");
    for (const [method, path] of [["GET", "/api/api-keys"], ["POST", "/api/api-keys"], ["POST", `/api/api-keys/${id}/revoke`], ["POST", `/api/api-keys/${id}/regenerate`]] as const)
      expect([path, (await call(path, { method, cookie: A.cookie, body: method === "GET" ? undefined : {} })).status]).toEqual([path, 404]);
  });
});

describe("the write budget", () => {
  // Creating, renaming and enabling a key are writes: they draw on the same per-user
  // writes-per-minute budget as the web app and the API keys, so a session cannot mint keys without bound.
  test("once the budget is spent, a key cannot be created, renamed or enabled, and nothing changes", async () => {
    const { id } = await created(A, "Mine");
    await as(A).revoke(id);
    const before = await snapshot(A, id);
    setUsed(db, `writes:${A.userId}`, 120, 60);
    await expect429(() => as(A).create({ name: "More" }), "writes", 60);
    await expect429(() => as(A).update({ keyId: id, name: "Renamed" }), "writes", 60);
    await expect429(() => as(A).enable(id), "writes", 60);
    // Revoking while renaming is not a plain revoke: it stays charged.
    await expect429(() => as(A).update({ keyId: id, enabled: false, name: "Renamed" }), "writes", 60);
    expect(await as(A).keys()).toHaveLength(1);
    expect(await snapshot(A, id)).toEqual(before);
  });

  // Whoever holds a leaked key can spend the owner's budget with submissions, so the owner must
  // still be able to kill the key.
  test("a budget spent by the key's own submissions still lets the owner revoke and delete it", async () => {
    const leaked = await testApiKey(env, A.userId, "Leaked");
    const other = await testApiKey(env, A.userId, "Other");
    const submit = (key: string) => call("/api/v1/links", { origin: null, headers: { authorization: `Bearer ${key}` }, body: { urls: ["not a url"] } });
    for (let i = 0; i < 120; i++) await submit(leaked.key);
    expect((await submit(leaked.key)).status).toBe(429);
    await expect429(() => as(A).create({ name: "More" }), "writes", 60);

    expect((await as(A).revoke(leaked.id)).status).toBe(200);
    expect((await submit(leaked.key)).status).toBe(401);
    expect((await as(A).remove(other.id)).status).toBe(200);
    expect((await as(A).remove(leaked.id)).status).toBe(200);
    expect(await as(A).keys()).toEqual([]);
    expect((await submit(leaked.key)).status).toBe(401);
  });

  test("a refused key write is an answer, not an error line in the logs", async () => {
    setUsed(db, `writes:${A.userId}`, 120, 60);
    const logs: string[] = [];
    const { warn, error, log } = console;
    console.warn = console.error = console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      expect((await as(A).create({ name: "More" })).status).toBe(429);
      expect((await as(B).create({ name: "Mine", prefix: "x_" })).status).toBe(400);
      expect(logs).toEqual([]);
      // A real failure is still logged.
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (/apikey/i.test(sql)) throw new Error("D1_ERROR: Network connection lost."); // setup: a D1 outage on the key table
        return prepare(sql);
      }) as typeof db.prepare;
      expect((await as(A).list()).status).toBe(500);
      db.prepare = prepare;
    } finally {
      Object.assign(console, { warn, error, log });
    }
    expect(logs.some((l) => l.startsWith("[auth] "))).toBe(true);
  });

  test("reading keys is free, and another user's budget is untouched", async () => {
    setUsed(db, `writes:${A.userId}`, 120, 60);
    expect((await as(A).list()).status).toBe(200);
    expect((await as(A).get("missing")).status).toBe(404);
    expect((await as(B).create({ name: "Mine" })).status).toBe(200);
  });

  test("key writes and web writes spend one budget", async () => {
    setUsed(db, `writes:${A.userId}`, 118, 60);
    expect((await as(A).create({ name: "One" })).status).toBe(200);
    expect((await call("/api/tags", { cookie: A.cookie, body: { name: "t" } })).status).toBe(200);
    await expect429(() => as(A).create({ name: "Two" }), "writes", 60);
    await expect429(() => call("/api/tags", { cookie: A.cookie, body: { name: "u" } }), "writes", 60);
  });

  test("a spent budget refuses a key write in Better Auth's error shape, and API submissions too", async () => {
    const key = await testApiKey(env, A.userId, "Shortcuts");
    setUsed(db, `writes:${A.userId}`, 120, 60);
    const res = await as(A).create({ name: "More" });
    expect([res.status, await res.json()]).toEqual([429, { message: "Too many requests. Try again later.", code: "writes" }]);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const viaKey = await call("/api/v1/links", { origin: null, headers: { authorization: `Bearer ${key.key}` }, body: { urls: ["https://example.com/a"] } });
    expect(viaKey.status).toBe(429);
  });
});

describe("the plugin's storage, as worker/api-key-table.ts reads it", () => {
  // findBySecret hashes with the plugin's own defaultKeyHasher and reads its "key" and "enabled"
  // columns. If an upgrade changes how a secret is stored, this fails by name before the public API
  // starts answering 503 for every key.
  test("a key made through createApiKey is found by its secret, with its enabled flag; another secret is not", async () => {
    const { id, key } = await testApiKey(env, A.userId, "Pinned");
    expect(await findBySecret(env.DB, key)).toEqual({ enabled: true });
    expect((await as(A).revoke(id)).status).toBe(200);
    expect(await findBySecret(env.DB, key)).toEqual({ enabled: false });
    expect(await findBySecret(env.DB, `${key}x`)).toBeNull();
  });
});
