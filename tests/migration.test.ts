// Existing (pre-FAC-41) data, including Browser rows from 0010/0011, survives 0012/0013 unassigned and unreachable, the local adjudication
// tool assigns it only to a verified user, and the rollback script restores the old schema.
import { describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { assign, conflicts, inventory } from "../scripts/adjudicate-legacy";
import type { Library } from "../src/types";

const TABLES = ["links", "tags", "link_tags", "batches", "jobs", "tag_evaluations", "usage_events", "lenses", "lens_results", "media_items", "hidden_related_links", "provider_leases", "browser_requests", "browser_targets", "browser_groups", "settings"];

async function legacyDatabase() {
  const db = new TestD1();
  await db.migrate("0011");
  db.sqlite.exec(`
    INSERT INTO links(id,original_url,url,domain,title,created_at,content_key,content_state,content_version) VALUES
      ('l1','https://a.example/','https://a.example/','a.example','A','2026-01-01','links/l1/c.md','ready',1),
      ('l2','https://b.example/','https://b.example/','b.example','B','2026-01-02',NULL,'missing',0);
    INSERT INTO tags(id,name,description) VALUES('t1','ai','AI things');
    INSERT INTO link_tags VALUES('l1','t1','auto');
    INSERT INTO batches VALUES('b1','autotag','{"tags":[]}','2026-01-03');
    INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('j1','b1','l1','done','2026-01-03');
    INSERT INTO tag_evaluations(link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id) VALUES('l1','t1',0.9,0.8,1,'AI things',1,'m','2026-01-03','b1');
    INSERT INTO usage_events(id,batch_id,job_id,link_id,provider,service,operation,status,created_at,input_tokens) VALUES('u1','b1','j1','l1','typesafe','jev','classify','done','2026-01-03',500);
    INSERT INTO lenses(id,name,type,question,created_at) VALUES('le1','Read later','noul','?','2026-01-04');
    INSERT INTO lens_results VALUES('l1','le1','{"noul":0.7}',1,1,'m','2026-01-04','b1');
    INSERT INTO media_items(link_id,media_key,position,kind,url,updated_at) VALUES('l1','m1',0,'image','https://img.example/1.jpg','2026-01-04');
    INSERT INTO hidden_related_links VALUES('l1','https://hidden.example/','2026-01-04');
    INSERT INTO provider_leases VALUES('j1',1,'browser');
    INSERT INTO settings VALUES('theme','dark');
    INSERT INTO settings VALUES('library_id','legacy-library');
    INSERT INTO lenses(id,name,type,question,created_at,scope) VALUES('le2','Tab triage','noul','?','2026-01-05','browser');
    INSERT INTO batches VALUES('b2','browser-lens','{"browser":true}','2026-01-05');
    INSERT INTO browser_requests VALUES('r1','hash','lens','b2','legacy-library','s1','2026-01-05');
    INSERT INTO browser_targets(id,request_id,target_key,url,title,capture_key,capture_meta,answer,model,evaluated_at,created_at) VALUES('bt1','r1','k1','https://tab.example/','Tab','browser/r1/1.md','{}','{"noul":0.4}','m','2026-01-05','2026-01-05');
    INSERT INTO jobs(id,batch_id,target_id,status,created_at) VALUES('j2','b2','bt1','done','2026-01-05');
    INSERT INTO usage_events(id,batch_id,job_id,link_id,provider,service,operation,status,created_at,input_tokens) VALUES('u2','b2','j2',NULL,'typesafe','jev','classify','done','2026-01-05',50);
    INSERT INTO browser_groups(id,name,description,color,created_at,updated_at) VALUES('g1','Work','Work tabs','blue','2026-01-05','2026-01-05');
  `);
  return db;
}
const counts = (db: TestD1) =>
  Object.fromEntries(TABLES.map((t) => [t, (db.sqlite.query(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c]));
const snapshot = (db: TestD1) =>
  // prepare(), not query(): query() caches statements and would reuse the pre-rebuild column list.
  TABLES.filter((t) => t !== "settings").map((t) => db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).map((rows) =>
    (rows as Record<string, unknown>[]).map(({ user_id: _u, last_saved_at: _saved, original_metadata: _preview, metadata_error: _error, ...rest }) => rest),
  );

describe("0012 + 0013 on existing data", () => {
  test("keeps every row, relation and value; leaves owners NULL; integrity holds", async () => {
    const db = await legacyDatabase();
    const before = counts(db);
    const rowsBefore = JSON.stringify(snapshot(db));
    await db.migrate("0017", "0011");
    expect(counts(db)).toEqual(before);
    expect(db.sqlite.query("SELECT count(*) n FROM links WHERE last_saved_at IS NOT NULL").get()).toEqual({ n: 0 });
    expect(JSON.stringify(snapshot(db))).toBe(rowsBefore);
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    for (const t of ["links", "tags", "lenses", "batches", "usage_events", "browser_requests", "browser_groups"])
      expect(db.sqlite.query(`SELECT count(*) c FROM ${t} WHERE user_id IS NOT NULL`).get()).toEqual({ c: 0 });
  });

  test("the final schema references no temporary *_next/*_prev tables", async () => {
    const db = await TestD1.migrated();
    const stale = db.sqlite.query("SELECT name FROM sqlite_master WHERE sql LIKE '%\\_next%' ESCAPE '\\' OR sql LIKE '%\\_prev%' ESCAPE '\\'").all();
    expect(stale).toEqual([]);
  });

  test("unassigned rows are invisible to every user, including the first signup", async () => {
    const db = await legacyDatabase();
    await db.migrate(undefined, "0011");
    const { env } = makeEnv(db);
    const call = client(env);
    const first = await testSession(env, "first@example.test");
    const lib = (await (await call("/api/library", { cookie: first.cookie })).json()) as Library;
    expect([lib.links, lib.tags, lib.lenses, lib.batches]).toEqual([[], [], [], []]);
    expect((await call("/api/links/l1/content", { cookie: first.cookie })).status).toBe(404);
    expect((await call("/api/batches/b1", { cookie: first.cookie })).status).toBe(404);
    expect((await call("/api/tags/t1", { cookie: first.cookie, body: {}, method: "DELETE" })).status).toBe(404);
    const usage = (await (await call("/api/usage", { cookie: first.cookie })).json()) as { events: unknown[] };
    expect(usage.events).toEqual([]);
    // Saving the same URL creates the user's own row; the legacy one is untouched.
    const created = (await (await call("/api/links", { cookie: first.cookie, body: { url: "https://a.example/" } })).json()) as { id: string };
    expect(created.id).not.toBe("l1");
    expect(db.sqlite.query("SELECT user_id FROM links WHERE id='l1'").get()).toEqual({ user_id: null });
  });
});

describe("local adjudication", () => {
  async function migrated() {
    const db = await legacyDatabase();
    await db.migrate(undefined, "0011");
    const { env } = makeEnv(db);
    return { db, env, call: client(env) };
  }

  test("dry run changes nothing; assign moves everything to one verified user with relations intact", async () => {
    const { db, env, call } = await migrated();
    const owner = await testSession(env, "owner@example.test");
    const other = await testSession(env, "other@example.test");
    const inv = inventory(db.sqlite);
    expect(inv.counts).toMatchObject({ links: 2, tags: 1, lenses: 2, batches: 2, usage_events: 2, link_tags: 1, jobs: 2, browser_requests: 1, browser_targets: 1, browser_groups: 1, "links with R2 content": 1 });
    expect(inv.users.map((u) => u.email).sort()).toEqual(["other@example.test", "owner@example.test"]);

    const dry = assign(db.sqlite, owner.userId, "owner@example.test", true);
    expect(dry.moved).toMatchObject({ links: 2, tags: 1, lenses: 2, batches: 2, usage_events: 2, browser_requests: 1, browser_groups: 1 });
    expect(inventory(db.sqlite).counts.links).toBe(2);

    expect(() => assign(db.sqlite, owner.userId, "someone@else.test", false)).toThrow("does not match");
    const result = assign(db.sqlite, owner.userId, "OWNER@example.test", false);
    expect(result.after).toMatchObject({ links: 0, tags: 0, lenses: 0, batches: 0, usage_events: 0, browser_requests: 0, browser_groups: 0, browser_targets: 0 });

    const lib = (await (await call("/api/library", { cookie: owner.cookie })).json()) as Library;
    expect(lib.links.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
    const l1 = lib.links.find((l) => l.id === "l1")!;
    expect(l1.tags.map((t) => t.name)).toEqual(["ai"]);
    expect(l1.evaluations.length).toBe(1);
    expect(l1.lens_results.length).toBe(1);
    expect(l1.media?.length).toBe(1);
    expect(l1.hidden_related_urls).toEqual(["https://hidden.example/"]);
    expect(lib.batches.map((b) => b.id).sort()).toEqual(["b1", "b2"]);
    expect(db.sqlite.query("SELECT key,value FROM user_settings WHERE user_id=? ORDER BY key").all(owner.userId)).toEqual([
      { key: "library_id", value: "legacy-library" },
      { key: "theme", value: "dark" },
    ]);
    // Browser: the legacy library id (extension result scope), pinned groups and requests follow the owner.
    const catalog = (await (await call("/api/browser/catalog", { cookie: owner.cookie })).json()) as { libraryId: string; groups: { id: string }[] };
    expect(catalog.libraryId).toBe("legacy-library");
    expect(catalog.groups.map((g) => g.id)).toEqual(["g1"]);
    expect((await call("/api/browser/evaluations/r1", { cookie: owner.cookie })).status).toBe(200);
    expect((await call("/api/browser/evaluations/r1", { cookie: other.cookie })).status).toBe(404);
    // Legacy R2 keys stay valid for the new owner; the other user still sees nothing.
    expect((await (await call("/api/links/l1/content", { cookie: owner.cookie })).json()) as object).toEqual({ markdown: "" });
    expect(((await (await call("/api/library", { cookie: other.cookie })).json()) as Library).links).toEqual([]);
    // A second run has nothing left to move, and owners cannot be reassigned.
    expect(assign(db.sqlite, other.userId, "other@example.test", false).moved.links).toBe(0);
    expect(() => db.sqlite.query("UPDATE links SET user_id=? WHERE id='l1'").run(other.userId)).toThrow("immutable");
  });

  test("the legacy Browser library id goes to one owner only (R6)", async () => {
    const { db, env, call } = await migrated();
    const a = await testSession(env, "a@example.test");
    const b = await testSession(env, "b@example.test");
    const libraryIds = () => db.sqlite.query("SELECT user_id,value FROM user_settings WHERE key='library_id' ORDER BY user_id").all();
    // Dry run: no settings at all.
    assign(db.sqlite, a.userId, "a@example.test", true);
    expect(libraryIds()).toEqual([]);
    assign(db.sqlite, a.userId, "a@example.test", false);
    expect(libraryIds()).toEqual([{ user_id: a.userId, value: "legacy-library" }]);
    // A second adjudication (nothing left to move) never shares A's scope with B.
    expect(assign(db.sqlite, b.userId, "b@example.test", false).moved["legacy library id"]).toBe(0);
    const catB = (await (await call("/api/browser/catalog", { cookie: b.cookie })).json()) as { libraryId: string };
    expect(catB.libraryId).not.toBe("legacy-library");
    // Retrying A keeps A's identity; the database refuses a shared id outright.
    assign(db.sqlite, a.userId, "a@example.test", false);
    const catA = (await (await call("/api/browser/catalog", { cookie: a.cookie })).json()) as { libraryId: string };
    expect(catA.libraryId).toBe("legacy-library");
    expect(() =>
      db.sqlite.query("UPDATE user_settings SET value='legacy-library' WHERE user_id=? AND key='library_id'").run(b.userId),
    ).toThrow("UNIQUE");
  });

  test("a user who already had a library id keeps it; the legacy one is not handed to anyone later (R6)", async () => {
    const { db, env, call } = await migrated();
    const a = await testSession(env, "a@example.test");
    const b = await testSession(env, "b@example.test");
    const own = ((await (await call("/api/browser/catalog", { cookie: a.cookie })).json()) as { libraryId: string }).libraryId;
    assign(db.sqlite, a.userId, "a@example.test", false);
    assign(db.sqlite, b.userId, "b@example.test", false);
    const rows = db.sqlite.query("SELECT user_id,value FROM user_settings WHERE key='library_id'").all();
    expect(rows).toEqual([{ user_id: a.userId, value: own }]);
  });

  test("0014 de-duplicates a library id shared by an earlier adjudication, keeping the first holder", async () => {
    const db = new TestD1();
    await db.migrate("0013");
    const { env } = makeEnv(db);
    const a = await testSession(env, "a@example.test");
    const b = await testSession(env, "b@example.test");
    for (const who of [a, b])
      db.sqlite.query("INSERT INTO user_settings(user_id,key,value,updated_at) VALUES(?,'library_id','legacy-library','now')").run(who.userId);
    await db.migrate(undefined, "0013");
    expect(db.sqlite.query("SELECT user_id FROM user_settings WHERE key='library_id'").all()).toEqual([{ user_id: a.userId }]);
  });

  test("refuses unverified users and URL/name conflicts, writing nothing", async () => {
    const { db, env, call } = await migrated();
    const owner = await testSession(env, "owner@example.test");
    db.sqlite.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('unverified','u','u@example.test',0,'now','now')`).run();
    expect(() => assign(db.sqlite, "unverified", "u@example.test", false)).toThrow("not verified");
    await call("/api/links", { cookie: owner.cookie, body: { url: "https://a.example/", tags: ["AI"] } });
    expect(conflicts(db.sqlite, owner.userId).links.length).toBe(1);
    expect(() => assign(db.sqlite, owner.userId, "owner@example.test", false)).toThrow("Conflicts");
    expect(inventory(db.sqlite).counts.links).toBe(2);
  });
});

describe("rollback script", () => {
  const down = () => Bun.file("scripts/migrations/rollback/0013_ownership.down.sql").text();

  test("restores the pre-0013 schema with every row when one owner exists", async () => {
    const db = await legacyDatabase();
    const before = counts(db);
    const rowsBefore = JSON.stringify(snapshot(db));
    await db.migrate(undefined, "0011");
    db.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    db.sqlite.exec(await down());
    expect(counts(db)).toEqual(before);
    expect(JSON.stringify(snapshot(db))).toBe(rowsBefore);
    expect((db.sqlite.query("PRAGMA table_info(links)").all() as { name: string }[]).some((c) => c.name === "user_id")).toBe(false);
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // Global uniqueness is back.
    expect(() => db.sqlite.exec("INSERT INTO links(id,original_url,url,domain,title,created_at) VALUES('dup','https://a.example/','x','x','x','now')")).toThrow("UNIQUE");
  });

  test("0013 then 0012 rollback keeps every row (no cascade through leftover owner columns)", async () => {
    const db = await legacyDatabase();
    const before = counts(db);
    await db.migrate(undefined, "0011");
    const { env } = makeEnv(db);
    const owner = await testSession(env, "owner@example.test");
    assign(db.sqlite, owner.userId, "owner@example.test", false);
    db.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    db.sqlite.exec(await down());
    db.sqlite.exec(await Bun.file("scripts/migrations/rollback/0012_auth.down.sql").text());
    expect(counts(db)).toEqual(before);
    expect(db.sqlite.query("SELECT count(*) c FROM sqlite_master WHERE name='user'").get()).toEqual({ c: 0 });
  });

  test("aborts atomically when two owners share a URL", async () => {
    const db = await TestD1.migrated();
    const { env } = makeEnv(db);
    const call = client(env);
    for (const email of ["a@example.test", "b@example.test"]) {
      const s = await testSession(env, email);
      await call("/api/links", { cookie: s.cookie, body: { url: "https://same.example/" } });
    }
    db.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    const sql = await down();
    expect(() => db.sqlite.transaction(() => db.sqlite.exec(sql))()).toThrow();
    expect(db.sqlite.query("SELECT count(*) c FROM links WHERE user_id IS NOT NULL").get()).toEqual({ c: 2 });
  });
});
