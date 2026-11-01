// FAC-157: GET /api/usage/summary answers the signed-in user's current links window and this
// calendar month's new Links split by API key and Web. Counts are read live from existing tables.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testApiKey, testSession } from "./support/auth.test-instance";
import { stayInsideWindow } from "./support/quota";
import { keyRoutes } from "./support/api-key-routes";

type Quota = { used: number; max: number; windowSeconds: number; resetsAt: string };
type Month = { start: string; links: number; web: number; apiKeys: { id: string; name: string; links: number; status: "active" | "revoked" | "deleted" }[] };
type Usage = { quotas: { links: Quota }; month: Month };
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
    const reset = Date.parse(quotas.links.resetsAt);
    expect(reset).toBeGreaterThan(before);
    expect(reset).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
    expect(reset % (3600 * 1000)).toBe(0);
  });

  test("new Links count against the links quota; Duplicates do not", async () => {
    await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    await viaWeb(A, ["https://usage.example/c", "https://usage.example/a"]);
    const { quotas } = await usageOf(A);
    expect(quotas.links.used).toBe(3);
  });

  test("an elapsed window reads as unused", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    db.sqlite.query("UPDATE app_rate_limits SET window_start=window_start-3600 WHERE key LIKE '%:'||?").run(A.userId);
    const { quotas } = await usageOf(A);
    expect(quotas.links.used).toBe(0);
  });

  test("another user's usage is never included", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    const b = await usageOf(B);
    expect(b.quotas.links.used).toBe(0);
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
    expect(month.apiKeys).toEqual(expect.arrayContaining([{ id: keyA.id, name: "Shortcuts", links: 3, status: "active" }, { id: keyA2.id, name: "Zapier", links: 1, status: "active" }]));
    expect(month.apiKeys).toHaveLength(2);
  });

  test("Duplicates never count, whoever resubmits them", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    await viaKey(keyA2.key, ["https://usage.example/a"]);
    await viaWeb(A, ["https://usage.example/a"]);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 1, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1, status: "active" }]);
  });

  test("Links saved in a previous month are excluded", async () => {
    await viaKey(keyA.key, ["https://usage.example/old1"]);
    await viaWeb(A, ["https://usage.example/old2"]);
    makeLastMonth(A.userId);
    await viaKey(keyA.key, ["https://usage.example/new1"]);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 1, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1, status: "active" }]);
  });

  test("a Revoked API key keeps its count; a key that submitted nothing is absent", async () => {
    await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    expect((await keyRoutes(call, A).revoke(keyA.id)).status).toBe(200);
    expect((await viaKey(keyA.key, ["https://usage.example/c"])).status).toBe(401);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 2, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 2, status: "revoked" }]);

    expect((await keyRoutes(call, A).enable(keyA.id)).status).toBe(200);
    expect((await usageOf(A)).month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 2, status: "active" }]);
  });

  test("a deleted API key still shows under the name stored with its Links, marked deleted, and Web does not absorb its count", async () => {
    await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    await viaKey(keyA2.key, ["https://usage.example/z1"]);
    await viaWeb(A, ["https://usage.example/w1"]);
    expect((await keyRoutes(call, A).update({ keyId: keyA.id, name: "Renamed" })).status).toBe(200);
    expect((await keyRoutes(call, A).remove(keyA.id)).status).toBe(200);
    expect((await keyRoutes(call, A).keys()).map((k) => k.id)).toEqual([keyA2.id]);

    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 4, web: 1 });
    expect(month.apiKeys).toEqual([
      { id: keyA.id, name: "Shortcuts", links: 2, status: "deleted" },
      { id: keyA2.id, name: "Zapier", links: 1, status: "active" },
    ]);
  });

  test("a key that was renamed shows its current name; a deleted key shows the name of its newest batch", async () => {
    await viaKey(keyA.key, ["https://usage.example/a"]);
    expect((await keyRoutes(call, A).update({ keyId: keyA.id, name: "Alpha" })).status).toBe(200);
    await viaKey(keyA.key, ["https://usage.example/b"]);
    expect((await usageOf(A)).month.apiKeys).toEqual([{ id: keyA.id, name: "Alpha", links: 2, status: "active" }]);

    // A later rename shows at once, before the key submits again.
    expect((await keyRoutes(call, A).update({ keyId: keyA.id, name: "Aardvark" })).status).toBe(200);
    expect((await usageOf(A)).month.apiKeys.map((k) => k.name)).toEqual(["Aardvark"]);

    expect((await keyRoutes(call, A).remove(keyA.id)).status).toBe(200);
    expect((await usageOf(A)).month.apiKeys).toEqual([{ id: keyA.id, name: "Alpha", links: 2, status: "deleted" }]);
  });

  test("a Link counts once, under what created it: an orphan Duplicate a key queues later stays Web's", async () => {
    const { id } = (await (await call("/api/links", { cookie: A.cookie, body: { url: "https://usage.example/a" } })).json()) as { id: string };
    // Setup: the Link was left without any job and content, as an interrupted save did.
    db.sqlite.query("DELETE FROM jobs WHERE link_id=?").run(id);
    db.sqlite.query("DELETE FROM batches WHERE user_id=? AND id NOT IN (SELECT batch_id FROM jobs)").run(A.userId);
    const res = await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    const { results, batchId } = (await res.json()) as { results: { id: string; status: string }[]; batchId: string };
    expect(results.map((r) => r.status)).toEqual(["duplicate", "created"]);
    expect(results[0]!.id).toBe(id);
    expect(batchId).toBeTruthy();

    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 2, web: 1 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1, status: "active" }]);
  });

  test("deleting a Link removes it from the count", async () => {
    const res = await viaKey(keyA.key, ["https://usage.example/a", "https://usage.example/b"]);
    const { results } = (await res.json()) as { results: { id: string }[] };
    db.sqlite.query("UPDATE jobs SET status='done' WHERE link_id=?").run(results[0]!.id);
    expect((await call(`/api/links/${results[0]!.id}`, { method: "DELETE", cookie: A.cookie, body: {} })).status).toBe(200);
    const { month } = await usageOf(A);
    expect(month).toMatchObject({ links: 1, web: 0 });
    expect(month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1, status: "active" }]);
  });

  test("another user's Links never reach the count, even with the same URLs", async () => {
    const keyB = await testApiKey(env, B.userId, "Other");
    await viaKey(keyB.key, ["https://usage.example/a", "https://usage.example/b"]);
    await viaWeb(B, ["https://usage.example/c"]);
    await viaKey(keyA.key, ["https://usage.example/a"]);
    const a = await usageOf(A);
    expect(a.month).toMatchObject({ links: 1, web: 0 });
    expect(a.month.apiKeys).toEqual([{ id: keyA.id, name: "Shortcuts", links: 1, status: "active" }]);
    const b = await usageOf(B);
    expect(b.month).toMatchObject({ links: 3, web: 1 });
    expect(b.month.apiKeys).toEqual([{ id: keyB.id, name: "Other", links: 2, status: "active" }]);
  });
});

