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
    INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('u','U','u@example.test',1,'${old}','${old}');
    INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('b','u','browser-lens','{}','${old}');
    INSERT INTO browser_requests(request_id,user_id,payload_hash,kind,batch_id,library_id,session_id,created_at) VALUES('r','u','h','lens','b','lib','s','${old}');
    INSERT INTO browser_targets(id,request_id,target_key,url,title,capture_key,capture_meta,answer,model,evaluated_at,created_at) VALUES
      ('t1','r','k1','https://a.dev','A','users/u/browser/r/1.md','{}','{"type":"noul","noul":0.9}','m','${old}','${old}'),
      ('t2','r','k2','https://b.dev','B','users/u/browser/r/2.md','{}',NULL,NULL,NULL,'${now}'),
      ('t3','r','k3','https://c.dev','C',NULL,'{}','{"type":"noul","noul":0.1}','m','${now}','${now}');
    INSERT INTO jobs(id,batch_id,target_id,status,created_at) VALUES('j1','b','t1','done','${old}'),('j2','b','t2','done','${now}'),('j3','b','t3','done','${now}');
  `);
  return { db, env, deleted };
}

test("snapshots are dropped when no longer needed and unconfirmed results expire after 7 days", async () => {
  const { env, deleted, db } = await setup();
  const result = await cleanupBrowser(env);
  expect(result).toEqual({ snapshots: 2, expired: 1 });
  expect(deleted.sort()).toEqual(["users/u/browser/r/1.md", "users/u/browser/r/2.md", "users/u/browser/r/1.md"].sort());
  const status = await evaluationStatus(env, "u", "r");
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

test("unknown and foreign request ids are reported as unknown", async () => {
  const { env } = await setup();
  expect(await evaluationStatus(env, "u", "never-sent")).toBeNull();
  expect(await evaluationStatus(env, "someone-else", "r")).toBeNull();
});
