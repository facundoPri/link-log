// FAC-44 API checks (round 6: round-5 script with R5-unconfirmed expecting oldKey.status "unconfirmed", plus R6-same-key-race) against a running verify-linklog instance.
// Usage: bun api-checks.ts --session <run>/session.json [--origin <worker or UI origin>] [--cors-origin <extra origin>]
// Reads the two accounts' session cookies from session.json and the local D1 file under <run>/state.
// Prints one PASS/FAIL line per check with the HTTP status and key response fields; exits 1 on any FAIL.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sessionPath = arg("--session");
if (!sessionPath) throw new Error("--session <run>/session.json is required");
const session = JSON.parse(readFileSync(sessionPath, "utf8"));
const ORIGIN: string = arg("--origin") ?? session.api;
const UI: string = session.ui;
const corsOrigins = [ORIGIN, ...(arg("--cors-origin") ? [arg("--cors-origin")!] : [])];
const [A, B] = session.accounts as { email: string; cookie: string }[];
const d1Dir = join(session.runDir, "state/qa-video/v3/d1/miniflare-D1DatabaseObject");
const D1 = join(d1Dir, readdirSync(d1Dir).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")!);
const CAP_MESSAGE = "Send at most 1000 URL candidates per request, repeats and invalid ones included.";
const RUN = `fv${Date.now().toString(36)}`;
const url = (path: string, fixture = "article") => `https://${fixture}.qa.example/${RUN}/${path}`;

let failures = 0;
const results: string[] = [];
function report(ok: boolean, story: string, name: string, detail: unknown) {
  if (!ok) failures++;
  const line = `${ok ? "PASS" : "FAIL"} [${story}] ${name} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`;
  results.push(line);
  console.log(line);
}

function sql(query: string): any[] {
  const p = Bun.spawnSync(["sqlite3", "-json", "-cmd", ".timeout 5000", D1, query]);
  if (p.exitCode !== 0) throw new Error(`sqlite3: ${p.stderr.toString()}`);
  const out = p.stdout.toString().trim();
  return out ? JSON.parse(out) : [];
}
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

type Res = { status: number; body: any; headers: Headers };
const secrets = new Map<string, string>();
const regenerated: { oldId: string; newId: string }[] = [];
const oldKeyOk = (r: Res, oldId: string) => {
  if (r.status === 201) regenerated.push({ oldId, newId: r.body.apiKey.id });
  return r.status === 201 && JSON.stringify(r.body.oldKey) === JSON.stringify({ id: oldId, status: "revoked" });
};
async function http(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; raw?: string; origin?: string } = {}): Promise<Res> {
  const r = await fetch((opts.origin ?? ORIGIN) + path, {
    method,
    headers: opts.headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch {}
  if (body?.apiKey?.id && typeof body.secret === "string") secrets.set(body.apiKey.id, body.secret);
  return { status: r.status, body, headers: r.headers };
}
const submit = (key: string | null, urls: unknown, extra: Record<string, unknown> = {}) =>
  http("POST", "/api/v1/links", { headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: { urls, ...extra } });
const asUser = (who: typeof A) => ({
  get: (path: string) => http("GET", `/api${path}`, { headers: { cookie: who.cookie } }),
  send: (method: string, path: string, body: unknown = {}) =>
    http(method, `/api${path}`, { headers: { cookie: who.cookie, origin: UI, "content-type": "application/json" }, body }),
});
const a = asUser(A), b = asUser(B);
const libraryUrls = async (u: ReturnType<typeof asUser>) => {
  const lib = (await u.get("/library")).body;
  return { lib, urls: new Set<string>(lib.links.flatMap((l: any) => [l.url, l.original_url])) };
};
const summary = async (u: ReturnType<typeof asUser>) => (await u.get("/usage/summary")).body;
const brief = (r: Res) => ({ status: r.status, ...(typeof r.body === "object" ? r.body : { body: String(r.body).slice(0, 120) }) });
const short = (r: Res) => {
  const b = r.body ?? {};
  return {
    status: r.status,
    results: b.results?.map((x: any) => `${x.status}:${x.url}`),
    rejected: b.rejected?.map((x: any) => `${JSON.stringify(x.input).slice(0, 50)} -> ${x.error}`),
    batchId: b.batchId,
    error: b.error,
    code: b.code,
  };
};

const userA = sql(`SELECT id FROM user WHERE email=${q(A.email)}`)[0].id as string;
const userB = sql(`SELECT id FROM user WHERE email=${q(B.email)}`)[0].id as string;
console.log(`origin=${ORIGIN} ui=${UI} run=${RUN} userA=${userA} userB=${userB}\nd1=${D1}`);

const ledger = new Map<string, number>();
const credit = (keyId: string, r: Res) => ledger.set(keyId, (ledger.get(keyId) ?? 0) + (r.body?.results ?? []).filter((x: any) => x.status === "created").length);
const before = await summary(a);

const mk = async (u: ReturnType<typeof asUser>, name: string) => {
  const r = await u.send("POST", "/api-keys", { name });
  if (r.status !== 201) throw new Error(`create key ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.apiKey.id as string, secret: r.body.secret as string, name };
};
const main = await mk(a, `Main ${RUN}`);
const second = await mk(a, `Second ${RUN}`);

// ---------- Story 2: bare URLs, text with several URLs, created/duplicate, rejected with reasons
{
  const r = await submit(main.secret, [url("bare-1"), url("bare-2")]);
  credit(main.id, r);
  report(r.status === 202 && r.body.results.length === 2 && r.body.results.every((x: any) => x.status === "created") && !!r.body.batchId && r.body.rejected.length === 0,
    "2", "bare URLs -> 202, 2 created, batchId", short(r));

  const text = `See [one](${url("text-1")}) and <${url("text-2")}>, plus ${url("text-3")}.`;
  const inputs = [text, `again ${url("text-1")}`, "not a link at all", "ftp://files.example/x", "http://localhost/admin", "mailto:a@b.example", `${url("norm")}?utm_source=news&keep=1`];
  const t = await submit(main.secret, inputs);
  credit(main.id, t);
  const got = t.body.results?.map((x: any) => x.url) ?? [];
  const rej = new Map<string, string>((t.body.rejected ?? []).map((x: any) => [x.input, x.error]));
  report(t.status === 202 && got.length === 4 && [url("text-1"), url("text-2"), url("text-3")].every((u) => got.includes(u)) && t.body.results.every((x: any) => x.status === "created"),
    "2", "text with 3 URLs + repeat in another string -> 4 distinct created (repeat collapsed)", short(t));
  report(t.body.results?.filter((x: any) => x.url === url("text-1")).length === 1 && t.body.results.find((x: any) => x.url === url("text-1"))?.input === text,
    "2", "repeated URL saved once, input is the first string", t.body.results?.find((x: any) => x.url === url("text-1")));
  report(rej.size === 4 && rej.get("not a link at all") === "No valid http or https link found." && rej.has("ftp://files.example/x") && rej.has("http://localhost/admin") && rej.has("mailto:a@b.example") && [...rej.values()].every((e) => e.length > 0),
    "2", "rejected entries carry reasons", Object.fromEntries(rej));
  const norm = t.body.results?.find((x: any) => x.input.includes("utm_source"));
  report(!!norm && !norm.url.includes("utm_source") && norm.url.includes("keep=1"), "2", "same normalization as web (tracking param removed)", norm);

  const { urls: libA } = await libraryUrls(a);
  report([url("bare-1"), url("bare-2"), url("text-1"), url("text-2"), url("text-3")].every((u) => libA.has(u)) && ![...libA].some((u) => u?.includes("localhost")), "2", "created links appear in A's library; rejected text not stored", { libraryLinks: libA.size / 1 });

  const jobsBefore = (await summary(a)).quotas.jobs.used;
  const batchesBefore = (await a.get("/library")).body.batches.length;
  const d = await submit(main.secret, [url("bare-1"), `dup: ${url("text-2")}`]);
  credit(main.id, d);
  const sameIds = d.body.results?.every((x: any) => [r, t].some((p) => p.body.results.some((y: any) => y.id === x.id)));
  report(d.status === 202 && d.body.results?.every((x: any) => x.status === "duplicate") && !("batchId" in d.body) && sameIds, "2", "resubmitted URLs -> duplicate, same ids, no batchId", short(d));
  const jobsAfter = (await summary(a)).quotas.jobs.used;
  const batchesAfter = (await a.get("/library")).body.batches.length;
  report(jobsAfter === jobsBefore && batchesAfter === batchesBefore, "2", "duplicates queue no Extraction (jobs quota and batch count unchanged)", { jobsBefore, jobsAfter, batchesBefore, batchesAfter });

  const m = await submit(main.secret, [url("bare-1"), url("mixed-new")]);
  credit(main.id, m);
  const jobs = m.body.batchId ? (await a.get(`/batches/${m.body.batchId}`)).body.jobs : [];
  const dupId = m.body.results?.find((x: any) => x.status === "duplicate")?.id;
  report(m.status === 202 && m.body.results?.map((x: any) => x.status).join(",") === "duplicate,created" && jobs.length === 1 && !jobs.some((j: any) => j.link_id === dupId),
    "2", "mixed new+duplicate -> batch holds 1 job, none for the duplicate", { ...short(m), batchJobs: jobs.map((j: any) => `${j.link_id}:${j.status}`) });
}

// ---------- Story 3: 400 for zero valid and >100 after extraction; nothing saved
{
  const libBefore = (await a.get("/library")).body.links.length;
  const z = await submit(main.secret, ["nothing here", "ftp://files.example/x", "javascript:alert(1)"]);
  report(z.status === 400 && z.body.error === "No valid http or https link found." && z.body.rejected?.length === 3, "3", "zero valid URLs -> 400 with rejected", short(z));
  const strings = Array.from({ length: 50 }, (_, i) => `pair ${url(`many-${i}-a`)} and ${url(`many-${i}-b`)}`).concat(url("many-extra"));
  const over = await submit(main.secret, strings);
  report(over.status === 400 && over.body.error === "Send at most 100 links per request.", "3", "51 strings holding 101 URLs -> 400", short(over));
  const empty = await submit(main.secret, []);
  report(empty.status === 400, "3", "empty urls -> 400", brief(empty));
  const { lib, urls } = await libraryUrls(a);
  report(lib.links.length === libBefore && ![...urls].some((u) => u?.includes("/many-")), "3", "nothing saved after the 400s", { libBefore, libAfter: lib.links.length });
  const exactly100 = Array.from({ length: 50 }, (_, i) => `pair ${url(`edge-${i}-a`)} and ${url(`edge-${i}-b`)}`);
  void exactly100; // not sent: 100 new Links would consume a fifth of the hour's links quota needed by later checks
}

// ---------- Story 4: 401 missing, invalid, malformed, revoked
{
  const missing = await submit(null, [url("auth-1")]);
  report(missing.status === 401 && missing.body.error === "A valid API key is required.", "4", "missing key -> 401", brief(missing));
  const invalid = await submit("lk_not_a_real_key", [url("auth-1")]);
  report(invalid.status === 401, "4", "invalid key -> 401", brief(invalid));
  const forged = await submit(main.secret.slice(0, -1) + (main.secret.endsWith("a") ? "b" : "a"), [url("auth-1")]);
  report(forged.status === 401, "4", "one-char-altered key -> 401", brief(forged));
  const basic = await http("POST", "/api/v1/links", { headers: { "content-type": "application/json", authorization: `Basic ${main.secret}` }, body: { urls: [url("auth-1")] } });
  report(basic.status === 401, "4", "non-Bearer scheme -> 401", brief(basic));
  const xkey = await http("POST", "/api/v1/links", { headers: { "content-type": "application/json", "x-api-key": main.secret }, body: { urls: [url("auth-1")] } });
  report(xkey.status === 401, "4", "x-api-key header (not Bearer) -> 401", brief(xkey));
  const cookieOnly = await http("POST", "/api/v1/links", { headers: { "content-type": "application/json", cookie: A.cookie, origin: UI }, body: { urls: [url("auth-1")] } });
  report(cookieOnly.status === 401, "4", "session cookie on /api/v1 -> 401 (cookies ignored)", brief(cookieOnly));

  const rv = await mk(a, `Revoke ${RUN}`);
  const ok = await submit(rv.secret, [url("revoke-before")]);
  credit(rv.id, ok);
  const rr = await a.send("POST", `/api-keys/${rv.id}/revoke`, {});
  const after = await submit(rv.secret, [url("revoke-after")]);
  const listed = (await a.get("/api-keys")).body.apiKeys.find((k: any) => k.id === rv.id);
  report(ok.status === 202 && rr.status === 200 && after.status === 401 && listed?.status === "revoked", "4", "key works (202), revoke (200), then 401; stays listed as revoked",
    { before: ok.status, revoke: rr.status, after: after.status, listed });
  report(!(await libraryUrls(a)).urls.has(url("revoke-after")) && !(await libraryUrls(a)).urls.has(url("auth-1")), "4", "nothing saved by rejected keys", "revoke-after and auth-1 absent from library");
  const d1 = sql(`SELECT enabled FROM apikey WHERE id=${q(rv.id)}`)[0];
  report(d1?.enabled === 0, "4", "D1: revoked key row kept with enabled=0", d1);
}

// ---------- Story 5: regenerate on real D1; old 401, new 202; revoked cannot be regenerated; foreign 404; cap on B
{
  const rg = await mk(a, `Regen ${RUN}`);
  const pre = await submit(rg.secret, [url("regen-before")]);
  credit(rg.id, pre);
  const regen = await a.send("POST", `/api-keys/${rg.id}/regenerate`, {});
  const fresh = regen.body.apiKey;
  const oldTry = await submit(rg.secret, [url("regen-old")]);
  const newTry = await submit(regen.body.secret, [url("regen-new")]);
  credit(fresh?.id, newTry);
  report(pre.status === 202 && regen.status === 201 && /^lk_[A-Za-z]{40,}$/.test(regen.body.secret) && regen.body.secret !== rg.secret && fresh?.name === rg.name,
    "5", "regenerate -> 201 with a new lk_ secret, same name", { status: regen.status, apiKey: fresh, secretPrefix: regen.body.secret?.slice(0, 9) });
  report(oldKeyOk(regen, rg.id), "R5-oldKey", "story-5 regenerate response carries oldKey { id: old id, status: revoked }", { oldKey: regen.body.oldKey, oldId: rg.id });
  report(oldTry.status === 401, "5", "old key after regenerate -> 401", brief(oldTry));
  report(newTry.status === 202 && newTry.body.results?.[0]?.status === "created", "5", "new key after regenerate -> 202", short(newTry));
  const rows = sql(`SELECT id,name,enabled,typeof(enabled) t,updatedAt,typeof(updatedAt) ut,createdAt FROM apikey WHERE id IN (${q(rg.id)},${q(fresh.id)})`);
  const oldRow = rows.find((x) => x.id === rg.id), newRow = rows.find((x) => x.id === fresh.id);
  report(oldRow?.enabled === 0 && newRow?.enabled === 1, "5", "D1 apikey: old enabled=0 (raw-SQL claim), new enabled=1", rows);
  const pluginRevoked = sql(`SELECT updatedAt,typeof(updatedAt) ut FROM apikey WHERE id IN (SELECT id FROM apikey WHERE referenceId=${q(userA)} AND enabled=0 AND id<>${q(rg.id)}) LIMIT 1`)[0];
  report(!!pluginRevoked && typeof oldRow?.updatedAt === typeof pluginRevoked.updatedAt && oldRow.ut === pluginRevoked.ut, "5",
    "D1: raw-SQL updatedAt stored with the same type as a plugin-revoked row", { rawSql: { v: oldRow?.updatedAt, t: oldRow?.ut }, plugin: { v: pluginRevoked?.updatedAt, t: pluginRevoked?.ut } });
  const list = (await a.get("/api-keys")).body.apiKeys.filter((k: any) => k.name === rg.name);
  report(list.length === 2 && list.find((k: any) => k.id === rg.id)?.status === "revoked" && list.find((k: any) => k.id === fresh.id)?.status === "active" && !JSON.stringify(list).includes(regen.body.secret),
    "5", "key list: old revoked + new active with the same name, no secret", list);
  const again = await a.send("POST", `/api-keys/${rg.id}/regenerate`, {});
  report(again.status === 409 && again.body.code === "api_key_revoked", "5", "regenerating a revoked key -> 409", brief(again));
  const foreign = await b.send("POST", `/api-keys/${fresh.id}/regenerate`, {});
  const foreignRevoke = await b.send("POST", `/api-keys/${fresh.id}/revoke`, {});
  const stillActive = (await a.get("/api-keys")).body.apiKeys.find((k: any) => k.id === fresh.id)?.status;
  report(foreign.status === 404 && foreignRevoke.status === 404 && stillActive === "active", "5", "user B regenerate/revoke of A's key -> 404, key untouched", { regenerate: foreign.status, revoke: foreignRevoke.status, stillActive });

  const bActive = (await b.get("/api-keys")).body.apiKeys.filter((k: any) => k.status === "active").length;
  for (let i = bActive; i < 10; i++) await mk(b, `Fill ${i} ${RUN}`);
  const eleventh = await b.send("POST", "/api-keys", { name: `Eleventh ${RUN}` });
  const bAfter = (await b.get("/api-keys")).body.apiKeys.filter((k: any) => k.status === "active").length;
  report(eleventh.status === 409 && eleventh.body.error === "You have 10 active API keys. Revoke one to create another." && bAfter === 10, "5", "11th active key refused with a clear message (user B)", { ...brief(eleventh), activeAfter: bAfter });
  const bKey = (await b.get("/api-keys")).body.apiKeys.find((k: any) => k.status === "active");
  const atCapRegen = await b.send("POST", `/api-keys/${bKey.id}/regenerate`, {});
  report(oldKeyOk(atCapRegen, bKey.id), "R5-oldKey", "regenerate at 10 (user B) -> oldKey revoked", { oldKey: atCapRegen.body.oldKey });
  report(atCapRegen.status === 201 && (await b.get("/api-keys")).body.apiKeys.filter((k: any) => k.status === "active").length === 10, "5", "regenerate at 10 active still works, stays at 10", { status: atCapRegen.status });
}

// ---------- Story 9 (part): isolation between users, private routes unreachable with a key, no CORS
const bKey = await (async () => {
  const keys = (await b.get("/api-keys")).body.apiKeys.filter((k: any) => k.status === "active");
  await b.send("POST", `/api-keys/${keys[0].id}/revoke`, {});
  return mk(b, `B Main ${RUN}`);
})();
{
  const aLinkBefore = (await a.get("/library")).body.links.find((l: any) => l.url === url("bare-1"));
  const r = await submit(bKey.secret, [url("bare-1"), url("b-only")], { userId: userA, ownerId: userA, user_id: userA });
  const { urls: aUrls, lib: aLib } = await libraryUrls(a);
  const { urls: bUrls } = await libraryUrls(b);
  const bBare = r.body.results?.find((x: any) => x.url === url("bare-1"));
  report(r.status === 202 && bBare?.status === "created" && bBare.id !== aLinkBefore?.id, "9", "B's key sending A's URL (with userId=A in body) -> created in B's library, not a duplicate of A's", short(r));
  report(bUrls.has(url("b-only")) && bUrls.has(url("bare-1")) && !aUrls.has(url("b-only")), "9", "B's links land in B's library only", { inB: bUrls.has(url("b-only")), inA: aUrls.has(url("b-only")) });
  const aLinkAfter = aLib.links.find((l: any) => l.url === url("bare-1"));
  report(aLinkAfter?.id === aLinkBefore?.id && aLinkAfter?.last_saved_at === aLinkBefore?.last_saved_at, "9", "A's copy of the shared URL untouched (recency not refreshed by B)", { before: aLinkBefore?.last_saved_at, after: aLinkAfter?.last_saved_at });
  const owners = sql(`SELECT user_id,count(*) n FROM links WHERE original_url LIKE ${q(`%/${RUN}/b-only%`)} OR url LIKE ${q(`%/${RUN}/b-only%`)} GROUP BY user_id`);
  report(owners.length === 1 && owners[0].user_id === userB, "9", "D1: b-only link owned by user B only", owners);
  const bBatches = (await b.get("/library")).body.batches.map((x: any) => x.id);
  const aBatches = (await a.get("/library")).body.batches.map((x: any) => x.id);
  report(!!r.body.batchId && bBatches.includes(r.body.batchId) && !aBatches.includes(r.body.batchId), "9", "B's API batch is in B's Activity, not A's", { batchId: r.body.batchId });
}
{
  const aLib = (await a.get("/library")).body;
  const someBatch = aLib.batches[0].id, someLink = aLib.links[0].id;
  const keys = (await a.get("/api-keys")).body.apiKeys;
  const target = keys.find((k: any) => k.id === second.id);
  const bearer = { authorization: `Bearer ${main.secret}` };
  const writeHeaders = { ...bearer, origin: UI, "content-type": "application/json" };
  const routes: [string, string, unknown?][] = [
    ["GET", "/api/library"], ["POST", "/api/links", { url: url("priv-1") }], ["POST", "/api/import", { urls: [url("priv-2")] }],
    ["GET", `/api/links/${someLink}/content`], ["PATCH", `/api/links/${someLink}`, { tags: ["x"] }], ["DELETE", `/api/links/${someLink}`],
    ["GET", `/api/batches/${someBatch}`], ["DELETE", `/api/batches/${someBatch}`], ["POST", "/api/batches", { kind: "extract" }],
    ["GET", "/api/usage"], ["GET", "/api/usage/summary"], ["GET", "/api/api-keys"], ["POST", "/api/api-keys", { name: "via key" }],
    ["POST", `/api/api-keys/${second.id}/regenerate`], ["POST", `/api/api-keys/${second.id}/revoke`], ["GET", "/api/browser/catalog"], ["POST", "/api/tags", { name: "via-key" }],
  ];
  const statuses: Record<string, number> = {};
  for (const [method, path, body] of routes) {
    for (const [label, h] of [["Bearer", writeHeaders], ["x-api-key", { "x-api-key": main.secret, origin: UI, "content-type": "application/json" }]] as const) {
      const res = await http(method, path, { headers: method === "GET" ? (label === "Bearer" ? bearer : { "x-api-key": main.secret }) : h, body: method === "GET" ? undefined : (body ?? {}) });
      statuses[`${label} ${method} ${path.replace(/[0-9a-f-]{20,}/g, ":id")}`] = res.status;
    }
  }
  report(Object.values(statuses).every((s) => s === 401), "9", "API key on every private route -> 401", statuses);
  const gs = await http("GET", "/api/auth/get-session", { headers: bearer });
  report(gs.status === 200 && (gs.body === null || gs.body === "null" || !gs.body?.user), "9", "Better Auth get-session with Bearer key -> no session", { status: gs.status, body: gs.body });
  const plugin: Record<string, number> = {};
  for (const [m, p] of [["GET", "/api/auth/api-key/list"], ["POST", "/api/auth/api-key/create"], ["POST", "/api/auth/api-key/update"], ["POST", "/api/auth/api-key/delete"], ["POST", "/api/auth/api-key/verify"], ["GET", "/api/auth/api-key/get"]] as const) {
    plugin[`${m} ${p}`] = (await http(m, p, { headers: { ...bearer, "x-api-key": main.secret, origin: UI, "content-type": "application/json" }, body: m === "GET" ? undefined : { key: main.secret, keyId: second.id, name: "x" } })).status;
  }
  report(Object.values(plugin).every((s) => s >= 400), "9", "plugin's own api-key endpoints unreachable (non-2xx)", plugin);
  const v1: Record<string, number> = {};
  for (const [m, p] of [["GET", "/api/v1/links"], ["GET", "/api/v1/library"], ["POST", "/api/v1/import"], ["GET", "/api/v1/usage/summary"], ["GET", "/api/v1/%2e%2e/library"], ["GET", "/api/v1/../library"]] as const) {
    const res = await http(m, p, { headers: { ...bearer, "content-type": "application/json" }, body: m === "GET" ? undefined : { urls: [url("v1-x")] } });
    v1[`${m} ${p}`] = res.status;
    if (res.status === 200) v1[`${m} ${p} body`] = String(JSON.stringify(res.body)).slice(0, 80) as any;
  }
  report(Object.entries(v1).every(([p, s]) => (p.includes("..") || p.includes("%2e") ? typeof s === "number" && s >= 400 : s === 404)), "9", "other /api/v1 paths and methods with a valid key -> 404 (traversal attempts non-2xx)", v1);
  const after = (await a.get("/library")).body;
  const keyAfter = (await a.get("/api-keys")).body.apiKeys.find((k: any) => k.id === second.id);
  report(after.links.some((l: any) => l.id === someLink) && after.batches.some((x: any) => x.id === someBatch) && keyAfter?.status === "active" && target?.status === "active" && !after.links.some((l: any) => [url("priv-1"), url("priv-2")].includes(l.url)),
    "9", "state unchanged after the attempts (link, batch, target key active, nothing added)", { keyAfter: keyAfter?.status });

  for (const origin of corsOrigins) {
    const post = await http("POST", "/api/v1/links", { origin, headers: { ...bearer, "content-type": "application/json", origin: "https://evil.example" }, body: { urls: [url("cors-1")] } });
    credit(main.id, post);
    const pre = await http("OPTIONS", "/api/v1/links", { origin, headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    const acPost = [...post.headers.keys()].filter((h) => h.startsWith("access-control-"));
    const acPre = [...pre.headers.keys()].filter((h) => h.startsWith("access-control-"));
    report(acPost.length === 0 && acPre.length === 0 && pre.status !== 204 && !(pre.status >= 200 && pre.status < 300), "9", `no CORS headers on POST or OPTIONS preflight (${origin})`,
      { post: post.status, postAccessControl: acPost, preflight: pre.status, preflightAccessControl: acPre, preflightAllow: pre.headers.get("allow") });
  }
}

// ---------- Story 6: 429 per key (60/min), code api_key, Retry-After, nothing saved
{
  const rate = await mk(a, `Rate ${RUN}`);
  const sec = new Date().getUTCSeconds();
  if (sec > 35) await Bun.sleep((61 - sec) * 1000);
  const linksBefore = (await summary(a)).quotas.links.used;
  const burst = await Promise.all(Array.from({ length: 60 }, () => submit(rate.secret, ["no link here"])));
  const counts = burst.reduce((m: Record<number, number>, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const t61 = Date.now();
  const over = await submit(rate.secret, [url("rate-61")]);
  const retry = Number(over.headers.get("retry-after"));
  const expected = 60 - (Math.floor(t61 / 1000) % 60);
  report(counts[400] === 60, "6", "60 requests in the window pass the key limit (all 400 no-link)", counts);
  report(over.status === 429 && over.body.code === "api_key" && over.body.error === "API key request limit reached. Try again later." && retry >= 1 && retry <= 60 && Math.abs(retry - expected) <= 2,
    "6", "61st request -> 429 code api_key with Retry-After to minute end", { status: over.status, body: over.body, retryAfter: retry, expectedAbout: expected });
  const linksAfter = (await summary(a)).quotas.links.used;
  report(!(await libraryUrls(a)).urls.has(url("rate-61")) && linksAfter === linksBefore, "6", "nothing saved on the api_key 429", { linksBefore, linksAfter });
  const other = await submit(main.secret, [url("rate-other-key")]);
  credit(main.id, other);
  report(other.status === 202, "6", "limit is per key: another key of the same user still 202", short(other));
}

// ---------- Story 6 (quotas): seed B's links / jobs windows in D1, expect 429 links / jobs, nothing saved
{
  const hour = Math.floor(Date.now() / 1000 / 3600) * 3600;
  const saved = sql(`SELECT key,window_start,count FROM app_rate_limits WHERE key IN (${q(`links:${userB}`)},${q(`jobs:${userB}`)})`);
  const set = (key: string, count: number) => sql(`INSERT INTO app_rate_limits(key,window_start,count) VALUES(${q(key)},${hour},${count}) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=excluded.count`);
  const count = (key: string) => sql(`SELECT count FROM app_rate_limits WHERE key=${q(key)} AND window_start=${hour}`)[0]?.count ?? 0;
  try {
    const jobs0 = count(`jobs:${userB}`);
    set(`links:${userB}`, 499);
    const batches0 = (await b.get("/library")).body.batches.length;
    const t = Date.now();
    const r = await submit(bKey.secret, [url("q-links-1"), url("q-links-2")]);
    const retry = Number(r.headers.get("retry-after"));
    const expected = hour + 3600 - Math.floor(t / 1000);
    const { urls, lib } = await libraryUrls(b);
    report(r.status === 429 && r.body.code === "links" && Math.abs(retry - expected) <= 2, "6", "links window at 499/500 + 2 new URLs -> 429 code links, Retry-After to hour end", { status: r.status, body: r.body, retryAfter: retry, expectedAbout: expected });
    report(!urls.has(url("q-links-1")) && !urls.has(url("q-links-2")) && lib.batches.length === batches0 && count(`links:${userB}`) === 499 && count(`jobs:${userB}`) === jobs0,
      "6", "nothing saved on links 429 (no links, no batch, counters refunded)", { links: count(`links:${userB}`), jobs: count(`jobs:${userB}`), jobsBefore: jobs0 });
    const one = await submit(bKey.secret, [url("q-links-ok")]);
    const web = await b.send("POST", "/import", { urls: [url("q-links-web")] });
    report(one.status === 202 && web.status === 429 && web.body.code === "links", "6", "quota shared with Web: API fills to 500, then web import -> 429 links", { api: one.status, web: brief(web) });

    set(`links:${userB}`, 0);
    set(`jobs:${userB}`, 299);
    const j = await submit(bKey.secret, [url("q-jobs-1"), url("q-jobs-2")]);
    const after = await libraryUrls(b);
    report(j.status === 429 && j.body.code === "jobs" && Number(j.headers.get("retry-after")) >= 1, "6", "jobs window at 299/300 + 2 new URLs -> 429 code jobs with Retry-After", { status: j.status, body: j.body, retryAfter: j.headers.get("retry-after") });
    report(!after.urls.has(url("q-jobs-1")) && !after.urls.has(url("q-jobs-2")) && count(`links:${userB}`) === 0 && count(`jobs:${userB}`) === 299, "6", "nothing saved on jobs 429 (links counter refunded)", { links: count(`links:${userB}`), jobs: count(`jobs:${userB}`) });
  } finally {
    sql(`DELETE FROM app_rate_limits WHERE key IN (${q(`links:${userB}`)},${q(`jobs:${userB}`)})`);
    for (const row of saved) sql(`INSERT INTO app_rate_limits(key,window_start,count) VALUES(${q(row.key)},${row.window_start},${row.count})`);
  }
}

// ---------- Story 8: usage read model against the ledger (A), Duplicates excluded
{
  const web = await a.send("POST", "/import", { urls: [url("web-1"), url("web-2"), url("bare-1")] });
  const u = await summary(a);
  const created = [...ledger.values()].reduce((s, n) => s + n, 0);
  const dLinks = u.month.links - before.month.links, dWeb = u.month.web - before.month.web;
  const byKey = Object.fromEntries([...ledger].map(([id, n]) => [id, { expected: n, got: u.month.apiKeys.find((k: any) => k.id === id)?.links ?? 0 }]));
  report(web.status === 200 || web.status === 201 || web.status === 202, "8", "web import of 2 new + 1 duplicate accepted", { status: web.status });
  report(dLinks === created + 2 && dWeb === 2, "8", "month links delta = API created + 2 web; Web delta = 2 (duplicates excluded)", { dLinks, expected: created + 2, dWeb });
  report(Object.values(byKey).every((v) => v.expected === v.got), "8", "per-key month counts match what each key created (old and regenerated keys separate, revoked included)", byKey);
  report(u.quotas.links.used - before.quotas.links.used === created + 2 && u.quotas.jobs.used - before.quotas.jobs.used === created + 2 && u.quotas.links.max === 500 && u.quotas.jobs.max === 300,
    "8", "quota windows: links and jobs used grew by the created count only", { links: u.quotas.links, jobs: u.quotas.jobs, deltaExpected: created + 2 });
  const monthStart = u.month.start;
  const d1 = sql(`SELECT count(*) n FROM links WHERE user_id=${q(userA)} AND created_at>=${q(monthStart)}`)[0].n;
  report(d1 === u.month.links, "8", "D1 count of A's links this month equals summary total", { d1, summary: u.month.links });
  console.log(`USAGE ${JSON.stringify(u)}`);
}

// ---------- Round 2: extraction count edges, per-string length, linear scan, rule reasons, cap races, regenerate at 10
{
  const r2 = await mk(a, `R2 ${RUN}`);
  const timed = async (urls: unknown) => {
    const t0 = performance.now();
    const r = await submit(r2.secret, urls);
    return { r, ms: Math.round(performance.now() - t0) };
  };

  const hundred = Array.from({ length: 50 }, (_, i) => `pair ${url(`h100-${i}-a`)} and ${url(`h100-${i}-b`)}`)
    .concat(`repeat ${url("h100-0-a")} (already in this request)`, "no link in this one");
  const h = await submit(r2.secret, hundred);
  credit(r2.id, h);
  const hJobs = h.body.batchId ? (await a.get(`/batches/${h.body.batchId}`)).body.jobs : [];
  const hLib = (await libraryUrls(a)).urls;
  const hAll = Array.from({ length: 50 }, (_, i) => [url(`h100-${i}-a`), url(`h100-${i}-b`)]).flat();
  report(h.status === 202 && h.body.results?.length === 100 && h.body.results.every((x: any) => x.status === "created") && new Set(h.body.results.map((x: any) => x.url)).size === 100
    && h.body.rejected?.length === 1 && hJobs.length === 100 && hAll.every((u) => hLib.has(u)),
    "R2-3", "exactly 100 distinct URLs after extraction (52 strings, one in-request repeat, one no-link) -> 202, 100 created, 100 jobs",
    { status: h.status, results: h.body.results?.length, distinct: new Set(h.body.results?.map((x: any) => x.url)).size, rejected: h.body.rejected, batchJobs: hJobs.length, inLibrary: hAll.filter((u) => hLib.has(u)).length });

  const over = Array.from({ length: 50 }, (_, i) => `pair ${url(`h101-${i}-a`)} and ${url(`h101-${i}-b`)}`)
    .concat(`repeat ${url("h101-3-b")}`, url("h101-extra"));
  const o = await submit(r2.secret, over);
  const oLib = (await libraryUrls(a)).urls;
  report(o.status === 400 && o.body.error === "Send at most 100 links per request." && ![...oLib].some((u) => u?.includes("/h101-")),
    "R2-3", "101 distinct URLs after extraction (with an in-request repeat) -> 400, nothing saved", { ...short(o), savedAny: [...oLib].some((u) => u?.includes("/h101-")) });

  const okUrl = url("len-8192");
  const exact = `${okUrl} ${"x".repeat(8192 - okUrl.length - 1)}`;
  const e8192 = await submit(r2.secret, [exact]);
  credit(r2.id, e8192);
  report(exact.length === 8192 && e8192.status === 202 && e8192.body.results?.[0]?.url === okUrl, "R2-len", "string of exactly 8192 characters is accepted (202)", { length: exact.length, ...short(e8192) });
  const longUrl = url("len-8193");
  const longOne = `${longUrl} ${"x".repeat(8193 - longUrl.length - 1)}`;
  const e8193 = await submit(r2.secret, [url("len-companion"), longOne]);
  const lLib = (await libraryUrls(a)).urls;
  report(longOne.length === 8193 && e8193.status === 400 && typeof e8193.body.error === "string" && e8193.body.error.includes("8192") && !lLib.has(url("len-companion")) && !lLib.has(longUrl),
    "R2-len", "one string of 8193 characters -> 400 naming the 8192 limit, valid companion string not saved", { length: longOne.length, status: e8193.status, error: e8193.body.error, companionSaved: lLib.has(url("len-companion")) });

  const mega = `${url("parens")}${")".repeat(1_000_000)}`;
  const m = await timed([mega]);
  report(m.r.status === 400 && String(m.r.body.error).includes("8192") && m.ms < 2000, "R2-len", "~1 MB string of trailing ')' -> 400 with the limit, fast",
    { chars: mega.length, status: m.r.status, error: m.r.body.error, latencyMs: m.ms });

  const parenUrl = url("paren-max");
  const parenMax = `${parenUrl}${")".repeat(8192 - parenUrl.length)}`;
  const p1 = await timed([parenMax]);
  credit(r2.id, p1.r);
  report(parenMax.length === 8192 && p1.r.status === 202 && p1.r.body.results?.[0]?.url === parenUrl && p1.ms < 2000, "R2-scan", "8192-char URL with 8150+ trailing ')' is scanned, parens trimmed, fast",
    { chars: parenMax.length, status: p1.r.status, url: p1.r.body.results?.[0]?.url, latencyMs: p1.ms });
  const bulk = Array.from({ length: 240 }, () => parenMax);
  const bodyBytes = JSON.stringify({ urls: bulk }).length;
  const p2 = await timed(bulk);
  report(p2.r.status === 202 && p2.r.body.results?.length === 1 && p2.r.body.results[0].status === "duplicate" && p2.ms < 5000, "R2-scan",
    "240 strings x 8192 chars of trailing ')' (body under 2.1 MB) -> 202 one duplicate, fast", { bodyBytes, status: p2.r.status, results: p2.r.body.results?.length, latencyMs: p2.ms });

  const tooLongUrl = `https://article.qa.example/${RUN}/${"a".repeat(4100)}`;
  const reasons = [
    ["see http://localhost/admin now", "Use a public http or https link."],
    [`https://user:pw@article.qa.example/${RUN}/creds`, "Use a public http or https link."],
    [tooLongUrl, "Paste a valid URL."],
    ["no link here at all", "No valid http or https link found."],
  ];
  const mixedText = `bad http://localhost/x but good ${url("reason-mixed")}`;
  const rr = await submit(r2.secret, [url("reason-ok"), ...reasons.map(([i]) => i), mixedText]);
  credit(r2.id, rr);
  const got = new Map<string, string>((rr.body.rejected ?? []).map((x: any) => [x.input, x.error]));
  const rows = reasons.map(([input, want]) => ({ input: input.slice(0, 60), want, got: got.get(input) }));
  report(rr.status === 202 && rows.every((x) => x.want === x.got) && got.size === 4 && rr.body.results?.some((x: any) => x.url === url("reason-mixed")),
    "R2-reason", "rejected candidates report the URL rule they broke; a string with one bad and one good URL is accepted", { status: rr.status, rows, mixedAccepted: rr.body.results?.some((x: any) => x.url === url("reason-mixed")) });

  const activeApi = async () => (await a.get("/api-keys")).body.apiKeys.filter((k: any) => k.status === "active");
  const activeD1 = () => sql(`SELECT count(*) n FROM apikey WHERE referenceId=${q(userA)} AND enabled=1`)[0].n as number;
  const setActive = async (n: number) => {
    let act = await activeApi();
    for (const k of act.filter((k: any) => k.id !== r2.id).slice(0, Math.max(0, act.length - n))) await a.send("POST", `/api-keys/${k.id}/revoke`, {});
    for (let i = act.length; i < n; i++) await mk(a, `Pad ${i} ${RUN}`);
    act = await activeApi();
    return act.length;
  };
  const races: unknown[] = [];
  let raceOk = true;
  for (const [trial, start, parallel] of [[1, 8, 5], [2, 8, 5], [3, 8, 5], [4, 8, 10], [5, 9, 6]] as const) {
    const at = await setActive(start);
    const beforeIds = new Set((await activeApi()).map((k: any) => k.id));
    const res = await Promise.all(Array.from({ length: parallel }, (_, i) => a.send("POST", "/api-keys", { name: `Race ${trial}.${i} ${RUN}` })));
    const statuses = res.map((r) => r.status);
    const won = res.filter((r) => r.status === 201);
    const act = await activeApi();
    const d1n = activeD1();
    const newActive = act.filter((k: any) => !beforeIds.has(k.id)).map((k: any) => k.id).sort();
    const wonIds = won.map((r) => r.body.apiKey.id).sort();
    const refusedClean = res.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.code === "api_key_limit" && !r.body.secret);
    const works = await Promise.all(won.map((r) => submit(r.body.secret, ["race probe, no link"])));
    const ok = at === start && act.length <= 10 && d1n <= 10 && d1n === act.length && JSON.stringify(newActive) === JSON.stringify(wonIds) && refusedClean && works.every((w) => w.status === 400);
    if (!ok) raceOk = false;
    races.push({ trial, startActive: at, parallel, statuses, activeApi: act.length, activeD1: d1n, wonIds: wonIds.length, newActive: newActive.length, refusedClean, winnersAuthenticate: works.map((w) => w.status) });
  }
  report(raceOk, "R2-race", "parallel creates never leave more than 10 active (API list and D1 agree); every 201 key is active and authenticates; refusals are clean 409s", races);

  await setActive(10);
  const tenBefore = { api: (await activeApi()).length, d1: activeD1() };
  const target = (await activeApi()).find((k: any) => k.id === r2.id) ?? (await activeApi())[0];
  const oldSecret = target.id === r2.id ? r2.secret : null;
  const regen = await a.send("POST", `/api-keys/${target.id}/regenerate`, {});
  const tenAfter = { api: (await activeApi()).length, d1: activeD1() };
  report(oldKeyOk(regen, target.id), "R5-oldKey", "R2 regenerate at exactly 10 -> oldKey revoked", { oldKey: regen.body.oldKey, oldId: target.id });
  const newWorks = await submit(regen.body.secret, [url("regen-at-10")]);
  credit(regen.body.apiKey?.id, newWorks);
  const oldFails = oldSecret ? (await submit(oldSecret, [url("regen-at-10-old")])).status : "n/a";
  const listed = (await a.get("/api-keys")).body.apiKeys;
  report(tenBefore.api === 10 && tenBefore.d1 === 10 && regen.status === 201 && tenAfter.api === 10 && tenAfter.d1 === 10 && newWorks.status === 202 && oldFails === 401
    && listed.find((k: any) => k.id === target.id)?.status === "revoked" && listed.find((k: any) => k.id === regen.body.apiKey.id)?.status === "active",
    "R2-regen", "regenerate at exactly 10 active -> 201, still 10 active (API and D1), new works, old 401", { tenBefore, status: regen.status, tenAfter, newSubmit: newWorks.status, oldSubmit: oldFails });

  const dump = sql(`SELECT id,name,start,prefix,enabled,referenceId,createdAt,updatedAt FROM apikey ORDER BY referenceId,createdAt`);
  await Bun.write(arg("--d1-dump") ?? "/dev/null", JSON.stringify(dump, null, 1));
  console.log(`D1 apikey rows: ${dump.length}, active per user: ${JSON.stringify(sql(`SELECT referenceId,sum(enabled) active,count(*) total FROM apikey GROUP BY referenceId`))}`);
}


// ---------- Round 3: 1000-match cap with repeats, linear tracking-param normalization, malformed/unknown bearer, race leaves no phantom rows, regenerate
{
  for (const k of (await a.get("/api-keys")).body.apiKeys.filter((k: any) => k.status === "active").slice(8)) await a.send("POST", `/api-keys/${k.id}/revoke`, {});
  const r3 = await mk(a, `R3 ${RUN}`);
  const timed = async (key: string, urls: unknown) => {
    const t0 = performance.now();
    const r = await submit(key, urls);
    return { r, ms: Math.round(performance.now() - t0) };
  };
  const state = async () => ({ links: (await summary(a)).quotas.links.used, jobs: (await summary(a)).quotas.jobs.used, batches: (await a.get("/library")).body.batches.length });

  const capUrl = url("cap-over");
  const s0 = await state();
  const over = await submit(r3.secret, Array.from({ length: 600 }, () => `twice ${capUrl} and ${capUrl}`));
  const s1 = await state();
  const lib1 = (await libraryUrls(a)).urls;
  report(over.status === 400 && over.body.error === CAP_MESSAGE && !lib1.has(capUrl) && JSON.stringify(s0) === JSON.stringify(s1),
    "R3-cap", "600 strings x 2 identical URLs (1200 matches, 1 distinct) -> 400 naming the 1000 cap, nothing saved", { status: over.status, body: over.body, saved: lib1.has(capUrl), before: s0, after: s1 });

  const edgeUrl = url("cap-edge");
  const at1001 = await submit(r3.secret, [...Array.from({ length: 500 }, () => `twice ${edgeUrl} and ${edgeUrl}`), edgeUrl]);
  const s2 = await state();
  report(at1001.status === 400 && String(at1001.body.error).includes("1000") && !(await libraryUrls(a)).urls.has(edgeUrl) && JSON.stringify(s2) === JSON.stringify(s1),
    "R3-cap", "1001 matches of one URL (500 x 2 + 1) -> 400, nothing saved", { status: at1001.status, body: at1001.body, after: s2 });

  const at1000 = await submit(r3.secret, Array.from({ length: 500 }, () => `twice ${edgeUrl} and ${edgeUrl}`));
  credit(r3.id, at1000);
  const jobs1000 = at1000.body.batchId ? (await a.get(`/batches/${at1000.body.batchId}`)).body.jobs : [];
  report(at1000.status === 202 && at1000.body.results?.length === 1 && at1000.body.results[0].status === "created" && at1000.body.results[0].url === edgeUrl && jobs1000.length === 1 && (await libraryUrls(a)).urls.has(edgeUrl),
    "R3-cap", "exactly 1000 matches of one URL (500 x 2) -> 202 with one created result and one job", { ...short(at1000), jobs: jobs1000.length });

  const tracking = Array.from({ length: 400 }, (_, j) => `utm_${j}=v`).join("&");
  const plainUrls = Array.from({ length: 100 }, (_, i) => `${url(`utm-${i}`)}?keep=${i}`);
  const utmUrls = plainUrls.map((u) => `${u}&${tracking}&fbclid=f&gclid=g`);
  const maxLen = Math.max(...utmUrls.map((u) => u.length));
  const base = Array.from({ length: 100 }, (_, i) => `${url(`base-${i}`)}?keep=${i}`);
  const bBefore = (await summary(b)).quotas.jobs.used;
  const runs = { createdPlain: [] as number[], createdUtm: [] as number[], dupPlain: [] as number[], dupUtm: [] as number[] };
  const cPlain = await timed(bKey.secret, base);
  runs.createdPlain.push(cPlain.ms);
  const cUtm = await timed(bKey.secret, utmUrls);
  runs.createdUtm.push(cUtm.ms);
  for (let i = 0; i < 3; i++) {
    runs.dupPlain.push((await timed(bKey.secret, base)).ms);
    const d = await timed(bKey.secret, utmUrls);
    runs.dupUtm.push(d.ms);
    if (d.r.status !== 202 || !d.r.body.results.every((x: any) => x.status === "duplicate")) runs.dupUtm.push(-1);
  }
  const med = (xs: number[]) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const got = (cUtm.r.body.results ?? []).map((x: any) => x.url);
  const bLib = (await b.get("/library")).body.links.filter((l: any) => l.url.includes(`/${RUN}/utm-`));
  const d1Utm = sql(`SELECT count(*) n FROM links WHERE user_id=${q(userB)} AND url LIKE ${q(`%/${RUN}/utm-%`)} AND (url LIKE '%utm\\_%' ESCAPE '\\' OR url LIKE '%fbclid%' OR url LIKE '%gclid%')`)[0].n;
  report(cPlain.r.status === 202 && cUtm.r.status === 202 && cUtm.r.body.results.length === 100 && cUtm.r.body.results.every((x: any) => x.status === "created") && JSON.stringify(got) === JSON.stringify(plainUrls)
    && bLib.length === 100 && bLib.every((l: any) => plainUrls.includes(l.url)) && d1Utm === 0 && maxLen < 4096,
    "R3-utm", "100 URLs x 402 tracking params (400 distinct utm_N + fbclid + gclid) -> 202, 100 created, each normalized to exactly <url>?keep=N (library and D1 agree)",
    { maxUrlChars: maxLen, bodyBytes: JSON.stringify({ urls: utmUrls }).length, status: cUtm.r.status, created: cUtm.r.body.results?.length, sample: { input: utmUrls[7].slice(0, 90) + "...", url: got[7] }, libraryRows: bLib.length, d1RowsWithTracking: d1Utm });
  const slow = med(runs.dupUtm) - med(runs.dupPlain);
  report(!runs.dupUtm.includes(-1) && cUtm.ms < 3000 && med(runs.dupUtm) < 2000 && slow < 500, "R3-utm", "tracking-param normalization is fast (latency ms, same key/user, plain vs 400-param URLs)",
    { runs, medianDupPlain: med(runs.dupPlain), medianDupUtm: med(runs.dupUtm), extraMsFor40kParams: slow, jobsUsedByB: (await summary(b)).quotas.jobs.used - bBefore });

  const letters = (n: number) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 52)]).join("");
  const body0 = r3.secret.slice(3);
  const malformed: Record<string, string> = {
    "wrong prefix sk_": `sk_${body0}`,
    "uppercase prefix LK_": `LK_${body0}`,
    "no prefix": body0,
    "63 letters": r3.secret.slice(0, -1),
    "65 letters": `${r3.secret}a`,
    "digit in body": `${r3.secret.slice(0, -1)}1`,
    "dash in body": `${r3.secret.slice(0, -1)}-`,
    "empty after prefix": "lk_",
  };
  const mal: Record<string, unknown> = {};
  for (const [label, key] of Object.entries(malformed)) {
    const r = await submit(key, [url(`mal-${label.replace(/\W/g, "")}`)]);
    mal[label] = { status: r.status, error: r.body?.error };
  }
  report(r3.secret.length === 67 && /^lk_[A-Za-z]{64}$/.test(r3.secret) && Object.values(mal).every((x: any) => x.status === 401 && x.error === "A valid API key is required."),
    "R3-auth", "malformed bearer (prefix, length, charset) -> 401 'A valid API key is required.'", { issuedShape: `lk_ + ${r3.secret.length - 3} letters`, results: mal });
  const unknownKey = `lk_${letters(64)}`;
  const unk = await submit(unknownKey, [url("unknown-key")]);
  report(/^lk_[A-Za-z]{64}$/.test(unknownKey) && unk.status === 401 && unk.body.error === "A valid API key is required." && !(await libraryUrls(a)).urls.has(url("unknown-key")),
    "R3-auth", "well-formed but unknown lk_ key -> 401, nothing saved", brief(unk));
  const rv = await mk(a, `R3 revoke ${RUN}`);
  const rvOk = await submit(rv.secret, ["probe, no link"]);
  await a.send("POST", `/api-keys/${rv.id}/revoke`, {});
  const lastBefore = (await a.get("/api-keys")).body.apiKeys.find((k: any) => k.id === rv.id);
  const d1Before = sql(`SELECT lastRequest,requestCount,updatedAt FROM apikey WHERE id=${q(rv.id)}`)[0];
  const rvAfter = await submit(rv.secret, [url("r3-revoked")]);
  await Bun.sleep(300);
  const lastAfter = (await a.get("/api-keys")).body.apiKeys.find((k: any) => k.id === rv.id);
  const d1After = sql(`SELECT lastRequest,requestCount,updatedAt FROM apikey WHERE id=${q(rv.id)}`)[0];
  report(rvOk.status === 400 && rvAfter.status === 401 && lastBefore?.status === "revoked" && lastAfter?.lastUsedAt === lastBefore?.lastUsedAt && JSON.stringify(d1After) === JSON.stringify(d1Before),
    "R3-auth", "revoked key -> 401 and its row is untouched (last use, request count, updatedAt unchanged)", { beforeRevoke: rvOk.status, after: brief(rvAfter), listLastUsed: [lastBefore?.lastUsedAt, lastAfter?.lastUsedAt], d1Before, d1After });

  const listAll = async () => (await a.get("/api-keys")).body.apiKeys as any[];
  const active = async () => (await listAll()).filter((k) => k.status === "active");
  const setActive = async (n: number) => {
    let act = await active();
    for (const k of act.filter((k) => k.id !== r3.id).slice(0, Math.max(0, act.length - n))) await a.send("POST", `/api-keys/${k.id}/revoke`, {});
    for (let i = act.length; i < n; i++) await mk(a, `R3 pad ${i} ${RUN}`);
    return (await active()).length;
  };
  const trials: unknown[] = [];
  let raceOk = true;
  for (const [trial, parallel] of [[1, 5], [2, 7], [3, 10], [4, 10], [5, 6]] as const) {
    const start = await setActive(8);
    const listBefore = await listAll();
    const rowsBefore = sql(`SELECT count(*) n FROM apikey WHERE referenceId=${q(userA)}`)[0].n as number;
    const prefix = `Race3 ${trial}.`;
    const res = await Promise.all(Array.from({ length: parallel }, (_, i) => a.send("POST", "/api-keys", { name: `${prefix}${i} ${RUN}` })));
    const won = res.filter((r) => r.status === 201);
    const refused = res.filter((r) => r.status !== 201);
    const listAfter = await listAll();
    const beforeIds = new Set(listBefore.map((k) => k.id));
    const added = listAfter.filter((k) => !beforeIds.has(k.id));
    const rowsAfter = sql(`SELECT count(*) n FROM apikey WHERE referenceId=${q(userA)}`)[0].n as number;
    const d1Race = sql(`SELECT id,enabled FROM apikey WHERE referenceId=${q(userA)} AND name LIKE ${q(`${prefix}% ${RUN}`)}`);
    const actApi = listAfter.filter((k) => k.status === "active").length;
    const actD1 = sql(`SELECT count(*) n FROM apikey WHERE referenceId=${q(userA)} AND enabled=1`)[0].n as number;
    const wonIds = won.map((r) => r.body.apiKey.id).sort();
    const ok = start === 8 && won.length <= 2 && actApi <= 10 && actD1 === actApi
      && added.length === won.length && added.every((k) => k.status === "active") && JSON.stringify(added.map((k) => k.id).sort()) === JSON.stringify(wonIds)
      && rowsAfter - rowsBefore === won.length && d1Race.length === won.length && d1Race.every((x: any) => x.enabled === 1)
      && refused.every((r) => r.status === 409 && r.body.code === "api_key_limit" && !r.body.secret)
      && listBefore.every((k) => listAfter.find((x) => x.id === k.id)?.status === k.status);
    if (!ok) raceOk = false;
    trials.push({ trial, startActive: start, parallel, statuses: res.map((r) => r.status), activeApi: actApi, activeD1: actD1, listRowsAdded: added.length, addedRevoked: added.filter((k) => k.status === "revoked").length, d1RowsAdded: rowsAfter - rowsBefore, d1RaceRows: d1Race.length });
  }
  report(raceOk, "R3-race", "5-10 parallel creates at 8 active: never >10 active (API = D1); list and D1 gain exactly the winners, no Revoked rows from refused attempts", trials);

  const preRegen = await submit(r3.secret, ["probe, no link"]);
  const regen = await a.send("POST", `/api-keys/${r3.id}/regenerate`, {});
  report(oldKeyOk(regen, r3.id), "R5-oldKey", "R3 regenerate after races -> oldKey revoked", { oldKey: regen.body.oldKey, oldId: r3.id });
  const oldTry = await submit(r3.secret, [url("r3-regen-old")]);
  const newTry = await submit(regen.body.secret, [url("r3-regen-new")]);
  credit(regen.body.apiKey?.id, newTry);
  const named = (await listAll()).filter((k) => k.name === r3.name);
  report(preRegen.status === 400 && regen.status === 201 && /^lk_[A-Za-z]{64}$/.test(regen.body.secret) && oldTry.status === 401 && newTry.status === 202 && newTry.body.results?.[0]?.status === "created"
    && named.length === 2 && named.find((k) => k.id === r3.id)?.status === "revoked" && named.find((k) => k.id === regen.body.apiKey.id)?.status === "active" && (await active()).length <= 10,
    "R3-regen", "regenerate after the races: old 401, new 202, list shows old Revoked + new Active (one each)", { regen: regen.status, old: oldTry.status, new: short(newTry), named: named.map((k) => ({ id: k.id, prefix: k.prefix, status: k.status })), activeNow: (await active()).length });

  const dump = sql(`SELECT id,name,start,prefix,enabled,referenceId,createdAt,updatedAt FROM apikey ORDER BY referenceId,createdAt`);
  await Bun.write((arg("--d1-dump") ?? "/dev/null").replace(/(\.json)?$/, ".after-r3.json"), JSON.stringify(dump, null, 1));
  await Bun.write((arg("--d1-dump") ?? "/dev/null").replace(/(\.json)?$/, ".list-after-r3.json"), JSON.stringify(await listAll(), null, 1));
  console.log(`D1 apikey rows after R3: ${dump.length}, per user: ${JSON.stringify(sql(`SELECT referenceId,sum(enabled) active,count(*) total FROM apikey GROUP BY referenceId`))}`);
}


