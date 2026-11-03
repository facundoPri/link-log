// FAC-41: two users with the same URL/tag/lens never see or touch each other's data, through
// every API route, R2 content, batches/jobs, usage, background job loading and DB triggers.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv, signUpVerified, type FakeR2 } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { loadOwnedJob } from "../worker/workflow";
import { recover } from "../worker/jobs";
import { measured } from "../worker/usage";
import type { Library } from "../src/types";

type Lib = Library & { id?: string; duplicate?: boolean; batchId?: string };
let db: TestD1, env: Env, r2: FakeR2, queued: { id: string }[], call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };

const json = async (r: Response) => (await r.json()) as Lib;
const as = (who: { cookie: string }) => ({
  get: (path: string) => call(path, { cookie: who.cookie }),
  send: (path: string, body: unknown = {}, method = "POST") => call(path, { cookie: who.cookie, body, method }),
});

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, r2, queued } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
});

async function seed(who: typeof A) {
  const api = as(who);
  const link = await json(await api.send("/api/links", { url: "https://example.com/same?utm_source=x", tags: ["shared"] }));
  await api.send("/api/lenses", { name: "Same lens", type: "noul", question: "Worth it?" });
  const lib = await json(await api.get("/api/library"));
  return { linkId: link.id!, tagId: lib.tags[0]!.id, lensId: lib.lenses[0]!.id, batchId: lib.batches[0]!.id };
}

describe("same URL, tag and lens for two owners", () => {
  test("each owner gets separate rows; dedupe and name uniqueness are per owner", async () => {
    const a = await seed(A);
    const b = await seed(B);
    expect(a.linkId).not.toBe(b.linkId);
    expect(a.tagId).not.toBe(b.tagId);
    expect(a.lensId).not.toBe(b.lensId);

    const libA = await json(await as(A).get("/api/library"));
    const libB = await json(await as(B).get("/api/library"));
    expect(libA.links.map((l) => l.id)).toEqual([a.linkId]);
    expect(libB.links.map((l) => l.id)).toEqual([b.linkId]);
    expect(libA.links[0]!.tags.map((t) => t.id)).toEqual([a.tagId]);
    expect(libA.batches.map((x) => x.id)).toEqual([a.batchId]);
    expect(JSON.stringify(libA)).not.toContain(b.linkId);
    expect(JSON.stringify(libA)).not.toContain(B.userId);

    // Same owner: duplicate URL returns the existing link; duplicate lens name conflicts.
    const dup = await json(await as(A).send("/api/links", { url: "https://example.com/same" }));
    expect(dup.duplicate).toBe(true);
    expect(dup.id).toBe(a.linkId);
    expect((await as(A).send("/api/lenses", { name: "same LENS", type: "noul", question: "?" })).status).toBe(409);
    const imported = await json(await as(A).send("/api/import", { urls: ["https://example.com/same", "https://example.com/new"] }));
    expect([imported.links.length, (imported as Lib & { duplicates: number }).duplicates]).toEqual([2, 1]);
    expect((await json(await as(B).get("/api/library"))).links.length).toBe(1);
  });

  test("the owner always comes from the session, never from the body", async () => {
    const created = await json(await as(B).send("/api/links", { url: "https://example.com/inject", user_id: A.userId, userId: A.userId }));
    const row = db.sqlite.query("SELECT user_id FROM links WHERE id=?").get(created.id!) as { user_id: string };
    expect(row.user_id).toBe(B.userId);
    expect((await json(await as(A).get("/api/library"))).links.length).toBe(0);
  });
});

