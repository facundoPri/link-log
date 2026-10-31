// FAC-44 round 5: GET /api/api-keys against the apikey rows in D1 for both accounts (name, prefix, status = enabled, nothing extra exposed), with each row's replacedBy marker.
// Usage: bun list-vs-d1.ts --session <run>/session.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const session = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--session") + 1]!, "utf8"));
const dir = join(session.runDir, "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
const db = join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!);
const sql = (q: string) => JSON.parse(Bun.spawnSync(["sqlite3", "-json", "-cmd", ".timeout 5000", db, q]).stdout.toString() || "[]");
let ok = true;
for (const acct of session.accounts as { email: string; cookie: string }[]) {
  const r = await fetch(`${session.api}/api/api-keys`, { headers: { cookie: acct.cookie } });
  const list = (await r.json()).apiKeys as any[];
  const rows = sql(`SELECT k.id,k.name,k.start,k.enabled,json_extract(k.metadata,'$.replacedBy') replacedBy FROM apikey k JOIN user u ON u.id=k.referenceId WHERE u.email='${acct.email}'`);
  const bad = rows.filter((row: any) => { const k = list.find((x) => x.id === row.id); return !k || k.name !== row.name || k.prefix !== row.start || k.status !== (row.enabled ? "active" : "revoked"); });
  const extra = list.filter((k) => Object.keys(k).sort().join() !== "createdAt,id,lastUsedAt,name,prefix,status");
  const pass = r.status === 200 && list.length === rows.length && bad.length === 0 && extra.length === 0;
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"} ${acct.email}: status ${r.status}, listed ${list.length}, d1 ${rows.length}, mismatched ${bad.length}, extra fields ${extra.length}`);
  for (const row of rows) console.log(`  ${row.name.padEnd(16)} ${row.start} enabled=${row.enabled} listed=${list.find((x) => x.id === row.id)?.status} replacedBy=${row.replacedBy ?? "-"}`);
}
process.exit(ok ? 0 : 1);