// ---------- Round 4: long non-ASCII URL normalized once (API and web import agree), regenerate under concurrent use, cap wording
{
  const toNextWindow = 61_000 - (Date.now() % 60_000);
  console.log(`waiting ${toNextWindow} ms for a fresh per-user writes window before R4`);
  await Bun.sleep(toNextWindow);

  const r4 = await mk(a, `R4 intl ${RUN}`);
  const linkRows = (u: string) => sql(`SELECT id,url,length(url) len FROM links WHERE user_id=${q(userA)} AND url=${q(u)}`);
  const sized = (prefix: string, hrefLen: number) => {
    const room = hrefLen - prefix.length, n = Math.floor(room / 9), pad = "a".repeat(room - n * 9);
    return { text: prefix + "日".repeat(n) + pad, href: prefix + "%E6%97%A5".repeat(n) + pad };
  };
  const base = `http://e.com/${RUN}`;

  const u1 = sized(`${base}/u1-api/`, 4096);
  const s1 = await submit(r4.secret, [u1.text]);
  credit(r4.id, s1);
  const imp1 = await a.send("POST", "/import", { urls: [u1.text] });
  const add1 = await a.send("POST", "/links", { url: u1.text });
  const again1 = await submit(r4.secret, [u1.href]);
  const rows1 = linkRows(u1.href);
  report(u1.href.length === 4096 && s1.status === 202 && s1.body.results?.length === 1 && s1.body.results[0].status === "created" && s1.body.results[0].url === u1.href && s1.body.rejected?.length === 0
    && imp1.status === 200 && imp1.body.imported === 0 && imp1.body.duplicates === 1
    && add1.status === 200 && add1.body.duplicate === true && add1.body.id === s1.body.results[0].id
    && again1.status === 202 && again1.body.results?.[0]?.status === "duplicate" && again1.body.results[0].id === s1.body.results[0].id
    && rows1.length === 1 && rows1[0].len === 4096 && rows1[0].id === s1.body.results[0].id,
    "R5-intl", "non-ASCII URL encoding to exactly 4096: API 202 created; web import -> duplicate; web add -> 200 duplicate same id; resubmitting the stored href -> duplicate; one Link (4096 chars) in D1",
    { inputChars: u1.text.length, encodedChars: u1.href.length, api: { status: s1.status, result: s1.body.results?.[0]?.status, urlLen: s1.body.results?.[0]?.url?.length, error: s1.body.error },
      import: { status: imp1.status, imported: imp1.body.imported, duplicates: imp1.body.duplicates, error: imp1.body.error }, add: { status: add1.status, duplicate: add1.body?.duplicate, sameId: add1.body?.id === s1.body.results?.[0]?.id, error: add1.body?.error },
      storedHrefResubmit: again1.body.results?.[0]?.status, d1: rows1.map((r) => ({ len: r.len })) });

  const u2 = sized(`${base}/u2-add/`, 4096);
  const add2 = await a.send("POST", "/links", { url: u2.text });
  const s2 = await submit(r4.secret, [`see ${u2.text} today`]);
  const rows2 = linkRows(u2.href);
  report(add2.status === 201 && add2.body.duplicate === false && s2.status === 202 && s2.body.results?.[0]?.status === "duplicate" && s2.body.results[0].id === add2.body.id && s2.body.results[0].url === u2.href && !s2.body.batchId
    && rows2.length === 1 && rows2[0].len === 4096,
    "R5-intl", "web add first (encodes to 4096) -> 201 created; API with it inside text -> duplicate, same id, no batch; one Link in D1",
    { add: { status: add2.status, duplicate: add2.body?.duplicate, error: add2.body?.error }, api: { status: s2.status, result: s2.body.results?.[0]?.status, sameId: s2.body.results?.[0]?.id === add2.body?.id, batchId: s2.body.batchId, error: s2.body.error }, d1Rows: rows2.length });

  const u3 = sized(`${base}/u3-import/`, 4095);
  const imp3 = await a.send("POST", "/import", { urls: [u3.text] });
  const s3a = await submit(r4.secret, [u3.text]);
  const rows3 = linkRows(u3.href);
  const libRow = (await a.get("/library")).body.links.find((l: any) => l.url === u3.href);
  report(imp3.status === 200 && imp3.body.imported === 1 && s3a.status === 202 && s3a.body.results?.[0]?.status === "duplicate" && s3a.body.results[0].url === u3.href && rows3.length === 1 && rows3[0].id === s3a.body.results[0].id && !!libRow,
    "R5-intl", "web import first (encodes to 4095) -> imported 1; API -> duplicate same id and URL; one Link in D1 and library",
    { import: { status: imp3.status, imported: imp3.body.imported, error: imp3.body.error }, api: { status: s3a.status, result: s3a.body.results?.[0]?.status, error: s3a.body.error }, d1Rows: rows3.length, inLibrary: !!libRow });

  const s0 = { links: (await summary(a)).quotas.links.used, batches: (await a.get("/library")).body.batches.length };
  const overs = [sized(`${base}/over-4097/`, 4097), { text: `${base}/over-r4/` + "日".repeat(500), href: `${base}/over-r4/` + "%E6%97%A5".repeat(500) }];
  const overRows: unknown[] = [];
  let overOk = overs[0]!.href.length === 4097 && overs[1]!.href.length > 4096;
  for (const [i, o] of overs.entries()) {
    const companion = url(`r5-over-companion-${i}`);
    const mixed = await submit(r4.secret, [o.text, companion]);
    credit(r4.id, mixed);
    const alone = await submit(r4.secret, [o.text]);
    const encodedForm = await submit(r4.secret, [o.href]);
    const add = await a.send("POST", "/links", { url: o.text });
    const imp = await a.send("POST", "/import", { urls: [o.text] });
    const impMixed = await a.send("POST", "/import", { urls: [url(`r5-over-web-companion-${i}`), o.text] });
    const ok = mixed.status === 202 && mixed.body.rejected?.length === 1 && mixed.body.rejected[0].input === o.text && mixed.body.rejected[0].error === "Paste a valid URL." && mixed.body.results?.length === 1 && mixed.body.results[0].url === companion
      && alone.status === 400 && alone.body.rejected?.[0]?.error === "Paste a valid URL."
      && encodedForm.status === 400 && encodedForm.body.rejected?.[0]?.error === "Paste a valid URL."
      && add.status === 400 && add.body.error === "Paste a valid URL." && imp.status === 400 && imp.body.error === "Paste a valid URL." && impMixed.status === 400;
    if (!ok) overOk = false;
    overRows.push({ inputChars: o.text.length, encodedChars: o.href.length, apiMixed: { status: mixed.status, rejected: mixed.body.rejected?.map((x: any) => `${x.input.length}ch -> ${x.error}`), results: mixed.body.results?.length },
      apiAlone: { status: alone.status, error: alone.body.error, rejected: alone.body.rejected?.map((x: any) => x.error) }, apiEncodedForm: { status: encodedForm.status, rejected: encodedForm.body.rejected?.map((x: any) => x.error) },
      webAdd: brief(add), webImport: { status: imp.status, error: imp.body.error }, webImportWithValidCompanion: { status: impMixed.status, error: impMixed.body.error } });
  }
  const overD1 = sql(`SELECT count(*) n FROM links WHERE url LIKE ${q(`%/${RUN}/over-%`)} OR original_url LIKE ${q(`%/${RUN}/over-%`)}`)[0].n;
  const webCompanions = sql(`SELECT count(*) n FROM links WHERE url LIKE ${q(`%/${RUN}/r5-over-web-companion-%`)}`)[0].n;
  const s9 = { links: (await summary(a)).quotas.links.used, batches: (await a.get("/library")).body.batches.length };
  report(overOk && overD1 === 0 && webCompanions === 0 && s9.links === s0.links + 2 && s9.batches === s0.batches + 2,
    "R5-intl", "URL encoding past 4096 (4097, and the round-4 日x500 = 4513+): API lists it in rejected 'Paste a valid URL.' (companion saved), alone/encoded form -> 400; web add and web import -> 400; nothing of it saved",
    { cases: overRows, d1OverRows: overD1, webImportCompanionsSaved: webCompanions, linksQuota: [s0.links, s9.links], batches: [s0.batches, s9.batches], note: "the +2 links/batches are the two API companions" });

  const tooLongRaw = "http://e.com/" + "a".repeat(4100);
  const s3 = await submit(r4.secret, [tooLongRaw, url("r4-companion")]);
  credit(r4.id, s3);
  report(s3.status === 202 && s3.body.rejected?.length === 1 && s3.body.rejected[0].error === "Paste a valid URL." && s3.body.results?.length === 1,
    "R4-intl", "a URL whose own text exceeds 4096 chars is still rejected with the URL rule (companion saved)", { status: s3.status, rejected: s3.body.rejected?.map((x: any) => ({ inputChars: x.input.length, error: x.error })), results: s3.body.results?.length });

  const capUrl = url("r4-cap");
  const caps = await submit(r4.secret, Array.from({ length: 501 }, (_, i) => `bad http://localhost/${i} and http://localhost/x${i}`));
  const capsDup = await submit(r4.secret, Array.from({ length: 501 }, () => `twice ${capUrl} and ${capUrl}`));
  report(caps.status === 400 && caps.body.error === CAP_MESSAGE && capsDup.status === 400 && capsDup.body.error === CAP_MESSAGE && !(await libraryUrls(a)).urls.has(capUrl),
    "R4-cap", "1002 invalid candidates (501 strings x 2), and 1002 repeats of one valid URL -> 400 with the 'URL candidates' wording, nothing saved", { invalid: brief(caps), repeats: brief(capsDup) });

  const listAll = async () => (await a.get("/api-keys")).body.apiKeys as any[];
  const slotD1 = (name: string) => sql(`SELECT id,enabled,updatedAt,lastRequest FROM apikey WHERE referenceId=${q(userA)} AND name=${q(name)} ORDER BY createdAt`);
  const trials: any[] = [];
  let raceOk = true;
  for (const [trial, burst, regens] of [[1, 12, 1], [2, 12, 1], [3, 15, 1], [4, 15, 1], [5, 12, 2]] as const) {
    const act = (await listAll()).filter((k) => k.status === "active");
    for (const k of act.slice(0, Math.max(0, act.length - 8))) await a.send("POST", `/api-keys/${k.id}/revoke`, {});
    const k = await mk(a, `R4 regen ${trial} ${RUN}`);
    const warm = await submit(k.secret, ["probe, no link"]);
    const t0 = performance.now();
    let regenDoneAt = Infinity;
    let sampling = true;
    const samples: number[] = [];
    const sampler = (async () => {
      while (sampling) {
        const l = await listAll();
        samples.push(l.filter((x) => x.name === k.name && x.status === "active").length);
      }
    })();
    const shots = Array.from({ length: burst }, async (_, i) => {
      await Bun.sleep(i * 12);
      const startedAt = performance.now();
      const r = await submit(k.secret, [url(`r4-burst-${trial}-${i}`)]);
      return { i, startedMs: Math.round(startedAt - t0), endedMs: Math.round(performance.now() - t0), status: r.status, created: r.body?.results?.[0]?.status, startedAfterRegen: startedAt > regenDoneAt, error: r.body?.error };
    });
    const regenCalls = Array.from({ length: regens }, async () => {
      await Bun.sleep(40);
      const r = await a.send("POST", `/api-keys/${k.id}/regenerate`, {});
      regenDoneAt = Math.min(regenDoneAt, performance.now());
      return r;
    });
    const [burstRes, regenRes] = await Promise.all([Promise.all(shots), Promise.all(regenCalls)]);
    sampling = false;
    await sampler;
    for (const r of burstRes) if (r.status === 202) credit(k.id, { status: 202, body: { results: r.created === "created" ? [{ status: "created" }] : [] }, headers: new Headers() });
    const won = regenRes.filter((r) => r.status === 201);
    const lost = regenRes.filter((r) => r.status !== 201);
    const newKey = won[0]?.body;
    const oldKeyGood = won.length === 1 && oldKeyOk(won[0], k.id) && lost.every((r) => !("oldKey" in (r.body ?? {})));
    const rows = slotD1(k.name);
    await Bun.sleep(600);
    const rowsLater = slotD1(k.name);
    const oldAfter = await submit(k.secret, [url(`r4-old-after-${trial}`)]);
    const newAfter = newKey ? await submit(newKey.secret, [url(`r4-new-after-${trial}`)]) : null;
    if (newAfter) credit(newKey.apiKey.id, newAfter);
    const listed = (await listAll()).filter((x) => x.name === k.name);
    const ok = oldKeyGood && warm.status === 400 && won.length === 1 && lost.every((r) => r.status === 409 && r.body.code === "api_key_revoked" && !r.body.secret)
      && rows.length === 2 && rows.filter((r: any) => r.enabled === 1).length === 1 && rows.find((r: any) => r.id === k.id)?.enabled === 0 && rows.find((r: any) => r.id === newKey.apiKey.id)?.enabled === 1
      && JSON.stringify(rowsLater.map((r: any) => [r.id, r.enabled])) === JSON.stringify(rows.map((r: any) => [r.id, r.enabled]))
      && listed.length === 2 && listed.find((x) => x.id === k.id)?.status === "revoked" && listed.find((x) => x.id === newKey.apiKey.id)?.status === "active"
      && oldAfter.status === 401 && newAfter?.status === 202 && newAfter.body.results?.[0]?.status === "created"
      && burstRes.every((r) => r.status === 202 || r.status === 401) && burstRes.filter((r) => r.startedAfterRegen).every((r) => r.status === 401)
      && samples.length > 0 && samples.every((n) => n >= 1);
    if (!ok) raceOk = false;
    trials.push({
      trial, burst, regens, regenStatuses: regenRes.map((r) => r.status), oldKey: won[0]?.body.oldKey && { ...won[0].body.oldKey, id: won[0].body.oldKey.id === k.id ? "old id" : won[0].body.oldKey.id }, lostCodes: lost.map((r) => r.body.code),
      burstStatuses: burstRes.map((r) => `${r.startedMs}:${r.status}`).join(" "), regenAnsweredMs: Math.round(regenDoneAt - t0),
      burst202: burstRes.filter((r) => r.status === 202).length, burst401: burstRes.filter((r) => r.status === 401).length, other: burstRes.filter((r) => r.status !== 202 && r.status !== 401).map((r) => `${r.status} ${r.error}`),
      startedAfterRegenNot401: burstRes.filter((r) => r.startedAfterRegen && r.status !== 401).length,
      d1: rows.map((r: any) => `${r.id === k.id ? "old" : "new"}:${r.enabled}`), d1After600ms: rowsLater.map((r: any) => `${r.id === k.id ? "old" : "new"}:${r.enabled}`),
      list: listed.map((x) => `${x.id === k.id ? "old" : "new"}:${x.status}`), oldAfter: oldAfter.status, newAfter: newAfter?.status,
      activeSamples: { n: samples.length, min: Math.min(...samples), max: Math.max(...samples) },
    });
  }
  report(raceOk, "R4-regen-race", "regenerate while the old key is used by a parallel burst (and once with 2 concurrent regenerates): one 201 with oldKey {old id, revoked}, exactly one of old/new active in D1 and the list (stable 600 ms later), old 401, new 202, burst only 202/401 and 401 once regenerate answered, slot never at 0 active", trials);

  const dump = sql(`SELECT id,name,start,prefix,enabled,referenceId,createdAt,updatedAt,lastRequest FROM apikey ORDER BY referenceId,createdAt`);
  await Bun.write((arg("--d1-dump") ?? "/dev/null").replace(/(\.json)?$/, ".after-r4.json"), JSON.stringify(dump, null, 1));
  await Bun.write((arg("--d1-dump") ?? "/dev/null").replace(/(\.json)?$/, ".list-after-r4.json"), JSON.stringify(await listAll(), null, 1));
  console.log(`D1 apikey rows after R4: ${dump.length}, per user: ${JSON.stringify(sql(`SELECT referenceId,sum(enabled) active,count(*) total FROM apikey GROUP BY referenceId`))}`);
}

