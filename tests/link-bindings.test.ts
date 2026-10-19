// R10: D1 accepts at most 100 bound parameters per statement, also inside batch()
// (https://developers.cloudflare.com/d1/platform/limits/). TestD1 enforces that limit, so these
// cover the full 1–100 URL contract of import / Browser save / batches in ONE transaction.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";

let db: TestD1, env: Env, queued: { id: string }[], call: ReturnType<typeof client>, user: { userId: string; cookie: string };
beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, queued } = makeEnv(db));
  call = client(env);
  user = await testSession(env, "a@example.test");
  // Writes per minute are not what these tests measure.
  db.sqlite.exec("CREATE TRIGGER no_write_quota AFTER INSERT ON app_rate_limits WHEN NEW.key LIKE 'writes:%' BEGIN DELETE FROM app_rate_limits WHERE key=NEW.key; END");
});
const n = (sql: string) => (db.sqlite.query(sql).get() as { n: number }).n;
const state = () => ({
  links: n("SELECT count(*) n FROM links"),
  jobs: n("SELECT count(*) n FROM jobs"),
  batches: n("SELECT count(*) n FROM batches"),
  withoutJob: n("SELECT count(*) n FROM links l WHERE NOT EXISTS(SELECT 1 FROM jobs j WHERE j.link_id=l.id)"),
  queuedState: n("SELECT count(*) n FROM links WHERE content_state='queued'"),
  quota: Object.fromEntries((db.sqlite.query("SELECT key,count FROM app_rate_limits").all() as { key: string; count: number }[]).map((r) => [r.key.split(":")[0], r.count])),
  messages: queued.length,
});
const urls = (count: number, tag = "u") => Array.from({ length: count }, (_, i) => `https://bindings.example/${tag}/${i}`);
const post = async (path: string, body: unknown) => {
  const r = await call(path, { cookie: user.cookie, body });
  return { status: r.status, data: (await r.json()) as any };
};

describe("up to 100 new URLs in one transaction", () => {
  for (const size of [96, 97, 99, 100])
    test(`import ${size}: all saved with one job each; the retry is a pure duplicate`, async () => {
      const res = await post("/api/import", { urls: urls(size) });
      expect([res.status, res.data.imported, res.data.duplicates]).toEqual([200, size, 0]);
      const expected = { links: size, jobs: size, batches: 1, withoutJob: 0, queuedState: size, quota: { links: size, jobs: size }, messages: size };
      expect(state()).toEqual(expected);
      const again = await post("/api/import", { urls: urls(size) });
      expect([again.status, again.data.imported, again.data.duplicates]).toEqual([200, 0, size]);
      expect(state()).toEqual(expected); // no empty batch, no charge, no message
    });

  for (const size of [96, 97, 99, 100])
    test(`Browser save ${size}: same contract`, async () => {
      const res = await post("/api/browser/save", { urls: urls(size) });
      expect(res.status).toBe(200);
      expect(res.data.results.filter((r: { status: string }) => r.status === "created").length).toBe(size);
      expect(state()).toEqual({ links: size, jobs: size, batches: 1, withoutJob: 0, queuedState: size, quota: { links: size, jobs: size }, messages: size });
      const again = await post("/api/browser/save", { urls: urls(size) });
      expect(again.data.results.every((r: { status: string }) => r.status === "duplicate")).toBe(true);
      expect(state()).toMatchObject({ links: size, jobs: size, batches: 1, messages: size });
    });

  test("100 candidates mixing orphans and new URLs: one job each, links charged only for new ones", async () => {
    const all = urls(100);
    for (const url of all.slice(0, 60))
      db.sqlite
        .query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES(?,?,?,?,'bindings.example','x','t')")
        .run(crypto.randomUUID(), user.userId, url, url);
    const res = await post("/api/import", { urls: all });
    expect([res.status, res.data.imported, res.data.duplicates]).toEqual([200, 40, 60]);
    expect(state()).toEqual({ links: 100, jobs: 100, batches: 1, withoutJob: 0, queuedState: 100, quota: { links: 40, jobs: 100 }, messages: 100 });
  });

  test("a failure in the last of 100 inserts rolls back the whole batch and refunds everything", async () => {
    const all = urls(100);
    db.sqlite.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON links WHEN NEW.original_url='${all[99]}' BEGIN SELECT RAISE(ABORT, 'injected D1 failure'); END`);
    expect((await post("/api/import", { urls: all })).status).toBeGreaterThanOrEqual(400);
    expect(state()).toEqual({ links: 0, jobs: 0, batches: 0, withoutJob: 0, queuedState: 0, quota: { links: 0, jobs: 0 }, messages: 0 });
    db.sqlite.exec("DROP TRIGGER inject_fault");
    expect((await post("/api/import", { urls: all })).data.imported).toBe(100);
    expect(state()).toMatchObject({ links: 100, jobs: 100, batches: 1, quota: { links: 100, jobs: 100 }, messages: 100 });
  });
});

test("a batch over 100 selected links and its cancellation stay within the limit", async () => {
  await post("/api/import", { urls: urls(100) });
  db.sqlite.exec("UPDATE jobs SET status='done'; UPDATE links SET content_state='ready', content_key='k'");
  const ids = (db.sqlite.query("SELECT id FROM links").all() as { id: string }[]).map((r) => r.id);
  db.sqlite.exec("DELETE FROM app_rate_limits");
  const batch = await post("/api/batches", { ids, kind: "extract" });
  expect(batch.status).toBe(200);
  const cancelled = await call(`/api/batches/${batch.data.batchId}`, { cookie: user.cookie, method: "DELETE", body: {} });
  expect(cancelled.status).toBe(200);
  expect(((await cancelled.json()) as { cancelled: number }).cancelled).toBe(100);
  expect(n("SELECT count(*) n FROM links WHERE content_state='queued'")).toBe(0);
  expect(n(`SELECT count(*) n FROM jobs WHERE batch_id='${batch.data.batchId}' AND status='failed'`)).toBe(100);
});
