// FAC-46: 0029 lets a job outlive its link. Deleting a link keeps its jobs (link_id becomes NULL, the title stays in
// link_title) so Activity can still show them. The rebuild keeps every job, usage row and lease, with their links.
import { expect, test } from "bun:test";
import { TestD1 } from "./support/d1";

async function seeded() {
  const db = new TestD1();
  await db.migrate("0028");
  db.sqlite.exec(`
    INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('u1','U','u1@example.test',1,'t','t'),('u2','V','u2@example.test',1,'t','t');
    INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES('l1','u1','https://a.example/','https://a.example/','a.example','A','t'),('l2','u2','https://b.example/','https://b.example/','b.example','B','t');
    INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('b1','u1','extract','{}','t'),('b2','u1','browser-lens','{}','t');
    INSERT INTO jobs(id,batch_id,link_id,status,step,created_at,jev_call,started_at) VALUES('j1','b1','l1','running','Extracting content','t','call-1',5);
    INSERT INTO browser_requests(request_id,payload_hash,kind,batch_id,library_id,session_id,created_at,user_id) VALUES('r1','h','lens','b2','lib','s','t','u1');
    INSERT INTO browser_targets(id,request_id,target_key,url,title,capture_meta,created_at) VALUES('bt1','r1','k','https://tab.example/','Tab','{}','t');
    INSERT INTO jobs(id,batch_id,target_id,status,created_at) VALUES('j2','b2','bt1','done','t');
    INSERT INTO usage_events(id,user_id,batch_id,job_id,link_id,provider,service,operation,status,created_at) VALUES('e1','u1','b1','j1','l1','cloudflare','browser','markdown','started','t');
    INSERT INTO provider_leases(job_id,expires_at,pool) VALUES('j1',9,'browser');
  `);
  await db.migrate("9999", "0028");
  return db.sqlite;
}

test("the rebuild keeps jobs, usage and leases with their relations", async () => {
  const db = await seeded();
  expect(db.query("SELECT id,batch_id,link_id,target_id,status,step,jev_call,started_at,link_title FROM jobs ORDER BY id").all()).toEqual([
    { id: "j1", batch_id: "b1", link_id: "l1", target_id: null, status: "running", step: "Extracting content", jev_call: "call-1", started_at: 5, link_title: null },
    { id: "j2", batch_id: "b2", link_id: null, target_id: "bt1", status: "done", step: "En cola", jev_call: null, started_at: null, link_title: null },
  ]);
  expect(db.query("SELECT job_id,link_id FROM usage_events").get()).toEqual({ job_id: "j1", link_id: "l1" });
  expect(db.query("SELECT job_id,pool FROM provider_leases").get()).toEqual({ job_id: "j1", pool: "browser" });
});

test("deleting a link keeps its jobs, detached; deleting a batch still removes them", async () => {
  const db = await seeded();
  db.exec("DELETE FROM provider_leases; UPDATE jobs SET status='failed' WHERE id='j1'");
  db.exec("DELETE FROM links WHERE id='l1'");
  expect(db.query("SELECT id,link_id FROM jobs WHERE id='j1'").get()).toEqual({ id: "j1", link_id: null });
  expect(db.query("SELECT job_id,link_id FROM usage_events").get()).toEqual({ job_id: "j1", link_id: null });
  db.exec("DELETE FROM batches WHERE id='b1'");
  expect(db.query("SELECT count(*) n FROM jobs WHERE id='j1'").get()).toEqual({ n: 0 });
});

test("owner and shape guards survive the rebuild", async () => {
  const db = await seeded();
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,link_id,created_at) VALUES('x','b1','l2','t')")).toThrow(/cross-owner/);
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,link_id,target_id,created_at) VALUES('y','b2','l1','bt1','t')")).toThrow(/CHECK/);
  expect(() => db.exec("INSERT INTO usage_events(id,user_id,provider,service,operation,status,created_at) VALUES('e2',NULL,'p','s','o','x','t')")).toThrow(/owner required/);
  db.exec("UPDATE jobs SET status='done' WHERE id='j1'");
  db.exec("INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('j3','b1','l1','queued','t')");
  expect(() => db.exec("INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('j4','b1','l1','queued','t')")).toThrow(/UNIQUE/);
});

test("the rollback restores the old schema and drops only jobs of deleted links", async () => {
  const db = await seeded();
  db.exec("UPDATE jobs SET status='failed' WHERE id='j1'; DELETE FROM provider_leases; DELETE FROM links WHERE id='l1'");
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT)");
  db.exec(await Bun.file("scripts/migrations/rollback/0029_jobs_outlive_links.down.sql").text());
  expect(db.query("SELECT id FROM jobs").all()).toEqual([{ id: "j2" }]);
  expect(db.query("SELECT job_id FROM usage_events").get()).toEqual({ job_id: null });
  expect((db.query("SELECT sql FROM sqlite_master WHERE name='jobs'").get() as { sql: string }).sql).toContain("ON DELETE CASCADE,\n  status");
});
