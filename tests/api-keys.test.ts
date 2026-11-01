// FAC-154: API keys are created, listed, enabled, revoked and deleted from Settings through the API
// key plugin's own session routes (/api/auth/api-key/*), as shipped. The secret is shown once; another
// user's keys answer like missing ones; a client cannot set the plugin's server-only fields.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { createTestAuth, testSession } from "./support/auth.test-instance";
import { keyRoutes, type PluginKey } from "./support/api-key-routes";

let db: TestD1, env: Env, call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };

beforeEach(async () => {
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

  test("a key made with a client-chosen prefix works like any other", async () => {
    const res = await as(A).create({ name: "Prefixed", prefix: "abc" });
    expect(res.status).toBe(200);
    const { key } = (await res.json()) as { key: string };
    expect(key.startsWith("abc")).toBe(true);
    expect(await verified(key)).toBe(true);
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
