// FAC-157: GET /api/usage/summary answers the signed-in user's current quota windows (links, jobs) and this
// calendar month's new Links split by API key and Web. Counts are read live from existing tables.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testApiKey, testSession } from "./support/auth.test-instance";
import { stayInsideWindow } from "./support/quota";

type Quota = { used: number; max: number; windowSeconds: number; resetsAt: string };
type Month = { start: string; links: number; web: number; apiKeys: { id: string; name: string; links: number }[] };
type Usage = { quotas: { links: Quota; jobs: Quota }; month: Month };
let db: TestD1, env: Env, call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };
let keyA: { id: string; key: string }, keyA2: { id: string; key: string };

beforeEach(async () => {
  // The hour and month a test reads must be the ones it wrote in.
  await stayInsideWindow(3600);
  await stayInsideWindow("month");
  db = await TestD1.migrated();
  ({ env } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
  keyA = await testApiKey(env, A.userId, "Shortcuts");
  keyA2 = await testApiKey(env, A.userId, "Zapier");
});

const usageOf = async (who: { cookie: string }) => {
  const res = await call("/api/usage/summary", { cookie: who.cookie });
  expect(res.status).toBe(200);
  return (await res.json()) as Usage;
};
const viaKey = (key: string, urls: string[]) => call("/api/v1/links", { body: { urls }, origin: null, headers: { authorization: `Bearer ${key}` } });
const viaWeb = (who: { cookie: string }, urls: string[]) => call("/api/import", { cookie: who.cookie, body: { urls } });
/** Moves everything one user saved so far to the previous month. */
const makeLastMonth = (userId: string) => {
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 12)).toISOString();
  db.sqlite.query("UPDATE links SET created_at=? WHERE user_id=?").run(last, userId);
  db.sqlite.query("UPDATE batches SET created_at=? WHERE user_id=?").run(last, userId);
  db.sqlite.query("UPDATE jobs SET created_at=? WHERE batch_id IN (SELECT id FROM batches WHERE user_id=?)").run(last, userId);
};

describe("quota windows", () => {
  test("a user with no activity has nothing used; maximums and reset times describe the current window", async () => {
    const before = Date.now();
    const { quotas } = await usageOf(A);
    expect(quotas.links).toMatchObject({ used: 0, max: 500, windowSeconds: 3600 });
    expect(quotas.jobs).toMatchObject({ used: 0, max: 300, windowSeconds: 3600 });
    const reset = Date.parse(quotas.links.resetsAt);
    expect(reset).toBeGreaterThan(before);
    expect(reset).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    expect(reset % (3600 * 1000)).toBe(0);
  });

  test("new Links count against both quotas; Duplicates do not", async () => {
    await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    await viaWeb(A, ["https://usage.example/c", "https://usage.example/a"]);
    const { quotas } = await usageOf(A);
    expect([quotas.links.used, quotas.jobs.used]).toEqual([3, 3]);
  });

  test("an elapsed window reads as unused", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    db.sqlite.query("UPDATE app_rate_limits SET window_start=window_start-3600 WHERE key LIKE '%:'||?").run(A.userId);
    const { quotas } = await usageOf(A);
    expect([quotas.links.used, quotas.jobs.used]).toEqual([0, 0]);
  });

  test("another user's usage is never included", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    const b = await usageOf(B);
    expect([b.quotas.links.used, b.quotas.jobs.used]).toEqual([0, 0]);
    expect(b.month).toMatchObject({ links: 0, web: 0, apiKeys: [] });
  });
});

describe("this month's new Links", () => {
  test("split between each API key and Web, Web being the total minus the keys", async () => {
    await viaKey(keyA.key, ["https://usage.example/k1", "https://usage.example/k2", "https://usage.example/k3"]);
    await viaKey(keyA2.key, ["https://usage.example/z1"]);
    await viaWeb(A, ["https://usage.example/w1", "https://usage.example/w2"]);
    const { month } = await usageOf(A);
    const now = new Date();
    expect(month).toMatchObject({ links: 6, web: 2, start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString() });
    expect(month.apiKeys).toEqual(expect.arrayContaining([{ id: keyA.id, name: "Shortcuts", links: 3 }, { id: keyA2.id, name: "Zapier", links: 1 }]));
    expect(month.apiKeys).toHaveLength(2);
  });

  test("Duplicates never count, whoever resubmits them", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    await viaKey(keyA2.key, ["https://usage.example/a"]);
    await viaWeb(A, ["https://usage.example/a"]);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 1, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1 }]);
  });

  test("Links saved in a previous month are excluded", async () => {
    await viaKey(keyA.key, ["https://usage.example/old1"]);
    await viaWeb(A, ["https://usage.example/old2"]);
    makeLastMonth(A.userId);
    await viaKey(keyA.key, ["https://usage.example/new1"]);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 1, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1 }]);
  });

  test("a Revoked API key keeps its count; a key that submitted nothing is absent", async () => {
    await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    expect((await call(`/api/api-keys/${keyA.id}/revoke`, { cookie: A.cookie, body: {} })).status).toBe(200);
    expect((await viaKey(keyA.key, ["https://usage.example/c"])).status).toBe(401);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 2, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 2 }]);
  });

  test("deleting a Link removes it from the count", async () => {
    const res = await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    const { results } = (await res.json()) as { results: { id: string }[] };
    db.sqlite.query("UPDATE jobs SET status='done' WHERE link_id=?").run(results[0]!.id);
    expect((await call(`/api/links/${results[0]!.id}`, { method: "DELETE", cookie: A.cookie, body: {} })).status).toBe(200);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 1, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1 }]);
  });

  test("another user's Links never reach the count, even with the same URLs", async () => {
    const keyB = await testApiKey(env, B.userId, "Other");
    await viaKey(keyB.key, ["https://usage.example/a", "https://usage.example/b"]);
    await viaWeb(B, ["https://usage.example/c"]);
    await viaKey(keyA.key, ["https://usage.example/a"]);
    const a = await usageOf(A);
    expect(a.month).toMatchObject({ links: 1, web: 0 });
    expect(a.month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1 }]);
    const b = await usageOf(B);
    expect(b.month).toMatchObject({ links: 3, web: 1 });
    expect(b.month.apiKeys).toEqual([{ id: keyB.id, name: "Other", links: 2 }]);
  });
});

test("usage needs a session", async () => {
  expect((await call("/api/usage/summary")).status).toBe(401);
  expect((await call("/api/usage/summary", { headers: { authorization: `Bearer ${keyA.key}` } })).status).toBe(401);
});
