// Regressions for planning/research/auth-code-review-latest.md (findings verified against the code;
// see planning/research/auth-code-review-latest-fixes.md). TestD1 enforces D1's 100 bound
// parameters per statement; scripts/e2e-auth.ts repeats the 100-target ack/cancel on real local D1.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lensFingerprint } from "@linklog/browser-protocol";
import { TestD1 } from "./support/d1";
import { client, makeEnv, type FakeR2 } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { readConfig } from "../worker/config";
import { createMailer } from "../worker/email";
import { recover } from "../worker/jobs";
import { sha256 } from "../worker/limits";

type User = { userId: string; cookie: string };
let db: TestD1, env: Env, r2: FakeR2, call: ReturnType<typeof client>, A: User, B: User;
let logs: string[] = [];
const n = (sql: string) => (db.sqlite.query(sql).get() as { n: number }).n;
const quota = (key: string) => (db.sqlite.query("SELECT count FROM app_rate_limits WHERE key=?").get(key) as { count: number } | null)?.count ?? 0;
const send = async (who: User, path: string, method = "POST", body: unknown = {}) => {
  const r = await call(`/api${path}`, { cookie: who.cookie, method, body: method === "GET" ? undefined : body });
  return { status: r.status, data: (await r.json()) as any };
};

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, r2 } = makeEnv(db, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" }));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
  // Writes per minute are not what these tests measure.
  db.sqlite.exec("CREATE TRIGGER no_write_quota AFTER INSERT ON app_rate_limits WHEN NEW.key LIKE 'writes:%' BEGIN DELETE FROM app_rate_limits WHERE key=NEW.key; END");
  logs = [];
  for (const level of ["log", "warn", "error"] as const) spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
});
afterEach(() => {
  for (const level of ["log", "warn", "error"] as const) (console[level] as unknown as { mockRestore(): void }).mockRestore();
});

describe("1. ack and cancel of a full 100-target evaluation", () => {
  const keys = Array.from({ length: 100 }, (_, i) => `tab-${i}`);
  async function evaluate(owner: User, requestId: string) {
    db.sqlite.query("INSERT OR IGNORE INTO lenses(id,user_id,name,type,question,options,created_at,scope) VALUES(?,?,?,'noul','Relevant?','{}','t','browser')").run(`lens-${owner.userId}`, owner.userId, "lens");
    const libraryId = (await send(owner, "/browser/catalog", "GET")).data.libraryId;
    const fingerprint = lensFingerprint({ type: "noul", question: "Relevant?", options: [], levels: [], criteria: { yes: "", no: "" } } as never);
    const res = await send(owner, "/browser/evaluations", "POST", {
      requestId,
      libraryId,
      sessionId: "s",
      kind: "lens",
      lens: { id: `lens-${owner.userId}`, fingerprint },
      targets: keys.map((k) => ({
        targetKey: k,
        url: `https://x.dev/${k}`,
        title: k,
        capture: { source: "dom", capturedAt: new Date().toISOString(), completeness: "complete", reasons: [], facts: [], markdown: `page ${k}` },
      })),
    });
    expect(res.status).toBe(201);
  }

  test("ack of 100 answered targets confirms all of them and purges their snapshots; B can't", async () => {
    await evaluate(A, "req-a");
    await evaluate(B, "req-b");
    db.sqlite.exec(`UPDATE browser_targets SET answer='{"type":"noul","noul":1}'`);
    const snapshots = (db.sqlite.query("SELECT capture_key c FROM browser_targets WHERE request_id='req-a'").all() as { c: string }[]).map((r) => r.c);
    expect((await send(B, "/browser/evaluations/req-a/ack", "POST", { targetKeys: keys })).status).toBe(404);
    expect(n("SELECT count(*) n FROM browser_targets WHERE acked_at IS NOT NULL")).toBe(0);

    const res = await send(A, "/browser/evaluations/req-a/ack", "POST", { targetKeys: keys });
    expect(res).toEqual({ status: 200, data: { acked: 100 } });
    expect(snapshots.some((k) => r2.objects.has(k))).toBe(false);
    expect(n("SELECT count(*) n FROM browser_targets WHERE request_id='req-a' AND acked_at IS NOT NULL AND answer IS NULL AND capture_key IS NULL")).toBe(100);
    // B's identical keys are untouched.
    expect(n("SELECT count(*) n FROM browser_targets WHERE request_id='req-b' AND acked_at IS NULL AND answer IS NOT NULL")).toBe(100);
    // Idempotent: a repeated ack confirms nothing new.
    expect((await send(A, "/browser/evaluations/req-a/ack", "POST", { targetKeys: keys })).data).toEqual({ acked: 0 });
  });

  test("cancel naming 100 targets cancels them all, only in the owner's request", async () => {
    await evaluate(A, "req-a");
    await evaluate(B, "req-b");
    expect((await send(B, "/browser/evaluations/req-a", "DELETE", { targetKeys: keys })).status).toBe(404);
    const res = await send(A, "/browser/evaluations/req-a", "DELETE", { targetKeys: keys });
    expect(res).toEqual({ status: 200, data: { cancelled: 100 } });
    const byRequest = db.sqlite.query("SELECT bt.request_id r, j.status s, count(*) n FROM jobs j JOIN browser_targets bt ON bt.id=j.target_id GROUP BY 1,2 ORDER BY 1").all();
    expect(byRequest).toEqual([{ r: "req-a", s: "failed", n: 100 }, { r: "req-b", s: "queued", n: 100 }]);
  });
});

