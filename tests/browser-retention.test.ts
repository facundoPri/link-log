import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { expect, test } from "bun:test";
import { cleanupBrowser, evaluationStatus } from "../worker/browser";

// Minimal D1 surface over bun:sqlite for the retention paths.
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

async function setup() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(await Bun.file(`migrations/${f}`).text());
  const deleted: string[] = [];
  const env = {
    DB: d1(db),
    CONTENT: { delete: async (keys: string[]) => void deleted.push(...keys) },
  } as unknown as Env;
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO batches(id,kind,config,created_at) VALUES('b','browser-lens','{}','${old}');
    INSERT INTO browser_requests(request_id,payload_hash,kind,batch_id,library_id,session_id,created_at) VALUES('r','h','lens','b','lib','s','${old}');
    INSERT INTO browser_targets(id,request_id,target_key,url,title,capture_key,capture_meta,answer,model,evaluated_at,created_at) VALUES
      ('t1','r','k1','https://a.dev','A','browser/r/1.md','{}','{"type":"noul","noul":0.9}','m','${old}','${old}'),
      ('t2','r','k2','https://b.dev','B','browser/r/2.md','{}',NULL,NULL,NULL,'${now}'),
      ('t3','r','k3','https://c.dev','C',NULL,'{}','{"type":"noul","noul":0.1}','m','${now}','${now}');
    INSERT INTO jobs(id,batch_id,target_id,status,created_at) VALUES('j1','b','t1','done','${old}'),('j2','b','t2','done','${now}'),('j3','b','t3','done','${now}');
  `);
  return { db, env, deleted };
}

test("snapshots are dropped when no longer needed and unconfirmed results expire after 7 days", async () => {
  const { env, deleted, db } = await setup();
  const result = await cleanupBrowser(env);
  expect(result).toEqual({ snapshots: 2, expired: 1 });
  expect(deleted.sort()).toEqual(["browser/r/1.md", "browser/r/2.md", "browser/r/1.md"].sort());
  const status = await evaluationStatus(env, "r");
  const byKey = Object.fromEntries(status!.targets.map((t) => [t.targetKey, t]));
  // Expired is reported as such (explicit re-evaluation), never as an answer or a "No".
  expect(byKey.k1!.state).toBe("expired");
  expect(byKey.k1!.answer).toBeUndefined();
  expect(byKey.k3).toMatchObject({ state: "done", answer: { type: "noul", noul: 0.1 } });
  // Idempotent: a second sweep changes nothing and keeps the receipt and jobs.
  expect(await cleanupBrowser(env)).toEqual({ snapshots: 0, expired: 0 });
  expect(db.query("SELECT count(*) n FROM browser_requests").get()).toEqual({ n: 1 });
  expect(db.query("SELECT count(*) n FROM jobs").get()).toEqual({ n: 3 });
});

test("unknown request ids are reported as unknown so the page can resend with the same id", async () => {
  const { env } = await setup();
  expect(await evaluationStatus(env, "never-sent")).toBeNull();
});

test("evaluation requests are idempotent by request id and never create links", async () => {
  const { env, db } = await setup();
  const sent: unknown[] = [];
  Object.assign(env, {
    JEV_PROVIDER: "fixture",
    ALLOW_FIXTURE_JEV: "1",
    CONTENT: { put: async () => {}, delete: async () => {} },
    JOBS: { sendBatch: async (m: unknown[]) => void sent.push(...m) },
  });
  const { browserRoute, libraryId } = await import("../worker/browser");
  const { lensFingerprint } = await import("@linklog/browser-protocol");
  db.exec("INSERT INTO lenses(id,name,type,question,options,created_at,scope) VALUES('lens','L','noul','Relevant?','{}','t','browser')");
  const lens = { type: "noul", question: "Relevant?", options: [], levels: [], criteria: { yes: "", no: "" } } as never;
  const body = {
    requestId: "req-1",
    libraryId: await libraryId(env),
    sessionId: "s",
    kind: "lens",
    lens: { id: "lens", fingerprint: lensFingerprint(lens) },
    targets: [{ targetKey: "k", url: "https://x.dev", title: "X", capture: { source: "dom", capturedAt: new Date().toISOString(), completeness: "complete", reasons: [], facts: [], markdown: "hello" } }],
  };
  const post = async (b: unknown) => {
    const r = (await browserRoute(env, "/api/browser/evaluations", "POST", b as never))!;
    return { status: r.status, data: (await r.json()) as any };
  };
  const first = await post(body);
  const again = await post(body);
  expect(first.status).toBe(201);
  expect(again.status).toBe(200);
  expect(again.data.batchId).toBe(first.data.batchId);
  expect(again.data.targets[0].jobId).toBe(first.data.targets[0].jobId);
  expect(sent).toHaveLength(1); // dispatched once
  const conflict = await post({ ...body, targets: [{ ...body.targets[0], capture: { ...body.targets[0]!.capture, markdown: "other" } }] });
  expect(conflict).toMatchObject({ status: 409, data: { code: "conflict" } });
  const stale = await post({ ...body, requestId: "req-2", lens: { id: "lens", fingerprint: "old" } });
  expect(stale).toMatchObject({ status: 409, data: { code: "lens-changed" } });
  expect(db.query("SELECT count(*) n FROM links").get()).toEqual({ n: 0 });
});
