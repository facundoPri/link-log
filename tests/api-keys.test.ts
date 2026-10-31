// FAC-154: API keys are created, listed and revoked from Settings through the session API. The
// secret is shown once; a Revoked API key stays listed; another user's keys answer like missing ones.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { createTestAuth, testApiKey, testSession } from "./support/auth.test-instance";

type Key = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null; status: "active" | "revoked" };
let env: Env, call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };

beforeEach(async () => {
  ({ env } = makeEnv(await TestD1.migrated()));
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
});

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