describe("foreign IDs are indistinguishable from missing ones", () => {
  test("reads and mutations on A's link, tag, lens and batch fail for B and leave A intact", async () => {
    const a = await seed(A);
    await seed(B);
    // Let A's extract job finish so mutations are not blocked by "job running".
    db.sqlite.exec("UPDATE jobs SET status='done'");
    const b = as(B);
    const attempts: [string, Promise<Response>][] = [
      ["PATCH link", b.send(`/api/links/${a.linkId}`, { tags: ["stolen"] }, "PATCH")],
      ["DELETE link", b.send(`/api/links/${a.linkId}`, {}, "DELETE")],
      ["retry link", b.send(`/api/links/${a.linkId}/retry`)],
      ["GET content", b.get(`/api/links/${a.linkId}/content`)],
      ["PUT content", b.send(`/api/links/${a.linkId}/content`, { markdown: "overwrite" }, "PUT")],
      ["related links", b.send(`/api/links/${a.linkId}/related-links`, { url: "https://x.example", hidden: true }, "PUT")],
      ["transcript", b.send(`/api/links/${a.linkId}/transcript`, { language: "en" })],
      ["DELETE lens result", b.send(`/api/links/${a.linkId}/lenses/${a.lensId}`, {}, "DELETE")],
      ["PATCH tag", b.send(`/api/tags/${a.tagId}`, { name: "renamed" }, "PATCH")],
      ["DELETE tag", b.send(`/api/tags/${a.tagId}`, {}, "DELETE")],
      ["PATCH lens", b.send(`/api/lenses/${a.lensId}`, { name: "x", type: "noul", question: "?" }, "PATCH")],
      ["DELETE lens", b.send(`/api/lenses/${a.lensId}`, {}, "DELETE")],
      ["GET batch", b.get(`/api/batches/${a.batchId}`)],
      ["DELETE batch", b.send(`/api/batches/${a.batchId}`, {}, "DELETE")],
    ];
    for (const [name, pending] of attempts) {
      const response = await pending;
      expect([name, response.status]).toEqual([name, 404]);
    }
    // Batches over foreign links or with a foreign lens are rejected before anything is queued.
    const queuedBefore = queued.length;
    expect((await b.send("/api/batches", { ids: [a.linkId], kind: "extract" })).status).toBe(400);
    const ownB = (await json(await b.get("/api/library"))).links[0]!.id;
    db.sqlite.exec("UPDATE links SET content_key='x' WHERE id='" + ownB + "'");
    expect((await b.send("/api/batches", { ids: [ownB], kind: "lens", lensId: a.lensId })).status).toBe(400);
    expect((await b.send("/api/batches", { ids: [ownB, a.linkId], kind: "extract" })).status).toBe(400);
    expect(queued.length).toBe(queuedBefore);

    const libA = await json(await as(A).get("/api/library"));
    expect(libA.links[0]!.id).toBe(a.linkId);
    expect(libA.links[0]!.tags.map((t) => t.name)).toEqual(["shared"]);
    expect(libA.tags.map((t) => t.name)).toEqual(["shared"]);
    expect(libA.lenses.map((l) => l.name)).toEqual(["Same lens"]);
    expect(libA.links[0]!.hidden_related_urls).toEqual([]);
  });

  test("R2 content is written under the owner's prefix and only read through an owned row", async () => {
    const a = await seed(A);
    db.sqlite.exec("UPDATE jobs SET status='done'");
    expect((await as(A).send(`/api/links/${a.linkId}/content`, { markdown: "# A's notes" }, "PUT")).status).toBe(200);
    const key = (db.sqlite.query("SELECT content_key k FROM links WHERE id=?").get(a.linkId) as { k: string }).k;
    expect(key.startsWith(`users/${A.userId}/links/${a.linkId}/`)).toBe(true);
    expect((await (await as(A).get(`/api/links/${a.linkId}/content`)).json()) as object).toEqual({ markdown: "# A's notes" });
    expect((await as(B).get(`/api/links/${a.linkId}/content`)).status).toBe(404);

    // Even if a row pointed at another owner's object, it would not be served.
    const b = await seed(B);
    db.sqlite.query("UPDATE links SET content_key=? WHERE id=?").run(key, b.linkId);
    expect((await (await as(B).get(`/api/links/${b.linkId}/content`)).json()) as object).toEqual({ markdown: "" });

    // Deleting the link removes its objects (owner prefix and legacy prefix).
    r2.objects.set(`links/${a.linkId}/legacy.md`, "old");
    expect((await as(A).send(`/api/links/${a.linkId}`, {}, "DELETE")).status).toBe(200);
    expect([...r2.objects.keys()].filter((k) => k.includes(a.linkId))).toEqual([]);
  });
});