type FeatureRow = { key: string; label: string; runs: number; inputTokens: number; outputTokens: number; browserMs: number; usd: number; unknownCostCalls: number };
type FeatureMonth = { features: FeatureRow[]; total: { usd: number; unknownCostCalls: number } };
const featuresOf = async (who: { cookie: string }) => (await usageOf(who)).month as unknown as Month & FeatureMonth;
const feature = (m: FeatureMonth, key: string) => m.features.find((f) => f.key === key)!;

// Setup helpers for work that costs money. The summary is what is asserted, through the HTTP handler.
let seeded = 0;
/** A batch of `kind` with one job on a new Link of `userId`. */
function seedRun(userId: string, kind: string, { at = new Date().toISOString(), status = "done", step = "Done" } = {}) {
  const n = ++seeded, ids = { linkId: `seed-l${n}`, batchId: `seed-b${n}`, jobId: `seed-j${n}`, userId };
  db.sqlite.query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES(?,?,?,?,'seed.example','t',?)").run(ids.linkId, userId, `https://seed.example/${n}`, `https://seed.example/${n}`, at);
  db.sqlite.query("INSERT INTO batches(id,user_id,kind,config,created_at) VALUES(?,?,?,'{}',?)").run(ids.batchId, userId, kind, at);
  db.sqlite.query("INSERT INTO jobs(id,batch_id,link_id,status,step,created_at) VALUES(?,?,?,?,?,?)").run(ids.jobId, ids.batchId, ids.linkId, status, step, at);
  return ids;
}
/** A finished (or `status`) call of `service` made for a seeded run. */
function seedCall(run: ReturnType<typeof seedRun>, service: string, { provider = "typesafe", status = "done", input = null, output = null, browserMs = null, usd = null, at = new Date().toISOString() }: { provider?: string; status?: string; input?: number | null; output?: number | null; browserMs?: number | null; usd?: number | null; at?: string } = {}) {
  db.sqlite
    .query("INSERT INTO usage_events(id,user_id,batch_id,job_id,link_id,provider,service,operation,status,input_tokens,output_tokens,browser_ms,estimated_usd,created_at) VALUES(?,?,?,?,?,?,?,'op',?,?,?,?,?,?)")
    .run(crypto.randomUUID(), run.userId, run.batchId, run.jobId, run.linkId, provider, service, status, input, output, browserMs, usd, at);
}

