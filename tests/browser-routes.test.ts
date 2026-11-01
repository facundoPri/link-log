// Browser view API through the real Worker (Hono + Better Auth session + owner-scoped D1):
// contracts from @linklog/browser-protocol, plus FAC-41 isolation between two accounts.
import { beforeEach, describe, expect, test } from "bun:test";
import { lensFingerprint, type BrowserCatalog } from "@linklog/browser-protocol";
import { TestD1 } from "./support/d1";
import { client, makeEnv, type FakeR2 } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { loadOwnedJob } from "../worker/workflow";

type User = { userId: string; cookie: string };
let db: TestD1, env: Env, r2: FakeR2, queued: { id: string }[], call: ReturnType<typeof client>;
let A: User, B: User;

const CAPTURED_AT = new Date().toISOString();
const fp = lensFingerprint({ type: "noul", question: "Relevant?", options: [], levels: [], criteria: { yes: "", no: "" } } as never);
const as = (who: User) => {
  const send = async (path: string, method: string, body?: unknown) => {
    const r = await call(`/api${path}`, { cookie: who.cookie, method, body: method === "GET" ? undefined : (body ?? {}) });
    return { status: r.status, retryAfter: r.headers.get("retry-after"), data: (await r.json()) as any };
  };
  return {
    send,
    catalog: async () => (await send("/browser/catalog", "GET")).data as BrowserCatalog,
    evaluation: async (requestId: string, keys: string[], lensId = "lens", libraryId?: string, capturedAt = CAPTURED_AT) =>
      send("/browser/evaluations", "POST", {
        requestId,
        libraryId: libraryId ?? (await send("/browser/catalog", "GET")).data.libraryId,
        sessionId: "s",
        kind: "lens",
        lens: { id: lensId, fingerprint: fp },
        targets: keys.map((k) => ({
          targetKey: k,
          url: `https://x.dev/${k}`,
          title: k,
          capture: { source: "dom", capturedAt, completeness: "complete", reasons: [], facts: [], markdown: `page ${k}` },
        })),
      }),
  };
};
function lens(owner: User, id: string, scope: "browser" | "library" = "browser") {
  db.sqlite
    .query("INSERT INTO lenses(id,user_id,name,type,question,options,created_at,scope) VALUES(?,?,?,'noul','Relevant?','{}','t',?)")
    .run(id, owner.userId, id, scope);
}

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, r2, queued } = makeEnv(db, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" }));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
  lens(A, "lens");
  lens(A, "lib", "library");
});

