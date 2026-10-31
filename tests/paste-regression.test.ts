import { expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";

test("re-saving existing links moves them beside new links, preserves metadata and queues only new extraction", async () => {
  const db = await TestD1.migrated();
  const { env, queued } = makeEnv(db);
  const user = await testSession(env, "paste@example.test");
  const other = await testSession(env, "other@example.test");
  const call = client(env);
  for (const [id, owner, url, date] of [
    ["old", user.userId, "https://example.com/old", "2026-01-01"],
    ["recent", user.userId, "https://example.com/recent", "2026-02-01"],
    ["foreign", other.userId, "https://example.com/old", "2026-01-01"],
  ]) {
    db.sqlite.query("INSERT INTO links(id,user_id,original_url,url,domain,title,image,created_at,content_key,content_state,status) VALUES(?,?,?,?,'example.com','Existing title','https://example.com/image.jpg',?,'existing.md','ready','ready')").run(id!, owner!, url!, url!, date!);
  }
  const response = await call("/api/import", { cookie: user.cookie, body: { urls: ["https://example.com/old", "https://example.com/new"] } });
  expect(response.status).toBe(200);
  const data = await response.json() as any;
  expect(data.imported).toBe(1);
  expect(data.duplicates).toBe(1);
  expect(data.links.slice(0, 2).map((l: any) => l.original_url).sort()).toEqual(["https://example.com/new", "https://example.com/old"]);
  expect(data.links.find((l: any) => l.id === "old")).toMatchObject({ title: "Existing title", image: "https://example.com/image.jpg", created_at: "2026-01-01", content_key: "existing.md" });
  expect(queued).toHaveLength(1);
  expect(db.sqlite.query("SELECT last_saved_at FROM links WHERE id='foreign'").get()).toEqual({ last_saved_at: null });
  const again = await call("/api/links", { cookie: user.cookie, body: { url: "https://example.com/old" } });
  expect((await again.json() as any).links[0].id).toBe("old");
  expect(queued).toHaveLength(1);
});

test("a failed mixed import also rolls back the recency change", async () => {
  const db = await TestD1.migrated();
  const { env } = makeEnv(db);
  const user = await testSession(env, "rollback@example.test");
  db.sqlite.query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at,last_saved_at,content_key) VALUES('old',?,'https://example.com/old','https://example.com/old','example.com','Old','2026-01-01','2026-02-01','old.md')").run(user.userId);
  db.sqlite.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const response = await client(env)("/api/import", { cookie: user.cookie, body: { urls: ["https://example.com/old", "https://example.com/new"] } });
  expect(response.status).toBe(500);
  expect(db.sqlite.query("SELECT id,last_saved_at FROM links").all()).toEqual([{ id: "old", last_saved_at: "2026-02-01" }]);
});

test("importing a long non-ASCII URL saves it, though its percent-encoded form passes 4096 characters", async () => {
  const db = await TestD1.migrated();
  const { env } = makeEnv(db);
  const user = await testSession(env, "long@example.test");
  const response = await client(env)("/api/import", { cookie: user.cookie, body: { urls: [`http://example.com/${"日".repeat(500)}`] } });
  expect(response.status).toBe(200);
  expect(((await response.json()) as any).imported).toBe(1);
});