describe("this month's usage by feature", () => {
  test("a user with no activity has every feature at zero, in a fixed order", async () => {
    const m = await featuresOf(A);
    expect(m.features.map((f) => f.key)).toEqual(["extract", "content", "lens", "autotag", "ocr", "autogroup"]);
    expect(m.features.every((f) => f.label && f.runs === 0 && f.inputTokens === 0 && f.outputTokens === 0 && f.browserMs === 0 && f.usd === 0 && f.unknownCostCalls === 0)).toBe(true);
    expect(m.total).toEqual({ usd: 0, unknownCostCalls: 0 });
  });

  test("runs are counted per feature from the jobs that ran: queued and cancelled ones are not runs, retries are", async () => {
    for (const kind of ["extract", "extract", "preview"]) seedRun(A.userId, kind);
    seedRun(A.userId, "extract", { status: "failed", step: "Failed" }); // a failed run is still a run
    seedRun(A.userId, "extract", { status: "queued", step: "Queued" });
    seedRun(A.userId, "extract", { status: "failed", step: "Cancelled" });
    seedRun(A.userId, "lens"); seedRun(A.userId, "browser-lens");
    for (let i = 0; i < 3; i++) seedRun(A.userId, "autotag");
    seedRun(A.userId, "browser-autogroup");
    const m = await featuresOf(A);
    expect(Object.fromEntries(m.features.map((f) => [f.key, f.runs]))).toEqual({ extract: 4, content: 0, lens: 2, autotag: 3, ocr: 0, autogroup: 1 });
  });

  test("tokens, browser time and cost are summed per feature; a call with no price is counted as unknown, never as free", async () => {
    const extract = seedRun(A.userId, "extract");
    seedCall(extract, "browser-markdown", { provider: "cloudflare", browserMs: 12000, usd: 0.0003 });
    seedCall(extract, "browser-content", { provider: "cloudflare", browserMs: 3000, usd: 0.000075 });
    seedCall(extract, "browser-markdown", { provider: "cloudflare", status: "failed" }); // no browser time reported: unknown cost
    seedCall(extract, "image-ocr", { provider: "cloudflare", input: 1200, output: 200, usd: 0.00018 });
    seedCall(extract, "image-fetch", { provider: "public-cdn" }); // a free fetch: part of no feature
    const lens = seedRun(A.userId, "lens");
    seedCall(lens, "jev", { input: 1_000_000, output: 40, usd: 0.042 });
    const tag = seedRun(A.userId, "autotag");
    seedCall(tag, "jev", { provider: "fixture", input: 500, output: 8 });
    seedCall(tag, "jev", { input: 100, output: 8, status: "started" }); // not finished: not counted yet

    const m = await featuresOf(A);
    expect(feature(m, "content")).toMatchObject({ runs: 3, browserMs: 15000, inputTokens: 0, unknownCostCalls: 1 });
    expect(feature(m, "content").usd).toBeCloseTo(0.000375, 12);
    expect(feature(m, "ocr")).toMatchObject({ runs: 1, inputTokens: 1200, outputTokens: 200, usd: 0.00018, unknownCostCalls: 0 });
    expect(feature(m, "lens")).toMatchObject({ runs: 1, inputTokens: 1_000_000, outputTokens: 40, usd: 0.042, unknownCostCalls: 0 });
    expect(feature(m, "autotag")).toMatchObject({ runs: 1, inputTokens: 500, outputTokens: 8, usd: 0, unknownCostCalls: 1 });
    expect(feature(m, "extract")).toMatchObject({ runs: 1, usd: 0, unknownCostCalls: 0 });
    expect(m.total.usd).toBeCloseTo(0.000375 + 0.00018 + 0.042, 9);
    expect(m.total.unknownCostCalls).toBe(2);
  });

  test("a call of a service no feature knows is shown as Other, so the total never hides spend", async () => {
    seedCall(seedRun(A.userId, "extract"), "video-asr", { provider: "cloudflare", input: 10, usd: 0.5 });
    const m = await featuresOf(A);
    expect(m.features.at(-1)).toMatchObject({ key: "other", label: "Other", runs: 1, inputTokens: 10, usd: 0.5 });
    expect(m.total.usd).toBe(0.5);
  });

  test("a previous month and another user's work are excluded", async () => {
    const old = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 0, 12)).toISOString();
    const last = seedRun(A.userId, "lens", { at: old });
    seedCall(last, "jev", { input: 7, usd: 1, at: old });
    const theirs = seedRun(B.userId, "lens");
    seedCall(theirs, "jev", { input: 9, usd: 2 });
    const a = await featuresOf(A);
    expect(feature(a, "lens")).toMatchObject({ runs: 0, inputTokens: 0, usd: 0 });
    expect(a.total.usd).toBe(0);
    expect(feature(await featuresOf(B), "lens")).toMatchObject({ runs: 1, inputTokens: 9, usd: 2 });
  });
});

test("usage needs a session", async () => {
  expect((await call("/api/usage/summary")).status).toBe(401);
  expect((await call("/api/usage/summary", { headers: { authorization: `Bearer ${keyA.key}` } })).status).toBe(401);
});
