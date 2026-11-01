// FAC-44 r9 API checks against a running verify-linklog instance (UI origin, real Worker, local D1).
//   bun api-checks-r9.ts <repo>/.cache/verify-linklog/<run>
// Prints one line per check and writes api-checks-r9.json next to this file. Rerunnable on one
// instance: every URL and key name carries a run stamp, and counters are read as deltas.
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runDir = process.argv[2];
if (!runDir) throw new Error("usage: bun api-checks-r9.ts <run dir>");
const session = JSON.parse(readFileSync(join(runDir, "session.json"), "utf8"));
const UI: string = session.ui;
const [A, B] = session.accounts.map((a: any) => a.cookie as string);
const d1Dir = join(runDir, "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
const dbFile = join(d1Dir, readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!);
const db = new Database(dbFile);
const q = <T = any>(sql: string, ...args: any[]) => db.query(sql).all(...args) as T[];
const userId = (email: string) => q<{ id: string }>("SELECT id FROM user WHERE email=?", email)[0]!.id;
const UA = userId("demo-a@linklog.test"), UB = userId("demo-b@linklog.test");
const stamp = `r8-${Date.now().toString(36)}`;
const fx = (name: string, path: string) => `https://${name}.qa.example/${stamp}/${path}`;

type Result = { story: string; name: string; ok: boolean; detail?: unknown };
const results: Result[] = [];
const log: string[] = [];
const say = (line: string) => {
  console.log(line);
  log.push(line);
};
function check(story: string, name: string, ok: boolean, detail?: unknown) {
  results.push({ story, name, ok, detail });
  say(`${ok ? "PASS" : "FAIL"} [${story}] ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Res = { status: number; body: any; headers: Headers };
async function http(method: string, path: string, opts: { cookie?: string; origin?: boolean; headers?: Record<string, string>; body?: unknown; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin) headers.origin = UI;
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] ??= "application/json";
  const r = await fetch(UI + path, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body, headers: r.headers };
}
const authApi = (cookie: string, method: string, route: string, body?: unknown) => http(method, `/api/auth/api-key/${route}`, { cookie, origin: true, body });
const priv = (cookie: string, method: string, path: string, body?: unknown) => http(method, `/api${path}`, { cookie, origin: method !== "GET", body: method === "GET" ? undefined : (body ?? {}) });
const v1 = (key: string | null, payload: unknown, extra: Record<string, string> = {}) =>
  http("POST", "/api/v1/links", { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra }, ...(typeof payload === "string" ? { raw: payload } : { body: payload }) });
const createKey = async (cookie: string, name: string) => {
  const r = await authApi(cookie, "POST", "create", { name });
  if (r.status !== 200) throw new Error(`create ${name} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; key: string; name: string };
};
const library = async (cookie: string) => (await priv(cookie, "GET", "/library")).body as { links: any[]; batches: any[] };
const counters = (uid: string) => q("SELECT key,window_start,count FROM app_rate_limits WHERE key IN (?,?) ORDER BY key", `links:${uid}`, `writes:${uid}`);
const counter = (key: string, window: number) => {
  const ws = Math.floor(Date.now() / 1000 / window) * window;
  return q<{ count: number }>("SELECT count FROM app_rate_limits WHERE key=? AND window_start=?", key, ws)[0]?.count ?? 0;
};
const linksUsed = () => counter(`links:${UA}`, 3600);
const writesUsed = (uid = UA) => counter(`writes:${uid}`, 60);
/** Waits for a fresh minute so a writes window has room (writes are 120/min per user). */
async function freshMinute(minLeft = 40) {
  const s = (Date.now() / 1000) % 60;
  if (60 - s < minLeft || writesUsed() > 0) await sleep((60 - s) * 1000 + 300);
}
const summary = async (cookie = A) => (await priv(cookie, "GET", "/usage/summary")).body;

say(`instance ${UI}  commit ${session.commit}  run ${runDir}  stamp ${stamp}  at ${new Date().toISOString()}`);

// ---------------------------------------------------------------- setup
await freshMinute();
const k1 = await createKey(A, `R8 Main ${stamp}`);
const kRevoke = await createKey(A, `R8 ToRevoke ${stamp}`);
const kDelete = await createKey(A, `R8 ToDelete ${stamp}`);
const kB = await createKey(B, `R8 B ${stamp}`);
check("1", "plugin create returns an lk_ secret for each key", [k1, kRevoke, kDelete, kB].every((k) => k.key.startsWith("lk_")));

// ---------------------------------------------------------------- story 2
{
  const before = linksUsed();
  const monthBefore = (await summary()).month;
  const bare = [fx("article", "bare-1"), fx("article", "bare-2")];
  const r1 = await v1(k1.key, { urls: bare });
  check("2", "bare URLs: 202, two created, batchId", r1.status === 202 && r1.body.results?.length === 2 && r1.body.results.every((r: any) => r.status === "created") && !!r1.body.batchId, r1.body);
  const text = `Read [one](${fx("article", "t-1")}) and <${fx("article", "t-2")}>, also ${fx("article", "t-3")}. Plus ${bare[0]} again`;
  const r2 = await v1(k1.key, { urls: [text, "just words, no link", "ftp://files.example/x"] });
  const st = Object.fromEntries((r2.body.results ?? []).map((r: any) => [r.url, r.status]));
  check("2", "text with several URLs: 202 with created, duplicate and rejected entries", r2.status === 202 && st[fx("article", "t-1")] === "created" && st[fx("article", "t-2")] === "created" && st[fx("article", "t-3")] === "created" && st[bare[0]!] === "duplicate" && r2.body.rejected?.length === 2, r2.body);
  check("2", "every result from the text names the text as input", (r2.body.results ?? []).every((r: any) => r.input === text));
  check("2", "rejected entries carry a reason", (r2.body.rejected ?? []).every((x: any) => x.error === "No valid http or https link found."), r2.body.rejected);
  const afterCreated = linksUsed();
  check("2", "links counter grew by exactly the 5 created (duplicate not charged)", afterCreated - before === 5, { before, after: afterCreated });
  const r3 = await v1(k1.key, { urls: bare });
  const afterDup = linksUsed();
  check("2", "duplicate-only request: 202, all duplicate, no batchId", r3.status === 202 && r3.body.results.every((r: any) => r.status === "duplicate") && !("batchId" in r3.body), r3.body);
  check("2", "duplicate-only request does not change the links counter", afterDup === afterCreated, { afterCreated, afterDup });
  const lib = await library(A);
  check("2", "all 5 created links are in Demo A's library", [...bare, fx("article", "t-1"), fx("article", "t-2"), fx("article", "t-3")].every((u) => lib.links.some((l) => l.original_url === u || l.url === u)));
  const monthAfter = (await summary()).month;
  const keyRow = monthAfter.apiKeys.find((k: any) => k.id === k1.id);
  check("8", "usage month: links +5 and key row = 5 (duplicates excluded)", monthAfter.links - monthBefore.links === 5 && keyRow?.links === 5, { before: monthBefore.links, after: monthAfter.links, keyRow });
}

// ---------------------------------------------------------------- story 3
{
  const libBefore = (await library(A)).links.length;
  const r0 = await v1(k1.key, { urls: ["nothing here", "ftp://files.example/x"] });
  check("3", "zero valid URLs: 400 with rejected list", r0.status === 400 && r0.body.error === "No valid http or https link found." && r0.body.rejected?.length === 2, r0.body);
  const many = Array.from({ length: 101 }, (_, i) => fx("article", `many-${i}`));
  const r1 = await v1(k1.key, { urls: many });
  check("3", "101 URLs: 400 Send at most 100 links per request.", r1.status === 400 && r1.body.error === "Send at most 100 links per request.", r1.body);
  const r1b = await v1(k1.key, { urls: [many.join(" ")] });
  check("3", "101 URLs inside one text string: 400 too", r1b.status === 400 && r1b.body.error === "Send at most 100 links per request.", r1b.body);
  const lib = await library(A);
  check("3", "nothing from the 101-URL requests was saved", lib.links.length === libBefore && !lib.links.some((l) => many.includes(l.original_url)), { before: libBefore, after: lib.links.length });
  const ownerCase = `{"urls":["https://example.com/page\\?q=1"]}`;
  const r2 = await v1(k1.key, ownerCase);
  check("3", "owner's literal \\? escape: 400 says the body is not valid JSON", r2.status === 400 && /^Body is not valid JSON/.test(r2.body.error), { sent: ownerCase, ...r2.body });
  const r3 = await v1(k1.key, `{"urls":["\\?"]}`);
  check("3", 'doc example {"urls":["\\?"]}: 400 Body is not valid JSON (at position 11).', r3.status === 400 && r3.body.error === "Body is not valid JSON (at position 11).", r3.body);
  const r4 = await v1(k1.key, `{"urls": [`);
  check("3", "truncated JSON: 400 not valid JSON", r4.status === 400 && /^Body is not valid JSON/.test(r4.body.error), r4.body);
  const r5 = await v1(k1.key, `["https://example.com"]`);
  check("3", "JSON array body: 400 Send a JSON object as the body.", r5.status === 400 && r5.body.error === "Send a JSON object as the body.", r5.body);
  const r6 = await v1(k1.key, { urls: [] });
  check("3", "empty urls: 400 Send `urls`: 1 to 1000 strings.", r6.status === 400 && r6.body.error === "Send `urls`: 1 to 1000 strings.", r6.body);
  // The exact shell path: zsh url-quote-magic leaves \? in a single-quoted -d body.
  const curl = Bun.spawnSync(["curl", "-s", "-w", "\nHTTP %{http_code}", "-X", "POST", `${UI}/api/v1/links`, "-H", `Authorization: Bearer ${k1.key}`, "-H", "Content-Type: application/json", "-d", ownerCase]);
  const out = curl.stdout.toString().trim();
  check("3", "real curl with the \\? body: HTTP 400 not valid JSON", /HTTP 400$/.test(out) && out.includes("Body is not valid JSON"), out);
}

// ---------------------------------------------------------------- story 4
{
  const url = fx("article", "auth-1");
  const missing = await v1(null, { urls: [url] });
  check("4", "missing key: 401", missing.status === 401 && missing.body.error === "A valid API key is required.", missing.body);
  const invalid = await v1("lk_not_a_real_key", { urls: [url] });
  check("4", "invalid key: 401", invalid.status === 401, invalid.body);
  const malformed = await v1(null, { urls: [url] }, { authorization: `Basic ${k1.key}` });
  check("4", "key under a non-Bearer scheme: 401", malformed.status === 401, malformed.body);
  const xkey = await v1(null, { urls: [url] }, { "x-api-key": k1.key });
  check("4", "valid key in x-api-key instead of Bearer: 401 on /api/v1", xkey.status === 401, xkey.body);
  const pre = await v1(kRevoke.key, { urls: [fx("article", "rev-pre")] });
  check("4", "key works before revoke", pre.status === 202, pre.body);
  const rev = await authApi(A, "POST", "update", { keyId: kRevoke.id, enabled: false });
  check("4", "revoke via plugin update enabled:false -> 200", rev.status === 200 && rev.body.enabled === false, rev.status);
  const revoked = await v1(kRevoke.key, { urls: [url] });
  check("4", "revoked key: 401", revoked.status === 401, revoked.body);
  const en = await authApi(A, "POST", "update", { keyId: kRevoke.id, enabled: true });
  const back = await v1(kRevoke.key, { urls: [fx("article", "rev-back")] });
  check("4", "re-enabled key works again (202)", en.status === 200 && back.status === 202, { update: en.status, submit: back.body });
  const preDel = await v1(kDelete.key, { urls: [fx("article", "del-pre")] });
  const del = await authApi(A, "POST", "delete", { keyId: kDelete.id });
  const deleted = await v1(kDelete.key, { urls: [url] });
  check("4", "deleted key: 401 (it worked before delete)", preDel.status === 202 && del.status === 200 && deleted.status === 401, { preDel: preDel.status, del: del.status, after: deleted.body });
  check("4", "deleted key row is gone from apikey", q("SELECT 1 FROM apikey WHERE id=?", kDelete.id).length === 0);
  // Leave kRevoke revoked for the Usage story (a revoked key keeps its row).
  await authApi(A, "POST", "update", { keyId: kRevoke.id, enabled: false });
}

// ---------------------------------------------------------------- story 9
{
  // Bearer / x-api-key never reach private or key-management routes.
  const lib = await library(A);
  const aLink = lib.links[0];
  const aBatch = lib.batches[0];
  const targets: [string, string, unknown?][] = [
    ["GET", "/api/library"],
    ["GET", "/api/usage/summary"],
    ["GET", "/api/usage"],
    ["GET", `/api/batches/${aBatch?.id}`],
    ["DELETE", `/api/batches/${aBatch?.id}`],
    ["GET", `/api/links/${aLink?.id}/content`],
    ["POST", "/api/links", { url: fx("article", "bearer-private") }],
    ["POST", "/api/import", { urls: [fx("article", "bearer-import")] }],
    ["DELETE", `/api/links/${aLink?.id}`],
    ["GET", "/api/browser/catalog"],
    ["POST", "/api/tags", { name: `bearer-${stamp}` }],
    ["GET", "/api/auth/api-key/list"],
    ["GET", `/api/auth/api-key/get?id=${k1.id}`],
    ["POST", "/api/auth/api-key/create", { name: `bearer-made-${stamp}` }],
    ["POST", "/api/auth/api-key/update", { keyId: k1.id, enabled: false }],
    ["POST", "/api/auth/api-key/delete", { keyId: k1.id }],
    ["GET", "/api/auth/get-session"],
    ["GET", "/api/v1/links"],
    ["POST", "/api/v1/library", {}],
  ];
  const keysBefore = q("SELECT id,enabled,name FROM apikey WHERE referenceId=? ORDER BY id", UA);
  const reach: any[] = [];
  for (const style of ["bearer", "x-api-key"] as const)
    for (const [method, path, body] of targets) {
      const headers = style === "bearer" ? { authorization: `Bearer ${k1.key}` } : { "x-api-key": k1.key };
      const r = await http(method, path, { headers: { ...headers, origin: UI }, body: method === "GET" ? undefined : body ?? {} });
      const leaked = typeof r.body === "object" && r.body !== null && ("links" in r.body || "apiKeys" in r.body || "session" in r.body || "jobs" in r.body || "month" in r.body || "key" in r.body);
      const allowed = path === "/api/auth/get-session" ? r.status === 200 && r.body === null : path.startsWith("/api/v1/") ? r.status === 404 && style === "bearer" || r.status === 401 : [401, 403, 404].includes(r.status);
      reach.push({ style, method, path, status: r.status, body: typeof r.body === "string" ? r.body.slice(0, 80) : r.body });
      check("9", `${style} ${method} ${path.replace(stamp, "<stamp>")} -> ${r.status}${leaked ? " LEAK" : ""}`, allowed && !leaked);
    }
  writeFileSync(join(import.meta.dir, "api-checks-r9-reach.json"), JSON.stringify(reach, null, 2));
  const keysAfter = q("SELECT id,enabled,name FROM apikey WHERE referenceId=? ORDER BY id", UA);
  check("9", "Bearer/x-api-key calls created, changed or deleted no key", JSON.stringify(keysBefore) === JSON.stringify(keysAfter), { before: keysBefore.length, after: keysAfter.length });
  check("9", "A's library untouched by Bearer private calls", (await library(A)).links.length === lib.links.length && !(await library(A)).links.some((l) => String(l.original_url).includes("bearer-")));

  // User B's key and session against user A.
  const shared = lib.links.find((l) => String(l.original_url).includes(`${stamp}/bare-1`));
  const aBefore = q("SELECT id,user_id,last_saved_at,status FROM links WHERE id=?", shared.id)[0];
  const rb = await v1(kB.key, { urls: [shared.original_url] });
  check("9", "B's key submitting A's URL creates B's own link (not A's duplicate)", rb.status === 202 && rb.body.results[0].status === "created" && rb.body.results[0].id !== shared.id, rb.body);
  const rbRow = q("SELECT user_id FROM links WHERE id=?", rb.body.results?.[0]?.id)[0];
  check("9", "the new link is owned by B", rbRow?.user_id === UB, rbRow);
  check("9", "A's link row unchanged by B's submit", JSON.stringify(q("SELECT id,user_id,last_saved_at,status FROM links WHERE id=?", shared.id)[0]) === JSON.stringify(aBefore));
  const bList = await authApi(B, "GET", "list");
  check("9", "B's key list holds only B's keys", bList.status === 200 && bList.body.apiKeys.every((k: any) => k.referenceId === UB) && !bList.body.apiKeys.some((k: any) => k.id === k1.id), bList.body.apiKeys?.map((k: any) => k.name));
  const bGet = await http("GET", `/api/auth/api-key/get?id=${k1.id}`, { cookie: B });
  const bUpd = await authApi(B, "POST", "update", { keyId: k1.id, enabled: false });
  const bRen = await authApi(B, "POST", "update", { keyId: k1.id, name: "pwned" });
  const bDel = await authApi(B, "POST", "delete", { keyId: k1.id });
  const bEnable = await authApi(B, "POST", "update", { keyId: kRevoke.id, enabled: true });
  check("9", "B session get A's key: 404", bGet.status === 404, bGet.body);
  check("9", "B session update (revoke) A's key: 404", bUpd.status === 404, bUpd.body);
  check("9", "B session rename A's key: 404", bRen.status === 404, bRen.body);
  check("9", "B session delete A's key: 404", bDel.status === 404, bDel.body);
  check("9", "B session enable A's revoked key: 404", bEnable.status === 404, bEnable.body);
  const k1Row = q("SELECT name,enabled FROM apikey WHERE id=?", k1.id)[0];
  const kRevRow = q("SELECT enabled FROM apikey WHERE id=?", kRevoke.id)[0];
  check("9", "A's keys unchanged after B's attempts", k1Row?.enabled === 1 && k1Row?.name === k1.name && kRevRow?.enabled === 0, { k1Row, kRevRow });
  check("9", "A's key still submits", (await v1(k1.key, { urls: [fx("article", "after-b")] })).status === 202);

  // Server-only plugin routes are 404 over HTTP.
  for (const [route, method, cookie, body] of [
    ["verify", "POST", undefined, { key: k1.key }],
    ["verify", "POST", A, { key: k1.key }],
    ["verify", "GET", A, undefined],
    ["delete-all-expired", "POST", undefined, {}],
    ["delete-all-expired", "POST", A, {}],
    ["delete-all-expired", "GET", A, undefined],
  ] as const) {
    const r = await http(method, `/api/auth/api-key/${route}`, { cookie, origin: true, body });
    check("9", `${method} /api/auth/api-key/${route}${cookie ? " (signed in)" : ""} -> 404`, r.status === 404, { status: r.status, body: r.body });
  }

  // Server-only fields cannot be set from the browser.
  const countA = () => q<{ n: number }>("SELECT count(*) n FROM apikey WHERE referenceId=?", UA)[0]!.n;
  const nBefore = countA();
  const fields: [string, unknown][] = [
    ["rateLimitEnabled", true], ["rateLimitMax", 5], ["rateLimitTimeWindow", 1000], ["remaining", 5],
    ["refillAmount", 5], ["refillInterval", 1000], ["permissions", { links: ["read"] }], ["expiresIn", 86400],
  ];
  for (const [field, value] of fields) {
    const r = await authApi(A, "POST", "create", { name: `SO ${field} ${stamp}`, [field]: value });
    check("9", `create with ${field}: refused (${r.status})`, r.status === 400 || r.status === 401 || r.status === 403, r.body);
  }
  const asB = await authApi(A, "POST", "create", { name: `SO userId ${stamp}`, userId: UB });
  check("9", `create with userId of B: refused (${asB.status})`, [400, 401, 403].includes(asB.status), asB.body);
  check("9", "no key was created by any server-only attempt", countA() === nBefore, { before: nBefore, after: countA() });
  const rowSql = "SELECT enabled,name,expiresAt,remaining,refillAmount,refillInterval,rateLimitEnabled,rateLimitMax,rateLimitTimeWindow,permissions,referenceId FROM apikey WHERE id=?";
  const rowBefore = q(rowSql, k1.id)[0];
  for (const [field, value] of fields) {
    const r = await authApi(A, "POST", "update", { keyId: k1.id, [field]: value });
    check("9", `update with ${field}: refused (${r.status})`, r.status === 400 || r.status === 401 || r.status === 403, r.body);
  }
  const upB = await authApi(A, "POST", "update", { keyId: k1.id, userId: UB, enabled: true });
  check("9", `update with userId of B: refused (${upB.status})`, [400, 401, 403, 404].includes(upB.status), upB.body);
  check("9", "key row unchanged after server-only update attempts", JSON.stringify(q(rowSql, k1.id)[0]) === JSON.stringify(rowBefore), rowBefore);
}

// ---------------------------------------------------------------- r7 fix b: prefix and configId are refused
{
  const countA = () => q<{ n: number }>("SELECT count(*) n FROM apikey WHERE referenceId=?", UA)[0]!.n;
  const nBefore = countA();
  for (const extra of [{ prefix: "zz_" }, { prefix: "lk_" }, { configId: "default" }, { prefix: "zz_", configId: "default" }]) {
    const r = await authApi(A, "POST", "create", { name: `R8 Prefixed ${stamp}`, ...extra });
    check("R7b", `create with ${JSON.stringify(extra)}: 400 SERVER_ONLY_PROPERTY`, r.status === 400 && r.body.code === "SERVER_ONLY_PROPERTY", { status: r.status, body: r.body });
  }
  check("R7b", "no key was created by the prefix/configId attempts", countA() === nBefore && q("SELECT 1 FROM apikey WHERE name=?", `R8 Prefixed ${stamp}`).length === 0, { before: nBefore, after: countA() });
  const plain = await authApi(A, "POST", "create", { name: `R8 Plain ${stamp}` });
  check("R7b", "a normal create returns 200 with an lk_ secret and lk_ start", plain.status === 200 && String(plain.body.key).startsWith("lk_") && String(plain.body.start).startsWith("lk_"), { status: plain.status, start: plain.body.start, prefix: plain.body.prefix });
  const stored = q<{ prefix: string; start: string }>("SELECT prefix,start FROM apikey WHERE id=?", plain.body.id)[0];
  check("R7b", "the stored row has prefix lk_", stored?.prefix === "lk_" && stored.start.startsWith("lk_"), stored);
  check("R7b", "the lk_ key submits (202)", (await v1(plain.body.key, { urls: [fx("article", "plain-key")] })).status === 202);
  await authApi(A, "POST", "delete", { keyId: plain.body.id });
}

// ---------------------------------------------------------------- r7 fix e: a deleted key is 401, never 503
{
  const kd = await createKey(A, `R8 DeleteBearer ${stamp}`);
  const used = await v1(kd.key, { urls: [fx("article", "del-bearer")] });
  const del = await authApi(A, "POST", "delete", { keyId: kd.id });
  const after = [];
  for (let i = 0; i < 3; i++) after.push(await v1(kd.key, { urls: [fx("article", `del-bearer-${i}`)] }));
  check("R7e", "deleted key: worked before (202), delete 200, then 401 three times (no 503)", used.status === 202 && del.status === 200 && after.every((r) => r.status === 401 && r.body.error === "A valid API key is required."), { used: used.status, del: del.status, after: after.map((r) => [r.status, r.body]) });
  const unknown = await v1(`lk_${"x".repeat(40)}`, { urls: [fx("article", "unknown-bearer")] });
  check("R7e", "unknown well-formed lk_ key: 401 (no 503)", unknown.status === 401, { status: unknown.status, body: unknown.body });
  check("R7e", "nothing was saved by the refused submissions", !(await library(A)).links.some((l) => String(l.original_url).includes(`${stamp}/del-bearer-`) || String(l.original_url).includes(`${stamp}/unknown-bearer`)));
}

// ---------------------------------------------------------------- r7 fix c: rename shows in Usage, delete keeps the last name
{
  const kr = await createKey(A, `R8 BeforeRename ${stamp}`);
  const s1 = await v1(kr.key, { urls: [fx("article", "ren-1")] });
  const newName = `R8 AfterRename ${stamp}`;
  const ren = await authApi(A, "POST", "update", { keyId: kr.id, name: newName });
  check("R7c", "rename via plugin update: 200 with the new name", ren.status === 200 && ren.body.name === newName, { status: ren.status, name: ren.body.name });
  const s2 = await v1(kr.key, { urls: [fx("article", "ren-2")] });
  const s3 = await v1(kr.key, { urls: [fx("article", "ren-3"), fx("article", "ren-1")] });
  check("R7c", "the renamed key keeps submitting (202)", s1.status === 202 && s2.status === 202 && s3.status === 202, [s1.status, s2.status, s3.status]);
  const live = (await summary()).month.apiKeys.find((k: any) => k.id === kr.id);
  check("R7c", "Usage lists the key under its new name, active, 3 links (duplicate excluded)", live?.name === newName && live.status === "active" && live.links === 3, live);
  const del = await authApi(A, "POST", "delete", { keyId: kr.id });
  const gone = (await summary()).month.apiKeys.find((k: any) => k.id === kr.id);
  check("R7c", "after delete Usage keeps it under its last name, status deleted, 3 links", del.status === 200 && gone?.name === newName && gone.status === "deleted" && gone.links === 3, gone);
  // Edge outside item c: a rename after the key's last submission, then delete.
  const ke = await createKey(A, `R8 EdgeOld ${stamp}`);
  await v1(ke.key, { urls: [fx("article", "edge-1")] });
  await authApi(A, "POST", "update", { keyId: ke.id, name: `R8 EdgeNew ${stamp}` });
  const edgeLive = (await summary()).month.apiKeys.find((k: any) => k.id === ke.id);
  await authApi(A, "POST", "delete", { keyId: ke.id });
  const edgeGone = (await summary()).month.apiKeys.find((k: any) => k.id === ke.id);
  say(`NOTE [R7c] renamed after its last submission: live name "${edgeLive?.name}", after delete "${edgeGone?.name}" (${edgeGone?.status}); docs say a deleted key shows the name of its most recent submission`);
}

// ---------------------------------------------------------------- r7 fix d: an orphan re-queued by a key stays Web's
{
  const ka = await createKey(A, `R8 Attr ${stamp}`);
  const before = await summary();
  const url = fx("article", "orphan-web");
  const web = await priv(A, "POST", "/links", { url });
  check("R7d", "web creates the link (POST /api/links with the session): 201", web.status === 201, web.status);
  let link: any;
  for (let i = 0; i < 60; i++) {
    link = (await library(A)).links.find((l) => l.original_url === url);
    if (link && !link.processing) break;
    await sleep(1000);
  }
  const webBatches = q<{ id: string; created_at: string; config: string }>("SELECT DISTINCT b.id,b.created_at,b.config FROM batches b JOIN jobs j ON j.batch_id=b.id WHERE j.link_id=?", link.id);
  const linkRow = q<{ created_at: string }>("SELECT created_at FROM links WHERE id=?", link.id)[0]!;
  check("R7d", "the web's creating batch has no source and the link's created_at", webBatches.length === 1 && webBatches[0]!.created_at === linkRow.created_at && JSON.parse(webBatches[0]!.config).source === undefined, { webBatches, linkCreated: linkRow.created_at });
  // No HTTP route deletes a job, so the state an interrupted pre-atomic save left (a Link with no
  // batch, no job and no content) is made in local D1, with D1's foreign keys enforced.
  db.run("PRAGMA foreign_keys=ON");
  db.run("DELETE FROM usage_events WHERE batch_id=?", [webBatches[0]!.id]);
  db.run("DELETE FROM batches WHERE id=?", [webBatches[0]!.id]);
  db.run("UPDATE links SET content_key=NULL,content_state='missing',content_error=NULL WHERE id=?", [link.id]);
  const orphan = q<{ o: number }>("SELECT (content_key IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE link_id=links.id)) o FROM links WHERE id=?", link.id)[0];
  say(`SEED [R7d] orphaned link ${link.id}: DELETE FROM batches WHERE id=${webBatches[0]!.id} (its usage_events deleted first, jobs cascade), content_key=NULL`);
  check("R7d", "the link is an orphan by addLinks' own predicate", orphan?.o === 1, orphan);
  const re = await v1(ka.key, { urls: [url] });
  check("R7d", "the key re-submits the URL: 202 duplicate of the same link, re-queued (batchId)", re.status === 202 && re.body.results?.[0]?.status === "duplicate" && re.body.results[0].id === link.id && !!re.body.batchId, re.body);
  const requeue = q<{ config: string; created_at: string }>("SELECT b.config,b.created_at FROM batches b JOIN jobs j ON j.batch_id=b.id WHERE j.link_id=?", link.id);
  check("R7d", "the re-queue batch is labelled with the key and is newer than the link", requeue.length === 1 && JSON.parse(requeue[0]!.config).apiKeyId === ka.id && requeue[0]!.created_at > linkRow.created_at, requeue);
  let done: any;
  for (let i = 0; i < 60; i++) {
    done = (await library(A)).links.find((l) => l.id === link.id);
    if (done && !done.processing) break;
    await sleep(1000);
  }
  check("R7d", "the re-queued extraction finished", !!done && !done.processing, { processing: done?.processing, content_state: done?.content_state, status: done?.status });
  const own = await v1(ka.key, { urls: [fx("article", "attr-own")] });
  check("R7d", "the key also creates one Link of its own", own.status === 202 && own.body.results[0].status === "created", own.body);
  const s = await summary();
  const row = s.month.apiKeys.find((k: any) => k.id === ka.id);
  const keysSum = s.month.apiKeys.reduce((n: number, k: any) => n + k.links, 0);
  const dbMonth = q<{ n: number }>("SELECT count(*) n FROM links WHERE user_id=? AND created_at>=?", UA, s.month.start)[0]!.n;
  check("R7d", "the key's row counts only its own Link (1), not the re-queued orphan", row?.links === 1, row);
  check("R7d", "month total +2, Web +1 (the orphan stays Web's)", s.month.links - before.month.links === 2 && s.month.web - before.month.web === 1, { total: [before.month.links, s.month.links], web: [before.month.web, s.month.web] });
  check("R7d", "Web + every key = month total = D1 count", s.month.web + keysSum === s.month.links && s.month.links === dbMonth, { web: s.month.web, keysSum, links: s.month.links, dbMonth });
  writeFileSync(join(import.meta.dir, "api-checks-r9-attribution.json"), JSON.stringify({ link: link.id, url, before: before.month, after: s.month }, null, 2));
}

// ---------------------------------------------------------------- story 6: writes
{
  await freshMinute(55);
  const startUsed = writesUsed();
  const dupUrl = fx("article", "bare-1");
  let n = 0;
  let last: Res | undefined;
  for (; n < 200; n++) {
    last = await v1(k1.key, { urls: [dupUrl] });
    if (last.status !== 202) break;
  }
  const ra = Number(last?.headers.get("retry-after"));
  const secsLeft = 60 - Math.floor((Date.now() / 1000) % 60);
  check("6", `writes via API: ${n} accepted after ${startUsed} already used, then 429`, last?.status === 429 && startUsed + n === 120, { startUsed, accepted: n, status: last?.status });
  check("6", "API 429 carries code writes and a Retry-After to the minute end", last?.body.code === "writes" && last?.body.error === "Too many requests. Try again later." && ra >= 1 && ra <= 60 && Math.abs(ra - secsLeft) <= 2, { body: last?.body, retryAfter: ra, secsLeft });
  const web = await priv(A, "POST", "/links", { url: fx("article", "web-during-writes") });
  check("6", "web write (session POST /api/links) refused 429 writes in the same window", web.status === 429 && web.body.code === "writes" && Number(web.headers.get("retry-after")) >= 1, { status: web.status, body: web.body, retryAfter: web.headers.get("retry-after") });
  check("6", "web write saved nothing", !(await library(A)).links.some((l) => l.original_url === fx("article", "web-during-writes")));
  const bOk = await v1(kB.key, { urls: [fx("article", "b-during-a-writes")] });
  check("6", "Demo B is unaffected (per-user budget)", bOk.status === 202, bOk.status);
  check("6", "app_rate_limits writes row for A reads 120", writesUsed() === 120, counters(UA));

  await freshMinute(55);
  const startWeb = writesUsed();
  let m = 0;
  let lastWeb: Res | undefined;
  for (; m < 200; m++) {
    lastWeb = await priv(A, "POST", "/links", { url: dupUrl });
    if (lastWeb.status !== 200 && lastWeb.status !== 201) break;
  }
  check("6", `writes via web: ${m} accepted after ${startWeb}, then 429 writes`, lastWeb?.status === 429 && lastWeb?.body.code === "writes" && startWeb + m === 120, { startWeb, accepted: m, body: lastWeb?.body });
  const api = await v1(k1.key, { urls: [fx("article", "api-during-web-writes")] });
  check("6", "API key refused 429 writes after the web used the budget", api.status === 429 && api.body.code === "writes" && Number(api.headers.get("retry-after")) >= 1, { status: api.status, body: api.body, retryAfter: api.headers.get("retry-after") });
}

// ---------------------------------------------------------------- r7 fix a: key writes share the writes budget
{
  const keysOf = (uid: string) => q<{ id: string; name: string; enabled: number }>("SELECT id,name,enabled FROM apikey WHERE referenceId=? ORDER BY id", uid);
  const keyRow = (id: string) => q<{ id: string; name: string; enabled: number }>("SELECT id,name,enabled FROM apikey WHERE id=?", id)[0];
  // r9: scratch keys for the spent-budget probes, so k1 (needed later) is never revoked or deleted.
  // Story 6 just spent this minute's writes budget; key creation is charged, so start a fresh window.
  await freshMinute(55);
  const sRevoke = await createKey(A, `R9 SpentRevoke ${stamp}`);
  const sDelete = await createKey(A, `R9 SpentDelete ${stamp}`);
  const sEnable = await createKey(A, `R9 SpentEnable ${stamp}`);
  const sCombo = await createKey(A, `R9 SpentCombo ${stamp}`);
  const sRevokedDel = await createKey(A, `R9 SpentRevDel ${stamp}`);
  await authApi(A, "POST", "update", { keyId: sEnable.id, enabled: false });
  await authApi(A, "POST", "update", { keyId: sRevokedDel.id, enabled: false });
  await freshMinute(55);
  const start = writesUsed();
  let n = 0;
  let last: Res | undefined;
  for (; n < 200; n++) {
    last = await v1(k1.key, { urls: [fx("article", "bare-1")] });
    if (last.status !== 202) break;
  }
  check("R7a", `API submissions spend the budget: ${n} accepted after ${start}, then 429 writes`, last?.status === 429 && last.body.code === "writes" && start + n === 120, { start, accepted: n, body: last?.body });
  const keysBefore = keysOf(UA);
  const create = await authApi(A, "POST", "create", { name: `R8 RefusedCreate ${stamp}` });
  const ra = Number(create.headers.get("retry-after"));
  const secsLeft = 60 - Math.floor((Date.now() / 1000) % 60);
  check("R7a", "key create is then 429 with Retry-After to the minute end and code writes", create.status === 429 && create.body.code === "writes" && create.body.message === "Too many requests. Try again later." && ra >= 1 && ra <= 60 && Math.abs(ra - secsLeft) <= 2, { status: create.status, body: create.body, retryAfter: ra, secsLeft });
  const upd = await authApi(A, "POST", "update", { keyId: k1.id, name: `R8 RefusedRename ${stamp}` });
  const enable = await authApi(A, "POST", "update", { keyId: sEnable.id, enabled: true });
  const combo = await authApi(A, "POST", "update", { keyId: sCombo.id, enabled: false, name: `R9 ComboRenamed ${stamp}` });
  const is429 = (r: Res) => r.status === 429 && r.body.code === "writes" && r.body.message === "Too many requests. Try again later." && Number(r.headers.get("retry-after")) >= 1;
  check("R9", "spent budget: rename is refused 429 writes with Retry-After", is429(upd), [upd.status, upd.body, upd.headers.get("retry-after")]);
  check("R9", "spent budget: enable is refused 429 writes with Retry-After", is429(enable), [enable.status, enable.body, enable.headers.get("retry-after")]);
  check("R9", "spent budget: disable-plus-rename is refused 429 writes with Retry-After", is429(combo), [combo.status, combo.body, combo.headers.get("retry-after")]);
  check("R9", "no key was created, renamed or enabled; the combo key is still enabled under its old name", JSON.stringify(keysOf(UA)) === JSON.stringify(keysBefore) && keyRow(sCombo.id)?.enabled === 1 && keyRow(sCombo.id)?.name === sCombo.name && keyRow(sEnable.id)?.enabled === 0 && keyRow(k1.id)?.name === k1.name, { combo: keyRow(sCombo.id), enable: keyRow(sEnable.id), k1: keyRow(k1.id) });
  const enabledStill = await v1(sEnable.key, { urls: [fx("article", "enable-refused")] });
  check("R9", "the key whose enable was refused still answers 401", enabledStill.status === 401, enabledStill.status);
  const usedBeforeFree = writesUsed();
  const rev = await authApi(A, "POST", "update", { keyId: sRevoke.id, enabled: false });
  check("R9", "spent budget: revoke ({keyId, enabled:false}) -> 200, enabled false", rev.status === 200 && rev.body.enabled === false && keyRow(sRevoke.id)?.enabled === 0, [rev.status, rev.body?.enabled ?? rev.body]);
  const revBearer = await v1(sRevoke.key, { urls: [fx("article", "after-spent-revoke")] });
  check("R9", "the key revoked under a spent budget answers 401 on /api/v1/links", revBearer.status === 401, [revBearer.status, revBearer.body]);
  const del = await authApi(A, "POST", "delete", { keyId: sDelete.id });
  check("R9", "spent budget: delete of an active key -> 200 and the row is gone", del.status === 200 && !keyRow(sDelete.id), [del.status, del.body]);
  const delRev = await authApi(A, "POST", "delete", { keyId: sRevokedDel.id });
  check("R9", "spent budget: delete of a revoked key -> 200 and the row is gone", delRev.status === 200 && !keyRow(sRevokedDel.id), [delRev.status, delRev.body]);
  const delBearer = await v1(sDelete.key, { urls: [fx("article", "after-spent-delete")] });
  check("R9", "the key deleted under a spent budget answers 401", delBearer.status === 401, delBearer.status);
  const reRevoke = await authApi(A, "POST", "update", { keyId: sRevoke.id, enabled: false });
  check("R9", "revoking an already revoked key under a spent budget -> 200", reRevoke.status === 200, reRevoke.status);
  check("R9", "revoke and delete were not charged: writes counter unchanged at 120", writesUsed() === usedBeforeFree && usedBeforeFree === 120, { usedBeforeFree, after: writesUsed() });
  const createAfter = await authApi(A, "POST", "create", { name: `R9 RefusedCreate2 ${stamp}` });
  check("R9", "after the free revoke and delete, create is still refused 429 writes", is429(createAfter), [createAfter.status, createAfter.body]);
  const k1Still = await v1(k1.key, { urls: [fx("article", "k1-still")] });
  check("R9", "k1 is untouched (still 429 writes, not 401)", k1Still.status === 429 && k1Still.body.code === "writes", k1Still.status);
  const list = await authApi(A, "GET", "list");
  check("R7a", "listing keys is free (200 while the budget is spent)", list.status === 200, list.status);
  const bCreate = await authApi(B, "POST", "create", { name: `R8 B during A ${stamp}` });
  const bSubmit = await v1(kB.key, { urls: [fx("article", "b-during-a-api")] });
  check("R7a", "Demo B unaffected: key create 200 (lk_) and API submission 202", bCreate.status === 200 && String(bCreate.body.key).startsWith("lk_") && bSubmit.status === 202, [bCreate.status, bSubmit.status]);
  if (bCreate.status === 200) await authApi(B, "POST", "delete", { keyId: bCreate.body.id });

  await freshMinute(55);
  const start2 = writesUsed();
  let m = 0;
  let lastKey: Res | undefined;
  const made: string[] = [];
  for (; m < 200; m++) {
    // Better Auth also limits each path per IP (100/min), so alternate two charged key-write routes.
    // r9: delete is no longer charged, so create replaces it here; the created keys are deleted after.
    lastKey = m % 2 ? await authApi(A, "POST", "create", { name: `R9 Spend ${stamp} ${m}` }) : await authApi(A, "POST", "update", { keyId: k1.id, name: k1.name });
    if (m % 2 && lastKey.status === 200) made.push(lastKey.body.id);
    if (lastKey.status === 429) break;
  }
  check("R7a", `key writes (create + rename) spend the budget: ${m} accepted after ${start2}, then 429 writes`, lastKey?.status === 429 && lastKey.body.code === "writes" && start2 + m === 120 && writesUsed() === 120, { start2, accepted: m, body: lastKey?.body, used: writesUsed() });
  const cleanup: Res[] = [];
  for (const id of made) cleanup.push(await authApi(A, "POST", "delete", { keyId: id }));
  check("R9", `the ${made.length} spend keys are deleted with the budget spent (all 200), counter still 120`, cleanup.every((r) => r.status === 200) && writesUsed() === 120, { statuses: [...new Set(cleanup.map((r) => r.status))], used: writesUsed() });
  const url = fx("article", "api-after-key-writes");
  const api = await v1(k1.key, { urls: [url] });
  check("R7a", "an API submission is then 429 writes with Retry-After", api.status === 429 && api.body.code === "writes" && Number(api.headers.get("retry-after")) >= 1, { status: api.status, body: api.body, retryAfter: api.headers.get("retry-after") });
  check("R7a", "and saved nothing", !(await library(A)).links.some((l) => l.original_url === url));
  const bSubmit2 = await v1(kB.key, { urls: [fx("article", "b-during-a-keys")] });
  const bCreate2 = await authApi(B, "POST", "create", { name: `R8 B during A keys ${stamp}` });
  check("R7a", "Demo B unaffected again: submission 202, key create 200", bSubmit2.status === 202 && bCreate2.status === 200, [bSubmit2.status, bCreate2.status]);
  if (bCreate2.status === 200) await authApi(B, "POST", "delete", { keyId: bCreate2.body.id });
}

// ---------------------------------------------------------------- story 6: links (seeded counter)
{
  await freshMinute(50);
  // r7 found its failed link from journeys run earlier on the same instance; r8 makes its own (DNS miss).
  const nowhere = await v1(k1.key, { urls: [fx("nowhere", "retry-me")] });
  say(`SETUP [8] a Link whose preview fails, for the retry check: ${fx("nowhere", "retry-me")} -> ${nowhere.status}`);
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const real = linksUsed();
  // 500 real Links would queue 500 extractions on one local instance; instead the current hour's
  // links:<A> row is set to 498 directly in local D1, then real requests cross the limit.
  db.run("INSERT INTO app_rate_limits(key,window_start,count) VALUES(?,?,498) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=498", [`links:${UA}`, hour]);
  say(`SEED [6] links:${UA} window ${hour} count ${real} -> 498 (direct UPDATE in local D1)`);
  const seen = (await summary()).quotas.links;
  check("6", "Worker reads the seeded counter: Usage quota shows 498 / 500", seen.used === 498 && seen.max === 500, seen);
  const three = [1, 2, 3].map((i) => fx("article", `cap-${i}`));
  const r3 = await v1(k1.key, { urls: three });
  const ra = Number(r3.headers.get("retry-after"));
  const toHour = hour + 3600 - Math.floor(Date.now() / 1000);
  check("6", "3 new links at 498/500: 429 code links with Retry-After to the hour end", r3.status === 429 && r3.body.code === "links" && r3.body.error === "Link limit reached. Try again later." && Math.abs(ra - toHour) <= 2, { body: r3.body, retryAfter: ra, toHour });
  check("6", "the refused request saved nothing and charged nothing", linksUsed() === 498 && !(await library(A)).links.some((l) => three.includes(l.original_url)), { used: linksUsed() });
  const dup = await v1(k1.key, { urls: [fx("article", "bare-2")] });
  check("6", "a Duplicate at 498/500 is still accepted and not charged", dup.status === 202 && dup.body.results[0].status === "duplicate" && linksUsed() === 498, { status: dup.status, used: linksUsed() });
  const two = await v1(k1.key, { urls: three.slice(0, 2) });
  check("6", "2 new links fit: 202 created, counter 500", two.status === 202 && two.body.results.every((r: any) => r.status === "created") && linksUsed() === 500, { body: two.body, used: linksUsed() });
  const web = await priv(A, "POST", "/links", { url: fx("article", "web-at-cap") });
  check("6", "web add at 500/500: 429 code links with Retry-After (shared)", web.status === 429 && web.body.code === "links" && Number(web.headers.get("retry-after")) >= 1, { status: web.status, body: web.body, retryAfter: web.headers.get("retry-after") });
  const dupAtCap = await v1(k1.key, { urls: [three[0]] });
  check("6", "a Duplicate at 500/500 still 202", dupAtCap.status === 202 && dupAtCap.body.results[0].status === "duplicate", dupAtCap.body);

  // Lens, autotag, retry and a browser (content) run are not refused for any jobs quota, even at 500/500.
  const libNow = await library(A);
  const ready = await (async () => {
    for (let i = 0; i < 60; i++) {
      const l = (await library(A)).links.find((x) => x.original_url === fx("article", "t-1"));
      if (l && !l.processing) return l;
      await sleep(1000);
    }
  })();
  const lensName = `R8 Lens ${stamp}`;
  const lensRes = await priv(A, "POST", "/lenses", { name: lensName, type: "noul", question: "Is it useful?", threshold: 0.8 });
  const lens = lensRes.body.lenses?.find((l: any) => l.name === lensName);
  const lensRun = await priv(A, "POST", "/batches", { kind: "lens", ids: [ready.id], lensId: lens?.id });
  check("8", "lens run at 500/500 links: accepted (200, batchId)", lensRun.status === 200 && !!lensRun.body.batchId, { status: lensRun.status, error: lensRun.body.error });
  const tag = await priv(A, "POST", "/tags", { name: "r8-useful" });
  say(`SETUP [8] autotag needs a tag: POST /api/tags r8-useful -> ${tag.status}`);
  const tagRun = await priv(A, "POST", "/batches", { kind: "autotag", ids: [ready.id] });
  check("8", "autotag run at 500/500 links: accepted (200, batchId)", tagRun.status === 200 && !!tagRun.body.batchId, { status: tagRun.status, error: tagRun.body.error });
  const failed = await (async () => {
    for (let i = 0; i < 60; i++) {
      const l = (await library(A)).links.find((x) => x.original_url === fx("nowhere", "retry-me") && !x.processing);
      if (l) return l;
      await sleep(1000);
    }
  })();
  const retry = await priv(A, "POST", `/links/${failed.id}/retry`, {});
  check("8", "preview retry at 500/500 links: accepted", retry.status === 200 && !!retry.body.batchId, { status: retry.status, error: retry.body.error });
  const other = libNow.links.find((x) => x.original_url === fx("article", "t-2"));
  for (let i = 0; i < 60 && (await library(A)).links.find((x) => x.id === other.id)?.processing; i++) await sleep(1000);
  const content = await priv(A, "POST", `/links/${other.id}/retry`, { step: "content" });
  check("8", "browser (content) run at 500/500 links: accepted", content.status === 200 && !!content.body.batchId, { status: content.status, error: content.body.error });
  check("6", "runs did not move the links counter", linksUsed() === 500, { used: linksUsed() });
  const features = async () => Object.fromEntries((await summary()).month.features.map((f: any) => [f.key, f.runs]));
  let f: any = {};
  for (let i = 0; i < 90; i++) {
    f = await features();
    if (f.lens >= 1 && f.autotag >= 1) break;
    await sleep(1000);
  }
  check("8", "usage by feature counts the lens and autotag runs", f.lens >= 1 && f.autotag >= 1, f);
}

// ---------------------------------------------------------------- story 6: revoke/delete never lower a counter
{
  const kUsed = await createKey(A, `R8 Counted ${stamp}`);
  const kUsed2 = await createKey(A, `R8 Counted2 ${stamp}`);
  const u1 = await v1(kUsed.key, { urls: [fx("article", "bare-1")] });
  const u2 = await v1(kUsed2.key, { urls: [fx("article", "bare-2")] });
  const beforeRows = counters(UA);
  const sumBefore = (await summary()).quotas.links;
  const rev = await authApi(A, "POST", "update", { keyId: kUsed.id, enabled: false });
  const del = await authApi(A, "POST", "delete", { keyId: kUsed2.id });
  const delRevoked = await authApi(A, "POST", "delete", { keyId: kRevoke.id });
  const afterRows = counters(UA);
  const sumAfter = (await summary()).quotas.links;
  say(`ROWS before revoke/delete: ${JSON.stringify(beforeRows)}`);
  say(`ROWS after  revoke/delete: ${JSON.stringify(afterRows)}`);
  check("6", "both keys were used (charged writes) before revoke/delete", u1.status === 202 && u2.status === 202);
  check("6", "revoke + delete + delete-revoked succeeded", rev.status === 200 && del.status === 200 && delRevoked.status === 200, [rev.status, del.status, delRevoked.status]);
  // r9 contract: revoke and delete are never charged, so both counter rows stay identical.
  const row = (rows: any[], prefix: string) => rows.find((r) => r.key.startsWith(prefix));
  const wb = row(beforeRows, "writes:"), wa = row(afterRows, "writes:");
  check("6", "links counter row identical before and after revoke/delete", JSON.stringify(row(beforeRows, "links:")) === JSON.stringify(row(afterRows, "links:")), { beforeRows, afterRows });
  check("6", "writes row identical before and after revoke, delete, delete-revoked (not charged, never lowered)", JSON.stringify(wb) === JSON.stringify(wa), { wb, wa });
  check("6", "Usage links quota identical before and after", sumBefore.used === sumAfter.used, { sumBefore, sumAfter });
  await authApi(A, "POST", "update", { keyId: kUsed.id, enabled: true });
  await authApi(A, "POST", "delete", { keyId: kUsed.id });
}

// ---------------------------------------------------------------- story 8: usage keeps revoked and deleted keys
{
  // Two more keys that add links, then end revoked and deleted, so Usage must keep them by stored name.
  await freshMinute(50);
  // links are capped at 500 now: restore the real count (seed minus the 498 offset) so new links fit.
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const restored = q<{ n: number }>("SELECT count(*) n FROM links WHERE user_id=? AND created_at>=?", UA, new Date(hour * 1000).toISOString())[0]!.n;
  db.run("UPDATE app_rate_limits SET count=? WHERE key=? AND window_start=?", [restored, `links:${UA}`, hour]);
  say(`SEED [8] links:${UA} restored to the hour's real created links: ${restored}`);
  const kr = await createKey(A, `R8 UsageRevoked ${stamp}`);
  const kd = await createKey(A, `R8 UsageDeleted ${stamp}`);
  const r1 = await v1(kr.key, { urls: [fx("article", "u-r1"), fx("article", "u-r2")] });
  const r2 = await v1(kd.key, { urls: [fx("article", "u-d1"), fx("article", "u-d2"), fx("article", "u-d3"), fx("article", "bare-1")] });
  const webAdd = await priv(A, "POST", "/links", { url: fx("article", "u-web") });
  await authApi(A, "POST", "update", { keyId: kr.id, enabled: false });
  await authApi(A, "POST", "delete", { keyId: kd.id });
  const s = await summary();
  const row = (id: string) => s.month.apiKeys.find((k: any) => k.id === id);
  check("8", "setup submits accepted", r1.status === 202 && r2.status === 202 && webAdd.status === 201, [r1.status, r2.status, webAdd.status]);
  check("8", "revoked key listed with stored name, status revoked, 2 links", row(kr.id)?.name === kr.name && row(kr.id)?.status === "revoked" && row(kr.id)?.links === 2, row(kr.id));
  check("8", "deleted key listed with stored name, status deleted, 3 links (its duplicate excluded)", row(kd.id)?.name === kd.name && row(kd.id)?.status === "deleted" && row(kd.id)?.links === 3, row(kd.id));
  const apiSum = s.month.apiKeys.reduce((n: number, k: any) => n + k.links, 0);
  const dbMonth = q<{ n: number }>("SELECT count(*) n FROM links WHERE user_id=? AND created_at>=?", UA, s.month.start)[0]!.n;
  check("8", "month links = D1 count; web = total - API keys", s.month.links === dbMonth && s.month.web === s.month.links - apiSum && s.month.web >= 1, { links: s.month.links, dbMonth, web: s.month.web, apiSum });
  check("8", "quota reads links used / 500 with a reset time", s.quotas.links.max === 500 && typeof s.quotas.links.resetsAt === "string", s.quotas.links);
  check("8", "features list Extract, Content, Lenses, Autotag, OCR, Autogroup and a total", ["extract", "content", "lens", "autotag", "ocr", "autogroup"].every((k) => s.month.features.some((f: any) => f.key === k)) && "usd" in s.month.total, s.month.features.map((f: any) => `${f.key}:${f.runs}`));
  writeFileSync(join(import.meta.dir, "api-checks-r9-usage.json"), JSON.stringify(s, null, 2));
}

const failed = results.filter((r) => !r.ok);
const byStory: Record<string, { pass: number; fail: number }> = {};
for (const r of results) {
  byStory[r.story] ??= { pass: 0, fail: 0 };
  byStory[r.story]![r.ok ? "pass" : "fail"]++;
}
say(`\nTOTAL ${results.length - failed.length}/${results.length} passed; by story ${JSON.stringify(byStory)}`);
writeFileSync(join(import.meta.dir, "api-checks-r9.json"), JSON.stringify({ stamp, ui: UI, commit: session.commit, byStory, results }, null, 2));
process.exit(failed.length ? 1 : 0);
