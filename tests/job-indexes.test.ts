// A link's active jobs (queued, running or waiting) are looked up on every library read and enqueue:
// that filter must use an index, never scan the whole jobs history.
import { Database } from "bun:sqlite";
import { readdirSync } from "fs";
import { expect, test } from "bun:test";
import { linkIdle } from "../worker/jobs";

test("the per-link active-job filters use an index", async () => {
  const db = new Database(":memory:");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) db.exec(await Bun.file(`migrations/${f}`).text());
  const plan = (sql: string) => (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail);
  for (const sql of [
    `SELECT 1 WHERE ${linkIdle}`,
    "SELECT l.id,(SELECT b.kind FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=l.id AND j.status IN ('queued','running','waiting') ORDER BY j.status='waiting',j.created_at LIMIT 1) FROM links l",
    "SELECT id,EXISTS (SELECT 1 FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.link_id=links.id AND j.status IN ('queued','running','waiting') AND b.kind='extract') FROM links WHERE id IN (?)",
  ]) {
    const steps = plan(sql);
    expect(steps.some((d) => /^SCAN (jobs|j)\b/.test(d))).toBe(false);
    expect(steps.some((d) => /SEARCH (jobs|j) USING (COVERING )?INDEX jobs_link_status/.test(d))).toBe(true);
  }
});