describe("background processing resolves the persisted owner", () => {
  test("jobs load only with their batch owner's link; unowned or mixed jobs never run", async () => {
    const a = await seed(A);
    const job = db.sqlite.query("SELECT id FROM jobs WHERE batch_id=?").get(a.batchId) as { id: string };
    expect(queued.map((m) => m.id)).toContain(job.id);
    const loaded = await loadOwnedJob(env.DB, job.id);
    expect(loaded.job.user_id).toBe(A.userId);
    expect(loaded.link!.id).toBe(a.linkId);

    const b = await seed(B);
    // A job row pointing at B's link from A's batch cannot even be inserted.
    expect(() => db.sqlite.query("INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES('x',?,?,'now')").run(a.batchId, b.linkId)).toThrow(/cross-owner/);
    // A legacy batch without owner is never processed (and recovery skips it).
    db.sqlite.exec("DROP TRIGGER batches_owner_required");
    db.sqlite.query("INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('legacy',NULL,'extract','{}','now')").run();
    db.sqlite.exec("DROP TRIGGER jobs_same_owner; UPDATE jobs SET status='done'");
    db.sqlite.query("INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES('legacy-job','legacy',?,'now')").run(a.linkId);
    await expect(loadOwnedJob(env.DB, "legacy-job")).rejects.toThrow("no owner");
    queued.length = 0;
    await recover(env);
    expect(queued.map((m) => m.id)).not.toContain("legacy-job");
  });

  test("derived rows cannot join two owners and usage is attributed from the batch", async () => {
    const a = await seed(A);
    const b = await seed(B);
    for (const [sql, params] of [
      ["INSERT INTO link_tags(link_id,tag_id) VALUES(?,?)", [a.linkId, b.tagId]],
      ["INSERT INTO tag_evaluations(link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id) VALUES(?,?,1,0.8,1,'',1,'m','now',?)", [a.linkId, a.tagId, b.batchId]],
      ["INSERT INTO lens_results(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id) VALUES(?,?,'{}',1,1,'m','now',?)", [a.linkId, b.lensId, a.batchId]],
      ["UPDATE links SET user_id=? WHERE id=?", [B.userId, a.linkId]],
    ] as const)
      expect(() => db.sqlite.query(sql).run(...(params as unknown as string[]))).toThrow(/cross-owner|immutable/);

    const job = db.sqlite.query("SELECT id,batch_id,link_id FROM jobs WHERE batch_id=?").get(a.batchId) as { id: string; batch_id: string; link_id: string };
    await measured(env, job, "jev", "typesafe", "classify", async (meter) => {
      meter.input_tokens = 1000;
    });
    const usageA = (await (await as(A).get("/api/usage")).json()) as { events: { link_id: string }[]; totals: { calls: number } };
    const usageB = (await (await as(B).get("/api/usage")).json()) as { events: unknown[]; totals: { calls: number } };
    expect(usageA.events.map((e) => e.link_id)).toEqual([a.linkId]);
    expect(usageA.totals.calls).toBe(1);
    expect(usageB.events).toEqual([]);
    expect(usageB.totals.calls).toBe(0);
    expect((await json(await as(A).get("/api/library"))).batches[0]!.usage?.input_tokens).toBe(1000);
    expect((await json(await as(B).get("/api/library"))).batches.every((x) => x.usage === null)).toBe(true);
  });
});

describe("per-user quotas", () => {
  test("concurrent writes share one atomic counter per user", async () => {
    const { consume } = await import("../worker/limits");
    const results = await Promise.all(Array.from({ length: 30 }, () => consume(env.DB, "probe", { window: 60, max: 10 })));
    expect(results.filter(Boolean).length).toBe(10);
    // Another key (user) is unaffected; a new window resets.
    expect(await consume(env.DB, "other", { window: 60, max: 10 })).toBe(true);
    expect(await consume(env.DB, "probe", { window: 60, max: 10 }, 1, Date.now() + 61000)).toBe(true);
  });

  test("the write limit answers 429 for one user only", async () => {
    db.sqlite.query("INSERT INTO app_rate_limits(key,window_start,count) VALUES(?,?,120)").run(`writes:${A.userId}`, Math.floor(Date.now() / 60000) * 60);
    expect((await as(A).send("/api/tags", { name: "x" })).status).toBe(429);
    expect((await as(B).send("/api/tags", { name: "x" })).status).toBe(200);
  });
});