describe("2. session lookup failure is 503, not 401", () => {
  test("missing or revoked session -> 401; storage failure -> 503 without signing the user out", async () => {
    expect((await call("/api/library")).status).toBe(401);
    expect((await send(A, "/library", "GET")).status).toBe(200);
    // D1 failing under Better Auth's session lookup (outage, timeout).
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/from\s+"session"/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
      return prepare(sql);
    }) as typeof db.prepare;
    const failed = await call("/api/library", { cookie: A.cookie });
    expect(failed.status).toBe(503);
    expect(((await failed.json()) as { code: string }).code).toBe("session-unavailable");
    expect(failed.headers.getSetCookie().join("")).not.toContain("session_token=;");
    expect(logs.join("\n")).not.toContain(A.cookie.split("=")[1]!.split(";")[0]!);
    db.prepare = prepare;
    // The same session works again once storage is back; revoking it is a real 401.
    expect((await send(A, "/library", "GET")).status).toBe(200);
    db.sqlite.exec(`DELETE FROM "session" WHERE "userId"='${A.userId}'`);
    expect((await send(A, "/library", "GET")).status).toBe(401);
  });
});

describe("3. auth email budgets are taken together or not at all", () => {
  async function deliver(e: Env, to: string, daily = 2) {
    const pending: Promise<unknown>[] = [];
    const config = { ...readConfig(e), emailDailyLimit: daily };
    createMailer(e, config, (p) => void pending.push(p)).send({ kind: "magic", to, url: "http://localhost:3000/x" });
    await Promise.all(pending);
  }
  test("a send refused by the daily cap does not use the recipient's hourly quota", async () => {
    const { env: e, outbox } = makeEnv(db, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
    await deliver(e, "one@example.test", 1);
    await deliver(e, "two@example.test", 1);
    expect(outbox.map((m) => m.to)).toEqual(["one@example.test"]);
    expect(quota("email:day")).toBe(1);
    expect(quota(`email:to:${await sha256("two@example.test")}`)).toBe(0);
  });
  test("a send refused by the recipient cap does not use the daily budget", async () => {
    const { env: e, outbox } = makeEnv(db, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
    for (let i = 0; i < 6; i++) await deliver(e, "victim@example.test", 100);
    expect(outbox.length).toBe(5);
    expect(quota("email:day")).toBe(5);
    expect(quota(`email:to:${await sha256("victim@example.test")}`)).toBe(5);
    expect(logs.join("\n")).not.toContain("victim@example.test");
  });
});

describe("4. a failed enqueue leaves nothing queued", () => {
  async function readyLinks(owner: User, count: number) {
    const ids = Array.from({ length: count }, () => crypto.randomUUID());
    for (const [i, id] of ids.entries())
      db.sqlite
        .query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at,content_key) VALUES(?,?,?,?,'q.dev','q','t','k')")
        .run(id, owner.userId, `https://q.dev/${owner.userId}/${i}`, `https://q.dev/${owner.userId}/${i}`);
    return ids;
  }
  test("an injected D1 failure leaves nothing queued and nothing charged; the retry succeeds", async () => {
    const ids = await readyLinks(A, 3);
    db.sqlite.exec("CREATE TRIGGER inject_fault BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'injected D1 failure'); END");
    const failed = await send(A, "/batches", "POST", { ids, kind: "extract" });
    expect(failed.status).toBe(500);
    expect([n("SELECT count(*) n FROM jobs"), n("SELECT count(*) n FROM batches"), quota(`links:${A.userId}`)]).toEqual([0, 0, 0]);
    db.sqlite.exec("DROP TRIGGER inject_fault");
    expect((await send(A, "/batches", "POST", { ids, kind: "extract" })).status).toBe(200);
    expect([n("SELECT count(*) n FROM jobs"), quota(`links:${A.userId}`)]).toEqual([3, 0]); // re-extraction saves no new link
  });
  test("losing the race to a concurrent queue (unique active job) answers 'still processing'", async () => {
    const ids = await readyLinks(A, 2);
    // Another request queues ids[1] between this request's check and its batch.
    const batch = db.batch.bind(db);
    db.batch = (async (statements: Parameters<typeof batch>[0]) => {
      if (!statements[0]?.sql.startsWith("INSERT INTO batches")) return batch(statements);
      db.batch = batch;
      db.sqlite.exec(`INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('rival','${A.userId}','extract','{}','t')`);
      db.sqlite.exec(`INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES('rival-job','rival','${ids[1]}','t')`);
      return batch(statements);
    }) as typeof db.batch;
    const lost = await send(A, "/batches", "POST", { ids, kind: "extract" });
    expect(lost).toMatchObject({ status: 400, data: { error: "Some selected links are still processing." } });
    expect(db.sqlite.query("SELECT id FROM jobs").all()).toEqual([{ id: "rival-job" }]);
  });
});

describe("5. unexpected errors are a generic 500; validation stays 400", () => {
  test("corrupt stored JSON and an R2 failure do not leak as 400", async () => {
    const id = crypto.randomUUID();
    db.sqlite
      .query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at,content_details,content_key) VALUES(?,?,?,?,'v.dev','v','t',?,?)")
      .run(id, A.userId, "https://v.dev/1", "https://v.dev/1", "{secret-stored-detail", `users/${A.userId}/links/${id}/c.md`);
    const parse = await send(A, `/links/${id}/transcript`, "POST", { language: "auto" });
    expect(parse).toEqual({ status: 500, data: { error: "Something went wrong. Try again." } });
    r2.get = async () => {
      throw new Error("R2 internal bucket detail");
    };
    const storage = await send(A, `/links/${id}/content`, "GET");
    expect(storage).toEqual({ status: 500, data: { error: "Something went wrong. Try again." } });
    const text = logs.join("\n");
    expect(text).toContain('"event":"unhandled_error"');
    expect(text).not.toContain("secret-stored-detail");
    expect(text).not.toContain("R2 internal bucket detail");
    expect(text).not.toContain(A.cookie.split("=")[1]!.split(";")[0]!);
  });
  test("caller mistakes keep their message and 400", async () => {
    expect(await send(A, "/import", "POST", { urls: ["not a url"] })).toEqual({ status: 400, data: { error: "Paste a valid URL." } });
    expect(await send(A, "/tags", "POST", { name: "" })).toEqual({ status: 400, data: { error: "Enter a name." } });
    expect(await send(A, "/batches", "POST", { ids: [], kind: "extract" })).toEqual({ status: 400, data: { error: "Select between 1 and 100 links per batch." } });
    expect((await send(A, "/browser/evaluations/req/ack", "POST", { targetKeys: [] })).status).toBe(400);
  });
});

