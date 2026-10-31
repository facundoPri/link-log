// FAC-154: API keys are created, listed and revoked from Settings through the session API. The
// secret is shown once; a Revoked API key stays listed; another user's keys answer like missing ones.
// FAC-156: a key is regenerated (new key with the same name, then the old one revoked) and each user
// holds at most 10 active keys.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { createTestAuth, testApiKey, testSession } from "./support/auth.test-instance";

type Key = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; status: "active" | "revoked" };
let db: TestD1, env: Env, call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
});

// Whether the key still authenticates, as the public API will check it (FAC-155). Verifying records last use.
const verified = async (key: string) => (await createTestAuth(env).api.verifyApiKey({ body: { key } })).valid;
const as = (who: { cookie: string }) => ({
  list: async () => (await (await call("/api/api-keys", { cookie: who.cookie })).json()) as { apiKeys: Key[] },
  create: (name: unknown) => call("/api/api-keys", { cookie: who.cookie, body: { name } }),
  revoke: (id: string) => call(`/api/api-keys/${id}/revoke`, { cookie: who.cookie, body: {} }),
  regenerate: (id: string) => call(`/api/api-keys/${id}/regenerate`, { cookie: who.cookie, body: {} }),
});
const fillKeys = async (who: { userId: string }, count: number) => {
  const keys = [];
  for (let i = 1; i <= count; i++) keys.push(await testApiKey(env, who.userId, `Key ${i}`));
  return keys;
};

describe("creating and listing", () => {
  test("a named key returns its lk_ secret once; the list shows only the visible prefix", async () => {
    const created = await as(A).create("Shortcuts");
    expect(created.status).toBe(201);
    const { apiKey, secret } = (await created.json()) as { apiKey: Key; secret: string };
    expect(secret).toMatch(/^lk_[A-Za-z]{40,}$/);
    expect(apiKey).toMatchObject({ name: "Shortcuts", status: "active", lastUsedAt: null });
    expect(secret.startsWith(apiKey.prefix)).toBe(true);
    expect(apiKey.prefix.length).toBeLessThan(12);
    expect(Date.parse(apiKey.createdAt)).not.toBeNaN();

    const raw = await (await call("/api/api-keys", { cookie: A.cookie })).text();
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw)).toEqual({ apiKeys: [apiKey] });
  });

  test("a key needs a short name", async () => {
    expect((await as(A).create("")).status).toBe(400);
    expect((await as(A).create("   ")).status).toBe(400);
    expect((await as(A).create(42)).status).toBe(400);
    expect((await as(A).create("x".repeat(33))).status).toBe(400);
    expect((await as(A).list()).apiKeys).toEqual([]);
  });

  test("newest keys are listed first, with last use once the key has been verified", async () => {
    await as(A).create("Old");
    const { key } = await testApiKey(env, A.userId, "Server");
    expect(await verified(key)).toBe(true);
    const keys = (await as(A).list()).apiKeys;
    expect(keys.map((k) => k.name)).toEqual(["Server", "Old"]);
    expect(Date.parse(keys[0]!.lastUsedAt!)).not.toBeNaN();
    expect(keys[1]!.lastUsedAt).toBeNull();
  });
});

describe("revoking", () => {
  test("a Revoked API key stays listed, no longer verifies and cannot be revived or deleted", async () => {
    const { id, key } = await testApiKey(env, A.userId, "CI");
    const revoked = await as(A).revoke(id);
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { apiKey: Key }).apiKey).toMatchObject({ id, name: "CI", status: "revoked" });
    expect((await as(A).list()).apiKeys.map((k) => [k.id, k.status])).toEqual([[id, "revoked"]]);

    expect(await verified(key)).toBe(false);
    // Revoking again is harmless; there is no route that deletes or re-enables a key.
    expect((await as(A).revoke(id)).status).toBe(200);
    expect((await call(`/api/api-keys/${id}`, { cookie: A.cookie, method: "DELETE", body: {} })).status).toBe(404);
    expect((await as(A).list()).apiKeys.map((k) => k.status)).toEqual(["revoked"]);
  });
});