// ---------- Round 5: the list after many regenerates (metadata marker), revoked keys 401, unconfirmed old-key revoke via HTTP
{
  const toNextWindow = 61_000 - (Date.now() % 60_000);
  console.log(`waiting ${toNextWindow} ms for a fresh per-user writes window before R5`);
  await Bun.sleep(toNextWindow);

  const listing: Record<string, unknown> = {};
  let listOk = true;
  for (const [label, u, id] of [["A", a, userA], ["B", b, userB]] as const) {
    const r = await u.get("/api-keys");
    const list = r.body.apiKeys as any[];
    const rows = sql(`SELECT id,name,start,enabled,metadata FROM apikey WHERE referenceId=${q(id)}`);
    const byId = new Map(list.map((k) => [k.id, k]));
    const mismatches = rows.filter((row: any) => {
      const k = byId.get(row.id);
      return !k || k.name !== row.name || k.prefix !== row.start || k.status !== (row.enabled === 1 ? "active" : "revoked");
    }).map((row: any) => row.id);
    const leaks = list.filter((k) => "metadata" in k || "key" in k || JSON.stringify(k).includes("replacedBy")).length;
    const ok = r.status === 200 && list.length === rows.length && byId.size === list.length && mismatches.length === 0 && leaks === 0;
    if (!ok) listOk = false;
    listing[label] = { status: r.status, listed: list.length, d1Rows: rows.length, active: list.filter((k) => k.status === "active").length, mismatches, leaks, rowsWithMarker: rows.filter((x: any) => String(x.metadata ?? "").includes("replacedBy")).length };
  }
  const markers = regenerated.map(({ oldId, newId }) => {
    const row = sql(`SELECT enabled,metadata,json_valid(metadata) valid,json_extract(metadata,'$.replacedBy') replacedBy FROM apikey WHERE id=${q(oldId)}`)[0];
    return { ok: row?.enabled === 0 && row?.valid === 1 && row?.replacedBy === newId, enabled: row?.enabled, metadata: row?.metadata };
  });
  report(listOk && markers.length >= 9 && markers.every((m) => m.ok), "R5-list",
    "after every regenerate: GET /api-keys lists exactly the D1 rows of each user (name, prefix, status = enabled), no metadata/marker leaks; each regenerated old key has enabled=0 and metadata.replacedBy = its replacement's id",
    { listing, regenerates: markers.length, markersOk: markers.filter((m) => m.ok).length, sampleMetadata: markers[0]?.metadata, bad: markers.filter((m) => !m.ok) });

  const listA = (await a.get("/api-keys")).body.apiKeys as any[];
  const listB = (await b.get("/api-keys")).body.apiKeys as any[];
  const status = new Map([...listA, ...listB].map((k) => [k.id, k.status]));
  const probes: Record<string, number[]> = { revoked: [], active: [], unlisted: [] };
  for (const [id, secret] of secrets) {
    const s = status.get(id);
    if (!s) { probes.unlisted!.push(0); continue; }
    const r = await submit(secret, ["probe, no link"]);
    probes[s]!.push(r.status);
  }
  report(probes.revoked!.length >= 20 && probes.revoked!.every((x) => x === 401) && probes.active!.length > 0 && probes.active!.every((x) => x === 400) && probes.unlisted!.length === 0,
    "R5-list", "every revoked key this run holds a secret for answers 401; every active one authenticates (400 no-link probe); every key whose secret was handed out is listed",
    { revoked: { n: probes.revoked!.length, statuses: [...new Set(probes.revoked)] }, active: { n: probes.active!.length, statuses: [...new Set(probes.active)] }, handedOutButUnlisted: probes.unlisted!.length });

  const act = listA.filter((k) => k.status === "active");
  for (const k of act.slice(0, Math.max(0, act.length - 8))) await a.send("POST", `/api-keys/${k.id}/revoke`, {});
  const stuck = await mk(a, `R5 stuck ${RUN}`);
  sql(`CREATE TRIGGER r5_stuck BEFORE UPDATE OF enabled ON apikey WHEN old.id = ${q(stuck.id)} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  let regen: Res, oldWorks: Res, newWorks: Res, listed: any[], d1Row: any;
  try {
    regen = await a.send("POST", `/api-keys/${stuck.id}/regenerate`, {});
    oldWorks = await submit(stuck.secret, ["probe, no link"]);
    newWorks = await submit(regen.body.secret, ["probe, no link"]);
    listed = ((await a.get("/api-keys")).body.apiKeys as any[]).filter((k) => k.name === stuck.name);
    d1Row = sql(`SELECT enabled,metadata FROM apikey WHERE id=${q(stuck.id)}`)[0];
  } finally {
    sql("DROP TRIGGER IF EXISTS r5_stuck");
  }
  const logs = ["dev.log", "dev.err.log"].map((f) => { try { return readFileSync(join(session.runDir, "logs", f), "utf8"); } catch { return ""; } }).join("\n");
  const event = logs.split("\n").find((l) => l.includes("api_key_revoke_unconfirmed") && l.includes(stuck.id));
  report(regen.status === 201 && /^lk_[A-Za-z]{64}$/.test(regen.body.secret) && JSON.stringify(regen.body.oldKey) === JSON.stringify({ id: stuck.id, status: "unconfirmed" })
    && oldWorks.status === 400 && newWorks.status === 400 && listed.length === 2 && listed.every((k) => k.status === "active") && d1Row?.enabled === 1 && !String(d1Row?.metadata ?? "").includes("replacedBy"),
    "R5-unconfirmed", "D1 trigger blocks the old key's revoke: regenerate -> 201 with the new secret and oldKey { id, status: unconfirmed }; old and new both authenticate; list shows both Active; D1 old enabled=1, no marker",
    { status: regen.status, oldKey: regen.body.oldKey, oldKeyAuth: oldWorks.status, newKeyAuth: newWorks.status, listed: listed.map((k) => `${k.id === stuck.id ? "old" : "new"}:${k.status}`), d1Old: d1Row });
  report(!!event && !logs.includes(stuck.secret) && !logs.includes(regen.body.secret), "R5-unconfirmed", "Worker log has api_key_revoke_unconfirmed for this key, and neither secret",
    { event: event?.slice(event.indexOf("{")), secretsInLogs: logs.includes(stuck.secret) || logs.includes(regen.body.secret) });
  const byHand = await a.send("POST", `/api-keys/${stuck.id}/revoke`, {});
  const oldAfter = await submit(stuck.secret, ["probe, no link"]);
  const newAfter = await submit(regen.body.secret, [url("r5-unconfirmed-new")]);
  credit(regen.body.apiKey.id, newAfter);
  const after = ((await a.get("/api-keys")).body.apiKeys as any[]).filter((k) => k.name === stuck.name);
  report(byHand.status === 200 && byHand.body.apiKey?.status === "revoked" && oldAfter.status === 401 && newAfter.status === 202 && newAfter.body.results?.[0]?.status === "created"
    && after.find((k) => k.id === stuck.id)?.status === "revoked" && after.find((k) => k.id === regen.body.apiKey.id)?.status === "active",
    "R5-unconfirmed", "after the fault clears, revoking the old key by hand -> 200 revoked; old 401; new still 202 created; list old Revoked + new Active",
    { revoke: brief(byHand), oldAfter: oldAfter.status, newAfter: short(newAfter), list: after.map((k) => `${k.id === stuck.id ? "old" : "new"}:${k.status}`) });
}

// ---------- Round 6: two concurrent regenerates of the same key at the 10-active cap
{
  const toNextWindow = 61_000 - (Date.now() % 60_000);
  console.log(`waiting ${toNextWindow} ms for a fresh per-user writes window before R6`);
  await Bun.sleep(toNextWindow);
  const listAll = async () => (await a.get("/api-keys")).body.apiKeys as any[];
  const d1Active = () => sql(`SELECT count(*) n FROM apikey WHERE referenceId=${q(userA)} AND enabled=1`)[0].n as number;
  const trials: any[] = [];
  let ok6 = true;
  for (let trial = 1; trial <= 5; trial++) {
    const act = (await listAll()).filter((k) => k.status === "active");
    for (const k of act.slice(0, Math.max(0, act.length - 9))) await a.send("POST", `/api-keys/${k.id}/revoke`, {});
    const k = await mk(a, `R6 pair ${trial} ${RUN}`);
    const activeBefore = (await listAll()).filter((x) => x.status === "active").length;
    let sampling = true;
    const listSamples: number[] = [];
    const d1Samples: number[] = [];
    const sampler = (async () => {
      while (sampling) {
        listSamples.push((await listAll()).filter((x) => x.status === "active").length);
        d1Samples.push(d1Active());
      }
    })();
    const regenRes = await Promise.all([0, 1].map(() => a.send("POST", `/api-keys/${k.id}/regenerate`, {})));
    sampling = false;
    await sampler;
    const won = regenRes.filter((r) => r.status === 201);
    const lost = regenRes.filter((r) => r.status !== 201);
    const rows = sql(`SELECT id,enabled,json_extract(metadata,'$.replacedBy') replacedBy FROM apikey WHERE referenceId=${q(userA)} AND name=${q(k.name)} ORDER BY createdAt`);
    const newId = won[0]?.body.apiKey?.id;
    const oldAfter = await submit(k.secret, ["probe, no link"]);
    const newAfter = won[0] ? await submit(won[0].body.secret, ["probe, no link"]) : null;
    const activeAfter = (await listAll()).filter((x) => x.status === "active").length;
    const pass = activeBefore === 10 && won.length === 1 && lost.length === 1 && lost[0]!.status === 409 && lost[0]!.body.code === "api_key_revoked" && !lost[0]!.body.secret && !("oldKey" in (lost[0]!.body ?? {}))
      && JSON.stringify(won[0]!.body.oldKey) === JSON.stringify({ id: k.id, status: "revoked" })
      && rows.length === 2 && rows.find((r: any) => r.id === k.id)?.enabled === 0 && rows.find((r: any) => r.id === k.id)?.replacedBy === newId && rows.find((r: any) => r.id === newId)?.enabled === 1
      && oldAfter.status === 401 && newAfter?.status === 400 && activeAfter === 10
      && listSamples.length > 0 && Math.max(...listSamples, ...d1Samples) <= 10;
    if (pass) regenerated.push({ oldId: k.id, newId });
    else ok6 = false;
    trials.push({ trial, activeBefore, statuses: regenRes.map((r) => r.status), lostCode: lost.map((r) => r.body.code), oldKey: won[0]?.body.oldKey && { ...won[0].body.oldKey, id: won[0].body.oldKey.id === k.id ? "old id" : won[0].body.oldKey.id },
      d1Rows: rows.map((r: any) => `${r.id === k.id ? "old" : r.id === newId ? "new" : "other"}:${r.enabled}${r.replacedBy ? ` replacedBy=${r.replacedBy === newId ? "new" : r.replacedBy}` : ""}`),
      oldAfter: oldAfter.status, newAfter: newAfter?.status, activeAfter, maxActive: { list: Math.max(...listSamples), d1: Math.max(...d1Samples), samples: listSamples.length } });
  }
  report(ok6, "R6-same-key-race", "two concurrent regenerates of the same key at 10 active (5 trials): exactly one 201 with oldKey {old id, revoked} and one 409 api_key_revoked (no secret, no oldKey); one replacement row (2 rows by name, old enabled=0 replacedBy=new); old 401, new authenticates; active never above 10 in the list or D1 while it ran, 10 after", trials);
}

console.log(`KEYS ${JSON.stringify({ main: { id: main.id, name: main.name } })}`);
console.log(`\n${results.filter((l) => l.startsWith("PASS")).length} PASS, ${failures} FAIL`);
process.exit(failures ? 1 : 0);
