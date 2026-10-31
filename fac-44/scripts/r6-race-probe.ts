// FAC-44 round 6: two concurrent regenerates of one key at 10 active, 5 trials, with exact D1 accounting.
// A logging trigger on apikey (insert/update/delete) records the user's enabled-key count after every write,
// so a transient 11th enabled row is seen even if it lives for a millisecond. Four parallel samplers read
// GET /api/api-keys during each pair so a listed 11th key would also show. Then every listed active key's
// count is checked and the loser's replacement row must be gone.
// Usage: bun r6-race-probe.ts --session <run>/session.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const session = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--session") + 1]!, "utf8"));
const dir = join(session.runDir, "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
const db = join(dir, readdirSync(dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!);
const sql = (q: string) => {
  const p = Bun.spawnSync(["sqlite3", "-json", "-cmd", ".timeout 5000", db, q]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString() || "[]");
};
const A = session.accounts[0];
const userA = sql(`SELECT id FROM user WHERE email='${A.email}'`)[0].id;
const api = async (method: string, path: string) => {
  const r = await fetch(`${session.ui}/api${path}`, { method, headers: { cookie: A.cookie, ...(method === "GET" ? {} : { origin: session.ui, "content-type": "application/json" }) }, body: method === "GET" ? undefined : "{}" });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const create = async (name: string) => {
  const r = await fetch(`${session.ui}/api/api-keys`, { method: "POST", headers: { cookie: A.cookie, origin: session.ui, "content-type": "application/json" }, body: JSON.stringify({ name }) });
  return { status: r.status, body: await r.json() };
};
const submit = async (secret: string) => (await fetch(`${session.ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls: ["probe, no link"] }) })).status;

sql(`CREATE TABLE IF NOT EXISTS r6_log(ev TEXT, keyId TEXT, n INTEGER, at TEXT DEFAULT (strftime('%Y-%m-%d %H:%M:%f','now')))`);
for (const [ev, ref] of [["INSERT", "new"], ["UPDATE", "new"], ["DELETE", "old"]] as const)
  sql(`CREATE TRIGGER IF NOT EXISTS r6_log_${ev.toLowerCase()} AFTER ${ev} ON apikey WHEN ${ref}.referenceId='${userA}' BEGIN INSERT INTO r6_log(ev,keyId,n) SELECT '${ev}', ${ref}.id, count(*) FROM apikey WHERE referenceId='${userA}' AND enabled=1; END`);

const RUN = `p${Date.now().toString(36)}`;
let allOk = true;
try {
  for (let trial = 1; trial <= 5; trial++) {
    const act = (await api("GET", "/api-keys")).body.apiKeys.filter((k: any) => k.status === "active");
    for (const k of act.slice(0, Math.max(0, act.length - 9))) await api("POST", `/api-keys/${k.id}/revoke`);
    const k = await create(`R6 probe ${trial} ${RUN}`);
    if (k.status !== 201) throw new Error(`create ${k.status} ${JSON.stringify(k.body)}`);
    const activeBefore = (await api("GET", "/api-keys")).body.apiKeys.filter((x: any) => x.status === "active").length;
    const mark = sql(`SELECT coalesce(max(rowid),0) m FROM r6_log`)[0].m;
    let sampling = true;
    const samples: number[] = [];
    const samplers = Array.from({ length: Number(process.env.SAMPLERS ?? 4) }, async () => {
      while (sampling) samples.push((await api("GET", "/api-keys")).body.apiKeys.filter((x: any) => x.status === "active").length);
    });
    await Bun.sleep(30);
    const regen = await Promise.all([0, 1].map(() => api("POST", `/api-keys/${k.body.apiKey.id}/regenerate`)));
    await Bun.sleep(50);
    sampling = false;
    await Promise.all(samplers);
    const log = sql(`SELECT ev,keyId,n,at FROM r6_log WHERE rowid>${mark} ORDER BY rowid`);
    const won = regen.filter((r) => r.status === 201);
    const lost = regen.filter((r) => r.status !== 201);
    const newId = won[0]?.body.apiKey.id;
    const rows = sql(`SELECT id,enabled FROM apikey WHERE referenceId='${userA}' AND name='R6 probe ${trial} ${RUN}'`);
    const inserted = [...new Set(log.filter((l: any) => l.ev === "INSERT").map((l: any) => l.keyId))];
    const deleted = log.filter((l: any) => l.ev === "DELETE").map((l: any) => l.keyId);
    const loserRowGone = inserted.filter((id) => id !== newId).every((id) => deleted.includes(id) && !rows.some((r: any) => r.id === id));
    const oldAuth = await submit(k.body.secret);
    const newAuth = won[0] ? await submit(won[0].body.secret) : null;
    const maxD1 = Math.max(...log.map((l: any) => l.n));
    const ok = activeBefore === 10 && won.length === 1 && lost.length === 1 && lost[0]!.status === 409 && lost[0]!.body.code === "api_key_revoked"
      && won[0]!.body.oldKey?.status === "revoked" && rows.length === 2 && loserRowGone && oldAuth === 401 && newAuth === 400 && Math.max(...samples) <= 10;
    if (!ok) allOk = false;
    console.log(`${ok ? "PASS" : "FAIL"} trial ${trial}: before=${activeBefore} statuses=${regen.map((r) => r.status)} lost=${lost.map((r) => r.body.code)} rowsByName=${rows.length} keysInserted=${inserted.length} loserRowDeleted=${loserRowGone} old=${oldAuth} new=${newAuth} listSamples=${samples.length} listMaxActive=${Math.max(...samples)} d1MaxEnabledAfterAnyWrite=${maxD1}`);
    console.log(`  d1 log: ${log.map((l: any) => `${l.ev}:${l.keyId === newId ? "new" : l.keyId === k.body.apiKey.id ? "old" : "loser"}:n=${l.n}@+${Math.round((Date.parse(l.at.replace(" ", "T") + "Z") - Date.parse(log[0].at.replace(" ", "T") + "Z")))}ms`).join(" ")}`);
  }
} finally {
  for (const ev of ["insert", "update", "delete"]) sql(`DROP TRIGGER IF EXISTS r6_log_${ev}`);
  sql(`DROP TABLE IF EXISTS r6_log`);
}
process.exit(allOk ? 0 : 1);
