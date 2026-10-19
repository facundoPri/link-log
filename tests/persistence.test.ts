import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { evaluationStatements } from "../worker/ai/persist";
import type { Tag } from "../src/types";

test("hidden related links survive content changes and disappear with their parent", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(await Bun.file("migrations/0001_library.sql").text());
  db.exec(await Bun.file("migrations/0009_hidden_related_links.sql").text());
  db.exec("INSERT INTO links(id,original_url,url,domain,title,created_at) VALUES('source','https://example.com','https://example.com','example.com','Source','now')");
  db.prepare("INSERT INTO hidden_related_links(link_id,url,hidden_at) VALUES(?,?,?)")
    .run("source", "https://project.example/", "now");
  db.exec("UPDATE links SET title='Updated' WHERE id='source'");
  expect(db.query("SELECT url FROM hidden_related_links WHERE link_id='source'").all()).toEqual([{ url: "https://project.example/" }]);
  db.exec("DELETE FROM links WHERE id='source'");
  expect(db.query("SELECT url FROM hidden_related_links").all()).toEqual([]);
  db.close();
});

test("successful autotag replaces manual assignments, retains rejected scores, and uses the run snapshot", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  for (const file of [...new Bun.Glob("migrations/*.sql").scanSync()].sort())
    sqlite.exec(await Bun.file(file).text());
  sqlite.exec(
    `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('owner','A','a@example.test',1,'now','now'),('other','B','b@example.test',1,'now','now');
     INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES('link','owner','https://example.com','https://example.com','example.com','Example','now');
     INSERT INTO tags(id,user_id,name) VALUES('ai','owner','AI'),('iot','owner','IoT');
     INSERT INTO link_tags(link_id,tag_id,origin) VALUES('link','iot','manual');
     INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('batch','owner','autotag','{}','now'); INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('job','batch','link','running','now')`,
  );
  const tags: Tag[] = [
    {
      id: "ai",
      name: "AI",
      description: "Artificial intelligence",
      threshold: 0.8,
      version: 1,
    },
    {
      id: "iot",
      name: "IoT",
      description: "Connected devices",
      threshold: 0.6,
      version: 1,
    },
  ];
  type Bound = { sql: string; params: unknown[] };
  const db = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({ sql, params }),
    }),
  } as unknown as D1Database;
  const run = (statements: D1PreparedStatement[]) =>
    sqlite.transaction(() => {
      for (const item of statements) {
        const { sql, params } = item as unknown as Bound;
        sqlite.prepare(sql).run(...(params as any[]));
      }
    })();
  const statements = evaluationStatements(
    db,
    { id: "link", content_version: 3 },
    "owner",
    tags,
    { ai: { type: "noul", noul: 0.8 }, iot: { type: "noul", noul: 0.45 } },
    "fixture-model",
    "batch",
    "now",
    "job",
  );
  run(statements);
  expect(sqlite.query("SELECT tag_id,origin FROM link_tags").all()).toEqual([
    { tag_id: "ai", origin: "auto" },
  ]);
  expect(
    sqlite
      .query(
        "SELECT tag_id,probability,threshold,content_version FROM tag_evaluations ORDER BY tag_id",
      )
      .all(),
  ).toEqual([
    { tag_id: "ai", probability: 0.8, threshold: 0.8, content_version: 3 },
    { tag_id: "iot", probability: 0.45, threshold: 0.6, content_version: 3 },
  ]);
  sqlite.exec(
    "UPDATE tags SET threshold=.9,description='changed',version=2 WHERE id='ai'",
  );
  expect(sqlite.query("SELECT tag_id FROM link_tags").all()).toEqual([
    { tag_id: "ai" },
  ]);
  expect(
    sqlite
      .query(
        "SELECT threshold,description FROM tag_evaluations WHERE tag_id='ai'",
      )
      .get(),
  ).toEqual({ threshold: 0.8, description: "Artificial intelligence" });
  expect(() =>
    evaluationStatements(
      db,
      { id: "link", content_version: 3 },
      "owner",
      tags,
      { ai: { type: "noul", noul: 0.2 } },
      "fixture",
      "batch",
      "now",
    "job",
    ),
  ).toThrow();
  expect(sqlite.query("SELECT tag_id FROM link_tags").all()).toEqual([
    { tag_id: "ai" },
  ]);
  const invalid = evaluationStatements(
    db,
    { id: "link", content_version: 3 },
    "owner",
    tags,
    { ai: { type: "noul", noul: 0.2 }, iot: { type: "noul", noul: 0.99 } },
    "fixture",
    "missing-batch",
    "now",
    "job",
  );
  expect(() => run(invalid)).toThrow();
  expect(sqlite.query("SELECT tag_id FROM link_tags").all()).toEqual([
    { tag_id: "ai" },
  ]);
  // A batch owned by someone else can neither clear nor write this owner's tags and scores.
  run(
    evaluationStatements(
      db,
      { id: "link", content_version: 4 },
      "other",
      tags,
      { ai: { type: "noul", noul: 0.99 }, iot: { type: "noul", noul: 0.99 } },
      "fixture",
      "batch",
      "now",
    "job",
    ),
  );
  expect(sqlite.query("SELECT tag_id FROM link_tags").all()).toEqual([
    { tag_id: "ai" },
  ]);
  expect(sqlite.query("SELECT count(*) c FROM tag_evaluations WHERE content_version=4").get()).toEqual({ c: 0 });
  sqlite.close();
});