describe("Browser contracts", () => {
  test("DELETE cancels only the targets it names (Clean of some tabs)", async () => {
    await as(A).evaluation("req", ["a", "b", "c"]);
    const res = await as(A).send("/browser/evaluations/req", "DELETE", { targetKeys: ["b"] });
    expect(res.data.cancelled).toBe(1);
    const rows = db.sqlite.query("SELECT bt.target_key k, j.status s FROM jobs j JOIN browser_targets bt ON bt.id=j.target_id ORDER BY k").all();
    expect(rows).toEqual([{ k: "a", s: "queued" }, { k: "b", s: "failed" }, { k: "c", s: "queued" }]);
  });

  test("library lenses can't evaluate open tabs", async () => {
    const res = await as(A).evaluation("req", ["a"], "lib");
    expect(res).toMatchObject({ status: 400, data: { code: "lens-scope" } });
    expect(db.sqlite.query("SELECT count(*) n FROM jobs").get()).toEqual({ n: 0 });
  });

  test("ack confirms and purges only answered targets", async () => {
    await as(A).evaluation("req", ["a", "b"]);
    db.sqlite.exec(`UPDATE browser_targets SET answer='{"type":"noul","noul":1}' WHERE target_key='a'`);
    const keys = db.sqlite.query("SELECT target_key k, capture_key c FROM browser_targets ORDER BY k").all() as { k: string; c: string }[];
    expect(keys.every((k) => k.c.startsWith(`users/${A.userId}/browser/req/`))).toBe(true);
    const res = await as(A).send("/browser/evaluations/req/ack", "POST", { targetKeys: ["a", "b"] });
    expect(res.data.acked).toBe(1);
    expect(r2.objects.has(keys[0]!.c)).toBe(false);
    expect(r2.objects.has(keys[1]!.c)).toBe(true); // b's snapshot stays: its job may still need it
    const rows = db.sqlite.query("SELECT target_key k, acked_at IS NOT NULL acked, capture_key IS NOT NULL snap FROM browser_targets ORDER BY k").all();
    expect(rows).toEqual([{ k: "a", acked: 1, snap: 0 }, { k: "b", acked: 0, snap: 1 }]);
  });

  test("a snapshot that can't be stored fails its target visibly instead of orphaning the request", async () => {
    r2.put = async () => {
      throw new Error("R2 down");
    };
    const res = await as(A).evaluation("req", ["a"]);
    expect(res.status).toBe(201);
    expect(res.data.targets[0]).toMatchObject({ state: "failed", error: "The page snapshot could not be stored. Evaluate the tab again." });
    expect(queued).toHaveLength(0);
    expect(db.sqlite.query("SELECT count(*) n FROM usage_events").get()).toEqual({ n: 0 });
  });

  test("evaluation requests are idempotent by request id and never create links", async () => {
    const first = await as(A).evaluation("req-1", ["k"]);
    const again = await as(A).evaluation("req-1", ["k"]);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.data.batchId).toBe(first.data.batchId);
    expect(again.data.targets[0].jobId).toBe(first.data.targets[0].jobId);
    expect(queued).toHaveLength(1); // dispatched once
    const conflict = await as(A).evaluation("req-1", ["k", "other"]);
    expect(conflict).toMatchObject({ status: 409, data: { code: "conflict" } });
    expect(db.sqlite.query("SELECT count(*) n FROM links").get()).toEqual({ n: 0 });
  });

  test("Save adds links through the normal pipeline: dedupe, one extraction batch, nothing local", async () => {
    const kept = await call("/api/links", { cookie: A.cookie, body: { url: "https://kept.dev/" } });
    expect(kept.status).toBe(201);
    db.sqlite.exec("UPDATE jobs SET status='done'");
    queued.length = 0;
    const res = await as(A).send("/browser/save", "POST", { urls: ["https://new.dev/a?utm_source=x", "https://kept.dev/", "chrome://settings"] });
    expect(res.status).toBe(200);
    expect(res.data.results.map((r: { status: string }) => r.status)).toEqual(["created", "duplicate", "rejected"]);
    const link = db.sqlite.query("SELECT url,user_id,content_source,content_state,content_key FROM links WHERE url LIKE 'https://new.dev/%'").get();
    expect(link).toEqual({ url: "https://new.dev/a", user_id: A.userId, content_source: null, content_state: "queued", content_key: null });
    expect(queued).toHaveLength(1);
    const again = await as(A).send("/browser/save", "POST", { urls: ["https://new.dev/a"] });
    expect(again.data.results[0].status).toBe("duplicate");
    expect(db.sqlite.query("SELECT count(*) n FROM batches").get()).toEqual({ n: 2 });
  });

  test("the catalog read doesn't write once the library id exists", async () => {
    const first = await as(A).catalog();
    const writes = db.sqlite.query("SELECT total_changes() n").get() as { n: number };
    await as(A).catalog();
    expect((db.sqlite.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes.n);
    expect(first.libraryId).toBeTruthy();
  });

  test("Browser routes need a session and same-origin JSON writes", async () => {
    expect((await call("/api/browser/catalog")).status).toBe(401);
    expect((await call("/api/browser/save", { body: { urls: ["https://x.dev"] } })).status).toBe(401);
    expect((await call("/api/browser/save", { cookie: A.cookie, body: { urls: ["https://x.dev"] }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/api/browser/groups", { cookie: A.cookie, body: { name: "x", color: "blue" }, origin: null })).status).toBe(403);
  });
});

describe("Browser data is private per account", () => {
  test("each account has its own library id, groups and lenses", async () => {
    const catA = await as(A).catalog();
    const catB = await as(B).catalog();
    expect(catA.libraryId).not.toBe(catB.libraryId);
    const created = await as(A).send("/browser/groups", "POST", { id: "g-a", name: "Research", color: "blue" });
    expect(created.status).toBe(201);
    expect((await as(B).catalog()).groups).toEqual([]);
    // B can't rename, unpin or take over A's group id.
    expect((await as(B).send("/browser/groups/g-a", "PATCH", { name: "Stolen" })).status).toBe(404);
    await as(B).send("/browser/groups/g-a", "DELETE");
    expect(await as(B).send("/browser/groups", "POST", { id: "g-a", name: "Mine", color: "red" })).toMatchObject({ status: 409, data: { code: "conflict" } });
    expect((await as(B).catalog()).groups).toEqual([]);
    expect((await as(A).catalog()).groups.map((g) => g.name)).toEqual(["Research"]);
    // A's library id is not B's: B's page can't submit work under it.
    lens(B, "lens-b");
    const mismatch = await as(B).evaluation("req-b", ["a"], "lens-b", catA.libraryId);
    expect(mismatch).toMatchObject({ status: 409, data: { code: "library-mismatch" } });
    // B can't run A's lens.
    expect(await as(B).evaluation("req-b", ["a"], "lens")).toMatchObject({ status: 404, data: { code: "lens-missing" } });
  });

  test("B can't read, confirm, cancel or replay A's evaluation", async () => {
    const created = await as(A).evaluation("req-a", ["k1", "k2"]);
    expect(created.status).toBe(201);
    db.sqlite.exec(`UPDATE browser_targets SET answer='{"type":"noul","noul":1}' WHERE target_key='k1'`);
    const b = as(B);
    expect(await b.send("/browser/evaluations/req-a", "GET")).toMatchObject({ status: 404, data: { code: "unknown-request" } });
    expect((await b.send("/browser/evaluations/req-a/ack", "POST", { targetKeys: ["k1"] })).status).toBe(404);
    expect((await b.send("/browser/evaluations/req-a", "DELETE", { targetKeys: ["k2"] })).status).toBe(404);
    // Reusing A's request id answers like any id conflict, without A's status or jobs.
    lens(B, "lens-b");
    const replay = await b.evaluation("req-a", ["k1"], "lens-b");
    expect(replay).toMatchObject({ status: 409, data: { code: "conflict" } });
    expect(JSON.stringify(replay.data)).not.toContain(created.data.batchId);
    // A's data is untouched.
    const rows = db.sqlite.query("SELECT bt.target_key k, bt.acked_at a, j.status s FROM browser_targets bt JOIN jobs j ON j.target_id=bt.id ORDER BY k").all();
    expect(rows).toEqual([{ k: "k1", a: null, s: "queued" }, { k: "k2", a: null, s: "queued" }]);
    expect((await as(A).send("/browser/evaluations/req-a", "GET")).data.targets.length).toBe(2);
    // B's batch/usage views don't show A's Browser batch.
    expect((await b.send(`/batches/${created.data.batchId}`, "GET")).status).toBe(404);
    expect((await b.send("/library", "GET")).data.batches).toEqual([]);
  });

  test("Save of the same URL creates one private link per account", async () => {
    const a = await as(A).send("/browser/save", "POST", { urls: ["https://same.dev/page"] });
    const b = await as(B).send("/browser/save", "POST", { urls: ["https://same.dev/page"] });
    expect(a.data.results[0].status).toBe("created");
    expect(b.data.results[0].status).toBe("created");
    expect(a.data.results[0].id).not.toBe(b.data.results[0].id);
    expect(a.data.links.map((l: { id: string }) => l.id)).toEqual([a.data.results[0].id]);
    expect(b.data.links.map((l: { id: string }) => l.id)).toEqual([b.data.results[0].id]);
  });

  test("Browser jobs run as their request owner and can't be attached to another owner's batch", async () => {
    const created = await as(A).evaluation("req-a", ["k1"]);
    const jobId = created.data.targets[0].jobId as string;
    const loaded = await loadOwnedJob(env.DB, jobId);
    expect(loaded.job.user_id).toBe(A.userId);
    expect(loaded.target?.capture_key?.startsWith(`users/${A.userId}/`)).toBe(true);
    expect(loaded.link).toBeNull();
    // B's batch can't carry a job for A's capture, nor can B's request hang off A's batch.
    const targetId = (db.sqlite.query("SELECT id FROM browser_targets").get() as { id: string }).id;
    db.sqlite.query("INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('bb',?,'browser-lens','{}','now')").run(B.userId);
    expect(() => db.sqlite.query("INSERT INTO jobs(id,batch_id,target_id,created_at) VALUES('x','bb',?,'now')").run(targetId)).toThrow(/cross-owner/);
    expect(() =>
      db.sqlite
        .query("INSERT INTO browser_requests(request_id,user_id,payload_hash,kind,batch_id,library_id,session_id,created_at) VALUES('r2',?,'h','lens',?,'l','s','now')")
        .run(B.userId, created.data.batchId),
    ).toThrow(/cross-owner/);
    expect(() =>
      db.sqlite.query("INSERT INTO browser_groups(id,user_id,name,color,created_at,updated_at) VALUES('g',NULL,'n','blue','now','now')").run(),
    ).toThrow(/owner required/);
  });
});

describe("Browser evaluations take nothing from the upload quota", () => {
  const used = (who: User, prefix: string) =>
    (db.sqlite.query("SELECT count FROM app_rate_limits WHERE key=?").get(`${prefix}:${who.userId}`) as { count: number } | null)?.count ?? 0;
  const exhaust = (who: User, key: string, count: number) =>
    db.sqlite
      .query("INSERT OR REPLACE INTO app_rate_limits(key,window_start,count) VALUES(?,?,?)")
      .run(`${key}:${who.userId}`, Math.floor(Date.now() / 1000 / 3600) * 3600, count);

  test("a full links quota and an old jobs counter at its former limit refuse no evaluation", async () => {
    exhaust(A, "links", 500);
    exhaust(A, "jobs", 300);
    const res = await as(A).evaluation("req", ["a", "b", "c"]);
    expect(res.status).toBe(201);
    expect(queued).toHaveLength(3);
    expect([used(A, "links"), used(A, "jobs")]).toEqual([500, 300]);
  });

  test("replays and a concurrent duplicate still create each evaluation once", async () => {
    expect((await as(A).evaluation("req", ["a", "b"])).status).toBe(201);
    expect((await as(A).evaluation("req", ["a", "b"])).status).toBe(200);
    const [x, y] = await Promise.all([as(A).evaluation("race", ["a", "b"]), as(A).evaluation("race", ["a", "b"])]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(db.sqlite.query("SELECT count(*) n FROM jobs").get()).toEqual({ n: 4 });
    expect(used(A, "links")).toBe(0);
  });
});