describe("6. ALLOW_FIXTURE_JEV outside local/test", () => {
  const prod = {
    APP_ENV: "production",
    BETTER_AUTH_URL: "https://linklog.example",
    BETTER_AUTH_SECRET: "q3Vt9w7yZ2pX5rK8mN1bC4dF6gH0jL2sQ9tW",
    EMAIL_FROM: "Linklog <auth@linklog.example>",
    EMAIL: { send() {} },
  };
  for (const value of [undefined, "", "0", "false", "FALSE"])
    test(`explicitly off (${JSON.stringify(value)}) is a valid production config`, () => {
      expect(readConfig({ ...prod, ALLOW_FIXTURE_JEV: value } as unknown as Env).appEnv).toBe("production");
    });
  for (const value of ["1", "true", "yes", "on", "2"])
    test(`enabled or ambiguous (${value}) fails closed`, () => {
      expect(() => readConfig({ ...prod, ALLOW_FIXTURE_JEV: value } as unknown as Env)).toThrow(/fixture/);
    });
  test("JEV_PROVIDER=fixture fails closed whatever the flag says", () => {
    expect(() => readConfig({ ...prod, JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "0" } as unknown as Env)).toThrow(/fixture/);
  });
});

test("7. recovery prunes dead Better Auth rateLimit rows and keeps live ones", async () => {
  // A real Better Auth request writes its bucket with lastRequest in epoch milliseconds.
  await call("/api/auth/sign-in/email", { body: { email: "a@example.test", password: "wrong password!!" } });
  const live = db.sqlite.query('SELECT key,"lastRequest" t FROM "rateLimit"').all() as { key: string; t: number }[];
  expect(live.length).toBeGreaterThan(0);
  expect(Math.abs(Number(live[0]!.t) - Date.now())).toBeLessThan(60_000);
  db.sqlite.query('INSERT INTO "rateLimit"(id,key,count,"lastRequest") VALUES(?,?,?,?)').run("old", "198.51.100.1/sign-in/email", 3, Date.now() - 2 * 86400_000);
  db.sqlite.query('INSERT INTO "rateLimit"(id,key,count,"lastRequest") VALUES(?,?,?,?)').run("recent", "198.51.100.2/sign-in/email", 5, Date.now() - 30_000);
  await recover(env);
  const keys = (db.sqlite.query('SELECT key FROM "rateLimit" ORDER BY key').all() as { key: string }[]).map((r) => r.key);
  expect(keys).toEqual([...live.map((r) => r.key), "198.51.100.2/sign-in/email"].sort());
});

