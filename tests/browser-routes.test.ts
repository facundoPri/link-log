import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { lensFingerprint } from "@linklog/browser-protocol";
import { browserRoute, libraryId } from "../worker/browser";
import { dispatch, recover } from "../worker/jobs";

// Minimal D1 surface over bun:sqlite.
function d1(db: Database) {
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: db.query(sql).all(...(params as never[])) }),
    first: async () => db.query(sql).get(...(params as never[])) ?? null,
    run: async () => ({ meta: { changes: db.query(sql).run(...(params as never[])).changes } }),
    _exec: () => db.query(sql).run(...(params as never[])),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { _exec: () => unknown }[]) => db.transaction(() => list.map((s) => s._exec()))(),
  };
}

async function setup({ failPut = false } = {}) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(await Bun.file(`migrations/${f}`).text());
  const deleted: string[] = [];
  const sent: unknown[] = [];
  const puts: string[] = [];
  const created: unknown[] = [];
  const env = {
    DB: d1(db),
    JEV_PROVIDER: "fixture",
    ALLOW_FIXTURE_JEV: "1",
    PROCESS_LINK: { create: async (o: unknown) => void created.push(o) },
    CONTENT: {
      put: async (key: string) => {
        if (failPut) throw new Error("R2 down");
        puts.push(key);
      },
      delete: async (keys: string[]) => void deleted.push(...keys),
    },
    JOBS: { sendBatch: async (m: unknown[]) => void sent.push(...m) },
  } as unknown as Env;
  db.exec("INSERT INTO lenses(id,name,type,question,options,created_at,scope) VALUES('lens','L','noul','Relevant?','{}','t','browser')");
  db.exec("INSERT INTO lenses(id,name,type,question,options,created_at,scope) VALUES('lib','Lib','noul','Relevant?','{}','t','library')");
  const route = async (path: string, method: string, body: unknown = {}) => {
    const r = (await browserRoute(env, path, method, body as never))!;
    return { status: r.status, data: (await r.json()) as any };
  };
  const fp = lensFingerprint({ type: "noul", question: "Relevant?", options: [], levels: [], criteria: { yes: "", no: "" } } as never);
  const targets = (keys: string[]) =>
    keys.map((k) => ({ targetKey: k, url: `https://x.dev/${k}`, title: k, capture: { source: "dom", capturedAt: "2026-10-01T12:00:00.000Z", completeness: "complete", reasons: [], facts: [], markdown: `page ${k}` } }));
  const evaluation = async (requestId: string, keys: string[], lensId = "lens") =>
    route("/api/browser/evaluations", "POST", {
      requestId,
      libraryId: await libraryId(env),
      sessionId: "s",
      kind: "lens",
      lens: { id: lensId, fingerprint: fp },
      targets: targets(keys),
    });
  const autogroup = async (requestId: string, keys: string[]) =>
    route("/api/browser/evaluations", "POST", {
      requestId,
      libraryId: await libraryId(env),
      sessionId: "s",
      kind: "autogroup",
      catalogVersion: "v1",
      destinations: [{ key: "g:1", name: "Work", description: "Work tabs" }],
      targets: targets(keys),
    });
  return { db, env, route, evaluation, autogroup, deleted, sent, puts, created };
}

test("DELETE cancels only the targets it names (Clean of some tabs)", async () => {
  const { db, route, evaluation } = await setup();
  await evaluation("req", ["a", "b", "c"]);
  const res = await route("/api/browser/evaluations/req", "DELETE", { targetKeys: ["b"] });
  expect(res.data.cancelled).toBe(1);
  const rows = db.query("SELECT bt.target_key k, j.status s FROM jobs j JOIN browser_targets bt ON bt.id=j.target_id ORDER BY k").all();
  expect(rows).toEqual([{ k: "a", s: "queued" }, { k: "b", s: "failed" }, { k: "c", s: "queued" }]);
});

test("library lenses can't evaluate open tabs", async () => {
  const { evaluation, db } = await setup();
  const res = await evaluation("req", ["a"], "lib");
  expect(res).toMatchObject({ status: 400, data: { code: "lens-scope" } });
  expect(db.query("SELECT count(*) n FROM jobs").get()).toEqual({ n: 0 });
});

