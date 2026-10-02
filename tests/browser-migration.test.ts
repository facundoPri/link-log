import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { expect, test } from "bun:test";

const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "0010");
const browser = files.find((f) => f.startsWith("0010"))!;

async function migrated(seed: (db: Database) => void) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of before) db.exec(await Bun.file(`migrations/${file}`).text());
  seed(db);
  // D1 applies each migration file in a transaction.
  const sql = await Bun.file(`migrations/${browser}`).text();
  db.transaction(() => db.exec(sql))();
  return db;
}

function seedLibrary(db: Database) {
  db.exec(`
    INSERT INTO links(id,original_url,url,domain,title,created_at) VALUES('l1','https://a.example/','https://a.example/','a.example','A','t'),('l2','https://b.example/','https://b.example/','b.example','B','t');
    INSERT INTO tags(id,name) VALUES('t1','ai');
    INSERT INTO link_tags(link_id,tag_id) VALUES('l1','t1');
    INSERT INTO batches(id,kind,config,created_at) VALUES('b1','lens','{}','t');
    INSERT INTO lenses(id,name,type,question,created_at) VALUES('lens1','Relevant','noul','Is it relevant?','t');
    INSERT INTO lens_results(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id) VALUES('l1','lens1','{"type":"noul","noul":0.9}',1,1,'m','t','b1');
    INSERT INTO jobs(id,batch_id,link_id,status,step,created_at) VALUES('j1','b1','l1','done','Done','t'),('j2','b1','l2','running','Evaluating','t');
    INSERT INTO usage_events(id,batch_id,job_id,link_id,provider,service,operation,status,input_tokens,created_at) VALUES('u1','b1','j1','l1','typesafe','jev','classify','done',120,'t'),('u2','b1','j2','l2','typesafe','jev','classify','started',null,'t');
    INSERT INTO provider_leases(job_id,expires_at,pool) VALUES('j2',99,'jev');
  `);
}

test("0010 keeps library, jobs, usage and leases while allowing browser targets", async () => {
  const db = await migrated(seedLibrary);
  expect(db.query("SELECT count(*) n FROM links").get()).toEqual({ n: 2 });
  expect(db.query("SELECT count(*) n FROM lens_results").get()).toEqual({ n: 1 });
  expect(db.query("SELECT count(*) n FROM link_tags").get()).toEqual({ n: 1 });
  expect(db.query("SELECT id,link_id,status,target_id FROM jobs ORDER BY id").all()).toEqual([
    { id: "j1", link_id: "l1", status: "done", target_id: null },
    { id: "j2", link_id: "l2", status: "running", target_id: null },
  ]);
  // usage_events.job_id must not be nulled by dropping the old jobs table
  expect(db.query("SELECT id,job_id,input_tokens FROM usage_events ORDER BY id").all()).toEqual([
    { id: "u1", job_id: "j1", input_tokens: 120 },
    { id: "u2", job_id: "j2", input_tokens: null },
  ]);
  expect(db.query("SELECT job_id,pool FROM provider_leases").all()).toEqual([{ job_id: "j2", pool: "jev" }]);
  expect(db.query("SELECT scope FROM lenses").get()).toEqual({ scope: "library" });
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  // foreign keys still point at the rebuilt table
  const fk = db.query("PRAGMA foreign_key_list(usage_events)").all() as { table: string }[];
  expect(fk.map((f) => f.table).sort()).toEqual(["batches", "jobs", "links"]);
  db.close();
});

test("browser jobs need no link row and keep cascading and active-job uniqueness", async () => {
  const db = await migrated(seedLibrary);
  db.exec(`
    INSERT INTO batches(id,kind,config,created_at) VALUES('b2','browser-lens','{}','t');
    INSERT INTO browser_requests(request_id,payload_hash,kind,batch_id,library_id,session_id,created_at) VALUES('r1','h','lens','b2','lib','s','t');
    INSERT INTO browser_targets(id,request_id,target_key,url,title,capture_meta,created_at) VALUES('bt1','r1','k1','https://c.example/','C','{}','t');
    INSERT INTO jobs(id,batch_id,target_id,created_at) VALUES('j3','b2','bt1','t');
  `);
  expect(db.query("SELECT count(*) n FROM links").get()).toEqual({ n: 2 });
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,target_id,created_at) VALUES('j4','b2','bt1','t')")).toThrow();
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,created_at) VALUES('j5','b2','t')")).toThrow();
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,link_id,target_id,created_at) VALUES('j6','b2','l1','bt1','t')")).toThrow();
  // a second active job for the same link is still rejected
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES('j7','b2','l2','t')")).toThrow();
  // deleting a link still removes its jobs and nulls usage references
  db.exec("DELETE FROM links WHERE id='l1'");
  expect(db.query("SELECT count(*) n FROM jobs WHERE link_id='l1'").get()).toEqual({ n: 0 });
  expect(db.query("SELECT job_id,link_id FROM usage_events WHERE id='u1'").get()).toEqual({ job_id: null, link_id: null });
  db.close();
});

test("a failing statement rolls the whole migration back", async () => {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const file of before) db.exec(await Bun.file(`migrations/${file}`).text());
  seedLibrary(db);
  const sql = (await Bun.file(`migrations/${browser}`).text()) + "\nSELECT * FROM missing_table;";
  expect(() => db.transaction(() => db.exec(sql))()).toThrow();
  expect(db.query("SELECT name FROM sqlite_master WHERE name='browser_targets'").get()).toBeNull();
  expect(db.query("SELECT count(*) n FROM usage_events WHERE job_id IS NOT NULL").get()).toEqual({ n: 2 });
  db.close();
});