describe("an exhausted quota leaves nothing half-saved (R8)", () => {
  const hour = () => Math.floor(Date.now() / 1000 / 3600) * 3600;
  const setUsed = (key: string, count: number) =>
    db.sqlite.query("INSERT OR REPLACE INTO app_rate_limits(key,window_start,count) VALUES(?,?,?)").run(key, hour(), count);
  const used = (key: string) => (db.sqlite.query("SELECT count FROM app_rate_limits WHERE key=?").get(key) as { count: number } | null)?.count ?? 0;
  const rows = () =>
    db.sqlite.query("SELECT (SELECT count(*) FROM links) links,(SELECT count(*) FROM tags) tags,(SELECT count(*) FROM jobs) jobs,(SELECT count(*) FROM batches) batches").get();

  test("add link: 429 saves no link or tag; the retry after the quota resets extracts exactly once", async () => {
    setUsed(`links:${A.userId}`, 500);
    const rejected = await as(A).send("/api/links", { url: "https://quota.example/a", tags: ["later"] });
    expect(rejected.status).toBe(429);
    expect(rows()).toEqual({ links: 0, tags: 0, jobs: 0, batches: 0 });
    expect(queued).toHaveLength(0);
    // Quota available again (next window).
    db.sqlite.exec("DELETE FROM app_rate_limits");
    const retry = await as(A).send("/api/links", { url: "https://quota.example/a", tags: ["later"] });
    expect(retry.status).toBe(201);
    expect(rows()).toEqual({ links: 1, tags: 1, jobs: 1, batches: 1 });
    expect(queued).toHaveLength(1);
    // Saving it again is a duplicate: no new job, no new charge.
    const again = await as(A).send("/api/links", { url: "https://quota.example/a", tags: ["later"] });
    expect(again.status).toBe(200);
    expect(rows()).toEqual({ links: 1, tags: 1, jobs: 1, batches: 1 });
    expect(used(`links:${A.userId}`)).toBe(1);
  });

  test("import and Browser save are all-or-nothing under the quota and only charge new links", async () => {
    setUsed(`links:${A.userId}`, 500);
    expect((await as(A).send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] })).status).toBe(429);
    expect((await as(A).send("/api/browser/save", { urls: ["https://quota.example/3"] })).status).toBe(429);
    expect(rows()).toEqual({ links: 0, tags: 0, jobs: 0, batches: 0 });
    // A batch that does not fit in what is left saves nothing and takes nothing.
    db.sqlite.exec("DELETE FROM app_rate_limits");
    setUsed(`links:${A.userId}`, 499);
    expect((await as(A).send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] })).status).toBe(429);
    expect(rows()).toEqual({ links: 0, tags: 0, jobs: 0, batches: 0 });
    expect(used(`links:${A.userId}`)).toBe(499);
    // One new + one known URL: only the new one is charged.
    db.sqlite.exec("DELETE FROM app_rate_limits");
    await as(A).send("/api/links", { url: "https://quota.example/1" });
    const imported = (await (await as(A).send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] })).json()) as { imported: number; duplicates: number };
    expect([imported.imported, imported.duplicates]).toEqual([1, 1]);
    expect(used(`links:${A.userId}`)).toBe(2);
    // B's quota is untouched.
    expect(used(`links:${B.userId}`)).toBe(0);
  });

  test("concurrent saves of the same new URL create one link and one job, and refund the loser", async () => {
    const results = await Promise.all([1, 2, 3].map(() => as(A).send("/api/links", { url: "https://quota.example/race" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(rows()).toMatchObject({ links: 1, jobs: 1 });
    expect(used(`links:${A.userId}`)).toBe(1);
  });
});

test("a real password login and a Test Utils session see the same isolation", async () => {
  const { env: env2, outbox } = makeEnv(await TestD1.migrated());
  const call2 = client(env2);
  const real = await signUpVerified(call2, outbox, "real@example.test");
  const fake = await testSession(env2, "fixture@example.test");
  await call2("/api/links", { cookie: real, body: { url: "https://example.com/r" } });
  const lib = (await (await call2("/api/library", { cookie: fake.cookie })).json()) as Library;
  expect(lib.links).toEqual([]);
});