test("ack confirms and purges only answered targets", async () => {
  const { db, route, evaluation, deleted } = await setup();
  await evaluation("req", ["a", "b"]);
  db.exec(`UPDATE browser_targets SET answer='{"type":"noul","noul":1}' WHERE target_key='a'`);
  const keys = db.query("SELECT target_key k, capture_key c FROM browser_targets ORDER BY k").all() as { k: string; c: string }[];
  const res = await route("/api/browser/evaluations/req/ack", "POST", { targetKeys: ["a", "b"] });
  expect(res.data.acked).toBe(1);
  expect(deleted).toEqual([keys[0]!.c]); // b's snapshot stays: its job may still need it
  const rows = db.query("SELECT target_key k, acked_at IS NOT NULL acked, capture_key IS NOT NULL snap FROM browser_targets ORDER BY k").all();
  expect(rows).toEqual([{ k: "a", acked: 1, snap: 0 }, { k: "b", acked: 0, snap: 1 }]);
});

test("a snapshot that can't be stored fails its target visibly instead of orphaning the request", async () => {
  const { evaluation, sent, db } = await setup({ failPut: true });
  const res = await evaluation("req", ["a"]);
  expect(res.status).toBe(201);
  expect(res.data.targets[0]).toMatchObject({ state: "failed", error: "The page snapshot could not be stored. Evaluate the tab again." });
  expect(sent).toHaveLength(0);
  expect(db.query("SELECT count(*) n FROM usage_events").get()).toEqual({ n: 0 });
});

test("Save adds links through the normal pipeline: dedupe, one extraction batch, nothing local", async () => {
  const { db, route, sent } = await setup();
  db.exec("INSERT INTO links(id,original_url,url,domain,title,created_at) VALUES('old','https://kept.dev/','https://kept.dev/','kept.dev','Kept','t')");
  const res = await route("/api/browser/save", "POST", { urls: ["https://new.dev/a?utm_source=x", "https://kept.dev/", "chrome://settings"] });
  expect(res.status).toBe(200);
  expect(res.data.results.map((r: { status: string }) => r.status)).toEqual(["created", "duplicate", "rejected"]);
  const link = db.query("SELECT url,content_source,content_state,content_key FROM links WHERE url LIKE 'https://new.dev/%'").get();
  expect(link).toEqual({ url: "https://new.dev/a", content_source: null, content_state: "queued", content_key: null });
  expect(db.query("SELECT kind, (SELECT count(*) FROM jobs WHERE batch_id=batches.id) n FROM batches").all()).toEqual([{ kind: "extract", n: 1 }]);
  expect(sent).toHaveLength(1);
  const again = await route("/api/browser/save", "POST", { urls: ["https://new.dev/a"] });
  expect(again.data.results[0].status).toBe("duplicate");
  expect(db.query("SELECT count(*) n FROM batches").get()).toEqual({ n: 1 });
});

test("the catalog read doesn't write once the library id exists", async () => {
  const { db, route } = await setup();
  const first = await route("/api/browser/catalog", "GET");
  const writes = db.query("SELECT total_changes() n").get() as { n: number };
  await route("/api/browser/catalog", "GET");
  expect((db.query("SELECT total_changes() n").get() as { n: number }).n).toBe(writes.n);
  expect(first.data.libraryId).toBeTruthy();
});

test("without Jev configured, browser lens and Autogroup requests are refused before any work is created", async () => {
  const s = await setup();
  Object.assign(s.env, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: undefined });
  const count = () =>
    Object.fromEntries(["batches", "jobs", "browser_requests", "browser_targets", "usage_events"].map((t) => [t, (s.db.query(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n]));
  const before = count();
  for (const res of [await s.evaluation("req-lens", ["a", "b"]), await s.autogroup("req-group", ["a", "b"])])
    expect(res).toEqual({ status: 400, data: { error: "Jev is not configured: API key missing.", code: "jev-unavailable" } });
  expect(count()).toEqual(before);
  expect(s.puts).toHaveLength(0);
  expect(s.sent).toHaveLength(0);
  // Not even cron recovery has anything to start.
  await recover(s.env);
  await dispatch({ messages: s.sent.map((body) => ({ body, ack: () => {}, retry: () => {} })) } as never, s.env);
  expect(s.created).toHaveLength(0);
  // Never accepted: a resend by request id is still unknown, not a stored failure.
  expect((await s.route("/api/browser/evaluations/req-lens", "GET")).status).toBe(404);
});

test("an evaluation accepted before Jev was unconfigured still replays and reports its status", async () => {
  const s = await setup();
  const first = await s.evaluation("req", ["a"]);
  expect(first.status).toBe(201);
  Object.assign(s.env, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: undefined });
  const again = await s.evaluation("req", ["a"]);
  expect(again.status).toBe(200);
  expect(again.data.batchId).toBe(first.data.batchId);
  expect((await s.route("/api/browser/evaluations/req", "GET")).data.batchId).toBe(first.data.batchId);
});