describe("8. addLinks looks up existing links in one statement", () => {
  test("importing 100 URLs runs one owner-scoped lookup instead of one per URL, with the same dedupe", async () => {
    const urls = Array.from({ length: 100 }, (_, i) => `https://lookup.dev/${i}`);
    // B owns the same URLs: they never count as A's.
    expect((await send(B, "/import", "POST", { urls: urls.slice(0, 50) })).data.imported).toBe(50);
    // A already has 10 (one saved under a different original URL that resolved to this one).
    for (const url of urls.slice(0, 9)) db.sqlite.query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES(?,?,?,?,'lookup.dev','x','t')").run(crypto.randomUUID(), A.userId, url, url);
    db.sqlite.query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES(?,?,?,?,'lookup.dev','x','t')").run("resolved", A.userId, "https://short.dev/9", urls[9]!);
    const lookups: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => (/^SELECT id,.* FROM links WHERE user_id=\?1? AND \(original_url/.test(sql) && lookups.push(sql), prepare(sql))) as typeof db.prepare;
    const res = await send(A, "/import", "POST", { urls });
    db.prepare = prepare;
    expect([res.status, res.data.imported, res.data.duplicates]).toEqual([200, 90, 10]);
    expect(lookups.length).toBe(1);
    expect(n(`SELECT count(*) n FROM links WHERE user_id='${A.userId}'`)).toBe(100);
    expect(n(`SELECT count(*) n FROM links WHERE user_id='${B.userId}'`)).toBe(50);
    // The pre-existing links without content or jobs got their extraction queued once.
    expect(n(`SELECT count(*) n FROM jobs j JOIN links l ON l.id=j.link_id WHERE l.user_id='${A.userId}'`)).toBe(100);
  });
});
