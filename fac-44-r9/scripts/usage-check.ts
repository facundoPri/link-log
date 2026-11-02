// FAC-44 r9 item 4: Settings Usage summary vs a direct D1 count, for both accounts of a running instance.
//   bun usage-check.ts <run dir> <label>
// Web + every key must equal month.links, month.links must equal D1's count of the month's links,
// and each key's (and Web's) count must equal a creator attribution computed here in JS from raw
// links/jobs/batches rows (creating batch = extract batch with created_at equal to the link's).
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [runDir, label = "usage"] = process.argv.slice(2);
if (!runDir) throw new Error("usage: bun usage-check.ts <run dir> <label>");
const session = JSON.parse(readFileSync(join(runDir, "session.json"), "utf8"));
const d1Dir = join(runDir, "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
const db = new Database(join(d1Dir, readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!), { readonly: true });
const out: any = { instance: session.ui, commit: session.commit, at: new Date().toISOString(), accounts: [] };
let failed = 0;

for (const acct of session.accounts) {
  const s = await (await fetch(`${session.ui}/api/usage/summary`, { headers: { cookie: acct.cookie } })).json();
  const uid = (db.query("SELECT id FROM user WHERE email=?").get(acct.email) as any).id;
  const end = new Date(new Date(s.month.start).setUTCMonth(new Date(s.month.start).getUTCMonth() + 1)).toISOString();
  const links = db.query("SELECT id,created_at FROM links WHERE user_id=? AND created_at>=? AND created_at<?").all(uid, s.month.start, end) as any[];
  const batches = db.query("SELECT b.id,b.created_at,b.config,j.link_id FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE b.user_id=? AND b.kind='extract'").all(uid) as any[];
  const byLink = new Map<string, any[]>();
  for (const b of batches) byLink.set(b.link_id, [...(byLink.get(b.link_id) ?? []), b]);
  const mine: Record<string, number> = {};
  for (const l of links) {
    const creating = (byLink.get(l.id) ?? []).filter((b) => b.created_at === l.created_at).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    const keyId = creating ? (JSON.parse(creating.config ?? "{}").apiKeyId ?? "web") : "web";
    mine[keyId] = (mine[keyId] ?? 0) + 1;
  }
  const keySum = s.month.apiKeys.reduce((n: number, k: any) => n + k.links, 0);
  const summaryByKey = Object.fromEntries(s.month.apiKeys.map((k: any) => [k.id, k.links]));
  const checks = {
    webPlusKeysEqualsTotal: s.month.web + keySum === s.month.links,
    totalEqualsD1Count: s.month.links === links.length,
    webEqualsD1Attribution: s.month.web === (mine.web ?? 0),
    everyKeyEqualsD1Attribution: JSON.stringify(Object.entries(summaryByKey).sort()) === JSON.stringify(Object.entries(mine).filter(([k]) => k !== "web").sort()),
  };
  for (const [name, ok] of Object.entries(checks)) {
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"} [${label} ${acct.email}] ${name}`);
  }
  console.log(`      total ${s.month.links} = web ${s.month.web} + keys ${keySum} (${s.month.apiKeys.length} key rows); D1 month links ${links.length}; D1 web ${mine.web ?? 0}`);
  out.accounts.push({ email: acct.email, month: { start: s.month.start, links: s.month.links, web: s.month.web, apiKeys: s.month.apiKeys }, d1: { monthLinks: links.length, attribution: mine }, checks });
}
writeFileSync(join(import.meta.dir, `${label}.json`), JSON.stringify(out, null, 2));
process.exit(failed ? 1 : 0);
