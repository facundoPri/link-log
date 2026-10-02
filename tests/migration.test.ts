// Existing (pre-FAC-41) data survives 0010/0011 unassigned and unreachable, the local adjudication
// tool assigns it only to a verified user, and the rollback script restores the old schema.
import { describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { assign, conflicts, inventory } from "../scripts/adjudicate-legacy";
import type { Library } from "../src/types";

const TABLES = ["links", "tags", "link_tags", "batches", "jobs", "tag_evaluations", "usage_events", "lenses", "lens_results", "media_items", "hidden_related_links", "provider_leases", "settings"];

async function legacyDatabase() {
  const db = new TestD1();
  await db.migrate("0009");
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
  `);
  return db;
}
const counts = (db: TestD1) =>
  Object.fromEntries(TABLES.map((t) => [t, (db.sqlite.query(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c]));
const snapshot = (db: TestD1) =>
  // prepare(), not query(): query() caches statements and would reuse the pre-rebuild column list.
  TABLES.filter((t) => t !== "settings").map((t) => db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()).map((rows) =>
    (rows as Record<string, unknown>[]).map(({ user_id: _u, ...rest }) => rest),
  );

describe("0010 + 0011 on existing data", () => {
  test("keeps every row, relation and value; leaves owners NULL; integrity holds", async () => {
    const db = await legacyDatabase();
    const before = counts(db);
    const rowsBefore = JSON.stringify(snapshot(db));
    await db.migrate(undefined, "0009");
    expect(counts(db)).toEqual(before);
    expect(JSON.stringify(snapshot(db))).toBe(rowsBefore);
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    for (const t of ["links", "tags", "lenses", "batches", "usage_events"])
      expect(db.sqlite.query(`SELECT count(*) c FROM ${t} WHERE user_id IS NOT NULL`).get()).toEqual({ c: 0 });
  });

  test("unassigned rows are invisible to every user, including the first signup", async () => {
    const db = await legacyDatabase();
    await db.migrate(undefined, "0009");
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
    await db.migrate(undefined, "0009");
    const { env } = makeEnv(db);
    return { db, env, call: client(env) };
  }

  test("dry run changes nothing; assign moves everything to one verified user with relations intact", async () => {
    const { db, env, call } = await migrated();
    const owner = await testSession(env, "owner@example.test");
    const other = await testSession(env, "other@example.test");
    const inv = inventory(db.sqlite);
    expect(inv.counts).toMatchObject({ links: 2, tags: 1, lenses: 1, batches: 1, usage_events: 1, link_tags: 1, jobs: 1, "links with R2 content": 1 });
    expect(inv.users.map((u) => u.email).sort()).toEqual(["other@example.test", "owner@example.test"]);

    const dry = assign(db.sqlite, owner.userId, "owner@example.test", true);
    expect(dry.moved).toMatchObject({ links: 2, tags: 1, lenses: 1, batches: 1, usage_events: 1 });
    expect(inventory(db.sqlite).counts.links).toBe(2);

    expect(() => assign(db.sqlite, owner.userId, "someone@else.test", false)).toThrow("does not match");
    const result = assign(db.sqlite, owner.userId, "OWNER@example.test", false);
    expect(result.after).toMatchObject({ links: 0, tags: 0, lenses: 0, batches: 0, usage_events: 0 });

    const lib = (await (await call("/api/library", { cookie: owner.cookie })).json()) as Library;
    expect(lib.links.map((l) => l.id).sort()).toEqual(["l1", "l2"]);
    const l1 = lib.links.find((l) => l.id === "l1")!;
    expect(l1.tags.map((t) => t.name)).toEqual(["ai"]);
    expect(l1.evaluations.length).toBe(1);
    expect(l1.lens_results.length).toBe(1);
    expect(l1.media?.length).toBe(1);
    expect(l1.hidden_related_urls).toEqual(["https://hidden.example/"]);
    expect(lib.batches.map((b) => b.id)).toEqual(["b1"]);
    expect(db.sqlite.query("SELECT value FROM user_settings WHERE user_id=?").get(owner.userId)).toEqual({ value: "dark" });
    // Legacy R2 keys stay valid for the new owner; the other user still sees nothing.
    expect((await (await call("/api/links/l1/content", { cookie: owner.cookie })).json()) as object).toEqual({ markdown: "" });
    expect(((await (await call("/api/library", { cookie: other.cookie })).json()) as Library).links).toEqual([]);
    // A second run has nothing left to move, and owners cannot be reassigned.
    expect(assign(db.sqlite, other.userId, "other@example.test", false).moved.links).toBe(0);
    expect(() => db.sqlite.query("UPDATE links SET user_id=? WHERE id='l1'").run(other.userId)).toThrow("immutable");
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
  const down = () => Bun.file("scripts/migrations/rollback/0011_ownership.down.sql").text();

  test("restores the pre-0011 schema with every row when one owner exists", async () => {
    const db = await legacyDatabase();
    const before = counts(db);
    const rowsBefore = JSON.stringify(snapshot(db));
    await db.migrate(undefined, "0009");
    db.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)");
    db.sqlite.exec(await down());
    expect(counts(db)).toEqual(before);
    expect(JSON.stringify(snapshot(db))).toBe(rowsBefore);
    expect((db.sqlite.query("PRAGMA table_info(links)").all() as { name: string }[]).some((c) => c.name === "user_id")).toBe(false);
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    // Global uniqueness is back.
    expect(() => db.sqlite.exec("INSERT INTO links(id,original_url,url,domain,title,created_at) VALUES('dup','https://a.example/','x','x','x','now')")).toThrow("UNIQUE");
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