describe("ownership", () => {
  test("another user cannot list, see or revoke these keys; foreign IDs answer like missing ones", async () => {
    const { id, key } = await testApiKey(env, A.userId, "Mine");
    expect((await as(B).list()).apiKeys).toEqual([]);

    const foreign = await as(B).revoke(id);
    const missing = await as(B).revoke("does-not-exist");
    expect(foreign.status).toBe(404);
    expect([missing.status, await missing.json()]).toEqual([404, await foreign.json()]);

    expect((await as(A).list()).apiKeys.map((k) => k.status)).toEqual(["active"]);
    expect(await verified(key)).toBe(true);
  });
});

describe("access", () => {
  test("key management requires a session and same-origin writes", async () => {
    const { id } = await testApiKey(env, A.userId, "Mine");
    expect((await call("/api/api-keys")).status).toBe(401);
    expect((await call("/api/api-keys", { body: { name: "x" } })).status).toBe(401);
    expect((await call(`/api/api-keys/${id}/revoke`, { body: {} })).status).toBe(401);
    expect((await call("/api/api-keys", { cookie: A.cookie, body: { name: "x" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await as(A).list()).apiKeys.map((k) => k.status)).toEqual(["active"]);
  });

  test("the plugin's own HTTP endpoints are unreachable, even with a session", async () => {
    const { id } = await testApiKey(env, A.userId, "Mine");
    const attempts: [string, string, unknown?][] = [
      ["POST", "/api/auth/api-key/create", { name: "sneaky" }],
      ["GET", "/api/auth/api-key/list"],
      ["GET", `/api/auth/api-key/get?id=${id}`],
      ["POST", "/api/auth/api-key/update", { keyId: id, enabled: true }],
      ["POST", "/api/auth/api-key/delete", { keyId: id }],
      ["POST", "/api/auth/api-key/verify", { key: "lk_x" }],
      ["POST", "/api/auth/api-key/delete-all-expired-api-keys", {}],
    ];
    for (const [method, path, body] of attempts)
      expect([path, (await call(path, { method, cookie: A.cookie, body })).status]).toEqual([path, 404]);
    expect((await as(A).list()).apiKeys.map((k) => k.name)).toEqual(["Mine"]);
  });
});

describe("the cap of 10 active keys", () => {
  test("an 11th active key is refused with a clear message; revoking one allows creating again", async () => {
    const keys = await fillKeys(A, 10);
    const refused = await as(A).create("Eleventh");
    expect(refused.status).toBe(409);
    expect((await refused.json()) as object).toEqual({ error: "You have 10 active API keys. Revoke one to create another.", code: "api_key_limit" });
    expect((await as(A).list()).apiKeys).toHaveLength(10);

    await as(A).revoke(keys[0]!.id);
    expect((await as(A).create("Eleventh")).status).toBe(201);
    expect((await as(A).create("Twelfth")).status).toBe(409);
  });

  test("only active keys count, and each user has their own 10", async () => {
    const keys = await fillKeys(A, 10);
    for (const k of keys) await as(A).revoke(k.id);
    expect((await as(A).create("Fresh")).status).toBe(201);
    await fillKeys(B, 9);
    expect((await as(B).create("Tenth")).status).toBe(201);
    expect((await as(B).create("Eleventh")).status).toBe(409);
  });
});

describe("regenerating", () => {
  test("a new key with the same name replaces the old one, whose secret stops authenticating", async () => {
    const old = await testApiKey(env, A.userId, "Shortcuts");
    const res = await as(A).regenerate(old.id);
    expect(res.status).toBe(201);
    const { apiKey, secret } = (await res.json()) as { apiKey: Key; secret: string };
    expect(secret).toMatch(/^lk_[A-Za-z]{40,}$/);
    expect(secret).not.toBe(old.key);
    expect(apiKey).toMatchObject({ name: "Shortcuts", status: "active", lastUsedAt: null });
    expect(apiKey.id).not.toBe(old.id);

    expect(await verified(old.key)).toBe(false);
    expect(await verified(secret)).toBe(true);
    // Both stay listed, the new one first; the secret is not in the list.
    const raw = await (await call("/api/api-keys", { cookie: A.cookie })).text();
    expect(raw).not.toContain(secret);
    expect((JSON.parse(raw) as { apiKeys: Key[] }).apiKeys.map((k) => [k.id, k.status])).toEqual([[apiKey.id, "active"], [old.id, "revoked"]]);
  });

  test("a user at exactly 10 active keys can regenerate one, since the count stays at 10", async () => {
    const keys = await fillKeys(A, 10);
    expect((await as(A).regenerate(keys[3]!.id)).status).toBe(201);
    const listed = (await as(A).list()).apiKeys;
    expect(listed.filter((k) => k.status === "active")).toHaveLength(10);
    expect(listed).toHaveLength(11);
    expect((await as(A).create("Eleventh")).status).toBe(409);
  });

  test("a Revoked API key cannot be regenerated: the cap applies to creating a replacement", async () => {
    const { id } = await testApiKey(env, A.userId, "CI");
    await as(A).revoke(id);
    const res = await as(A).regenerate(id);
    expect(res.status).toBe(409);
    expect((await res.json()) as object).toEqual({ error: "That API key is revoked. Create a new one instead.", code: "api_key_revoked" });
    expect((await as(A).list()).apiKeys).toHaveLength(1);
  });

  test("another user cannot regenerate these keys; foreign IDs answer like missing ones", async () => {
    const { id, key } = await testApiKey(env, A.userId, "Mine");
    const foreign = await as(B).regenerate(id);
    const missing = await as(B).regenerate("does-not-exist");
    expect(foreign.status).toBe(404);
    expect([missing.status, await missing.json()]).toEqual([404, await foreign.json()]);
    expect((await as(B).list()).apiKeys).toEqual([]);
    expect((await as(A).list()).apiKeys.map((k) => k.status)).toEqual(["active"]);
    expect(await verified(key)).toBe(true);
  });

  test("if creating the new key fails, the old key stays active", async () => {
    const { id, key } = await testApiKey(env, A.userId, "Mine");
    db.sqlite.exec("CREATE TRIGGER no_new_keys BEFORE INSERT ON apikey BEGIN SELECT RAISE(ABORT, 'insert failed'); END");
    expect((await as(A).regenerate(id)).status).toBe(500);
    db.sqlite.exec("DROP TRIGGER no_new_keys");
    expect((await as(A).list()).apiKeys.map((k) => [k.id, k.status])).toEqual([[id, "active"]]);
    expect(await verified(key)).toBe(true);
  });

  test("if revoking the old key fails, no extra key is left active", async () => {
    const { id, key } = await testApiKey(env, A.userId, "Mine");
    db.sqlite.exec(`CREATE TRIGGER keep_old BEFORE UPDATE OF enabled ON apikey WHEN old.id = '${id}' BEGIN SELECT RAISE(ABORT, 'update failed'); END`);
    expect((await as(A).regenerate(id)).status).toBe(500);
    const listed = (await as(A).list()).apiKeys;
    expect(listed.find((k) => k.id === id)!.status).toBe("active");
    expect(listed.filter((k) => k.status === "active")).toHaveLength(1);
    expect(await verified(key)).toBe(true);
  });

  test("regenerating requires a session", async () => {
    const { id } = await testApiKey(env, A.userId, "Mine");
    expect((await call(`/api/api-keys/${id}/regenerate`, { body: {} })).status).toBe(401);
    expect((await as(A).list()).apiKeys.map((k) => k.status)).toEqual(["active"]);
  });
});
