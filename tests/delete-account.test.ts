// FAC-358: scripts/delete-account.ts removes one account and everything stored for it, and nothing else.
// A real user is built through the Worker's routes on the migrated schema (local D1 shim, FakeR2); what the
// routes don't write is inserted so that every table that can hold user data has a row before the deletion.
import { beforeEach, describe, expect, test } from "bun:test";
import { lensFingerprint } from "@linklog/browser-protocol";
import { deleteAccount, isClean, planDeletion, type Target } from "../scripts/delete-account";
import { TestD1 } from "./support/d1";
import { client, makeEnv, type FakeR2 } from "./support/env";
import { createTestAuth, testApiKey, testSession } from "./support/auth.test-instance";

type User = { userId: string; cookie: string };
let db: TestD1, env: Env, r2: FakeR2, call: ReturnType<typeof client>, target: Target;
let A: User, B: User;

// Tables with no user column and no foreign key path to `user`. A new table must either reach `user` through
// a foreign key (then it is covered below) or be listed here on purpose. `verification` holds the email of a
// pending sign-in link until the 5-minute cron purges it after expiry; the other four hold no user data.
const NOT_USER_DATA = ["_cf_KV", "d1_migrations", "rateLimit", "settings", "verification", "app_rate_limits"];

type Fk = { from: string; table: string; to: string };
const tables = () =>
  (db.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
const fksOf = (table: string) => db.sqlite.query(`PRAGMA foreign_key_list("${table}")`).all() as Fk[];

/** SQL condition selecting the rows of `table` that belong to the user (bound as ?1), following foreign keys up to `user`. */
function ownedBy(table: string): string | null {
  if (table === "user") return `"user".id=?1`;
  const parts = fksOf(table).flatMap((fk) => {
    if (fk.table === "user") return [`"${table}"."${fk.from}"=?1`];
    const parent = ownedBy(fk.table);
    return parent ? [`"${table}"."${fk.from}" IN (SELECT "${fk.to}" FROM "${fk.table}" WHERE ${parent})`] : [];
  });
  return parts.length ? parts.join(" OR ") : null;
}
const ownedTables = () => tables().filter((t) => ownedBy(t));

const rowsOf = (table: string, userId: string) => db.sqlite.query(`SELECT * FROM "${table}" WHERE ${ownedBy(table)} ORDER BY rowid`).all(userId);
const everythingOf = (userId: string) => Object.fromEntries(ownedTables().map((t) => [t, rowsOf(t, userId)]));
const dumpAll = () => Object.fromEntries(tables().map((t) => [t, db.sqlite.query(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
const keysUnder = (prefix: string) => [...r2.objects.keys()].filter((k) => k.startsWith(prefix));


/** A user with every kind of data the product writes. */
async function seed(who: User, tag: string) {
  const send = async (path: string, body: unknown = {}, method = "POST") => {
    const res = await call(path, { cookie: who.cookie, body, method });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as any;
  };
  const link = await send("/api/links", { url: `https://example.com/${tag}`, tags: [tag] });
  db.sqlite.query("UPDATE jobs SET status='done' WHERE link_id=?").run(link.id);
  await send(`/api/links/${link.id}/content`, { markdown: `# ${tag}` }, "PUT");
  await send("/api/lenses", { name: `Lens ${tag}`, type: "noul", question: "Relevant?", scope: "browser" });
  const library = (await (await call("/api/library", { cookie: who.cookie })).json()) as any;
  const lensId = library.lenses[0].id as string;
  const tagId = library.tags[0].id as string;
  const batchId = library.batches[0].id as string;
  const catalog = (await (await call("/api/browser/catalog", { cookie: who.cookie })).json()) as { libraryId: string };
  const fingerprint = lensFingerprint(library.lenses[0]);
  await send("/api/browser/evaluations", {
    requestId: `req-${tag}`,
    libraryId: catalog.libraryId,
    sessionId: "s",
    kind: "lens",
    lens: { id: lensId, fingerprint },
    targets: ["t1", "t2"].map((k) => ({
      targetKey: k,
      url: `https://x.dev/${tag}/${k}`,
      title: k,
      capture: { source: "dom", capturedAt: new Date().toISOString(), completeness: "complete", reasons: [], facts: [], markdown: `page ${k}` },
    })),
  });
  await send("/api/browser/groups", { id: `group-${tag}`, name: "Work", color: "blue" });
  await testApiKey(env, who.userId, `key ${tag}`);
  await testApiKey(env, who.userId, `second key ${tag}`);
  const ctx = await createTestAuth(env).$context;
  await ctx.test.login({ userId: who.userId });

  const jobId = (db.sqlite.query("SELECT id FROM jobs WHERE link_id=?").get(link.id) as { id: string }).id;
  const now = new Date().toISOString();
  db.sqlite.query("INSERT INTO account(id,accountId,providerId,userId,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(`acc-${tag}`, who.userId, "credential", who.userId, now, now);
  db.sqlite.query("INSERT INTO usage_events(id,user_id,batch_id,job_id,link_id,provider,service,model,operation,status,created_at) VALUES(?,?,?,?,?,'p','s','m','o','ok',?)").run(`use-${tag}`, who.userId, batchId, jobId, link.id, now);
  db.sqlite.query("INSERT INTO media_items(link_id,media_key,position,kind,url,updated_at) VALUES(?,?,0,'image','https://example.com/i.png',?)").run(link.id, `media-${tag}`, now);
  db.sqlite.query("INSERT INTO hidden_related_links(link_id,url,hidden_at) VALUES(?,'https://example.com/hidden',?)").run(link.id, now);
  db.sqlite.query("INSERT INTO tag_evaluations(link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id) VALUES(?,?,0.9,0.5,1,'d',1,'m',?,?)").run(link.id, tagId, now, batchId);
  db.sqlite.query("INSERT INTO lens_results(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id) VALUES(?,?,'{}',1,1,'m',?,?)").run(link.id, lensId, now, batchId);
  db.sqlite.query("INSERT INTO provider_leases(job_id,expires_at,pool) VALUES(?,?,'p')").run(jobId, Date.now() + 60_000);
  return { linkId: link.id as string };
}

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, r2 } = makeEnv(db, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" }));
  call = client(env);
  target = { db: db.d1, bucket: r2 as unknown as R2Bucket };
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
});

const run = async (email: string) => {
  const plan = await planDeletion(target, email);
  if (!plan) throw new Error("no account");
  return deleteAccount(target, plan);
};

describe("which tables hold user data", () => {
  test("every table is covered through the schema or listed as holding none, and no user column hides outside a foreign key", () => {
    const owned = ownedTables();
    expect(owned).toContain("browser_targets");
    expect(owned).toContain("provider_leases");
    expect(tables().filter((t) => !owned.includes(t)).sort()).toEqual(NOT_USER_DATA.filter((t) => tables().includes(t)).sort());
    for (const table of tables()) {
      const columns = (db.sqlite.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      const userColumns = columns.filter((c) => /^(user|reference|owner)_?id$/i.test(c));
      const viaFk = new Set(fksOf(table).map((f) => f.from));
      for (const column of userColumns) if (table !== "user" && !viaFk.has(column)) throw new Error(`${table}.${column} looks like a user column without a foreign key to user`);
    }
  });
});

describe("deleting an account", () => {
  test("leaves no row, counter or R2 key of the user, an empty foreign_key_check, and the second user untouched", async () => {
    await seed(A, "alpha");
    await seed(B, "beta");
    for (const table of ownedTables()) expect({ table, rows: rowsOf(table, A.userId).length > 0 }).toEqual({ table, rows: true });
    expect(keysUnder(`users/${A.userId}/`).length).toBeGreaterThan(2);
    expect(db.sqlite.query("SELECT key FROM app_rate_limits WHERE key IN (?,?) ORDER BY key").all(`links:${A.userId}`, `writes:${A.userId}`)).toHaveLength(2);
    const keptB = everythingOf(B.userId);
    const keptKeys = keysUnder(`users/${B.userId}/`);
    const keptCounters = db.sqlite.query("SELECT * FROM app_rate_limits WHERE key LIKE '%' || ? ORDER BY key").all(B.userId);
    const unrelated = db.sqlite.query("SELECT * FROM app_rate_limits WHERE key NOT LIKE '%' || ? ORDER BY key").all(A.userId);

    const plan = (await planDeletion(target, "a@example.test"))!;
    expect(plan).toMatchObject({ userId: A.userId, email: "a@example.test", counters: [`links:${A.userId}`, `writes:${A.userId}`] });
    expect(plan.rows).toMatchObject({ links: 1, tags: 1, lenses: 1, api_keys: 2, browser_requests: 1, browser_targets: 2, browser_groups: 1 });
    expect(plan.rows.sessions).toBeGreaterThanOrEqual(2);
    expect(plan.r2Objects).toBe(keysUnder(`users/${A.userId}/`).length);
    expect(await planDeletion(target, "a@example.test")).toEqual(plan);

    const left = await deleteAccount(target, plan);
    expect(left).toEqual({ userRow: false, counters: [], r2Keys: [], foreignKeyViolations: 0 });
    expect(isClean(left)).toBe(true);

    for (const table of ownedTables()) expect({ table, rows: rowsOf(table, A.userId) }).toEqual({ table, rows: [] });
    expect(db.sqlite.query("SELECT * FROM \"user\" WHERE email='a@example.test'").all()).toEqual([]);
    expect(db.sqlite.query("SELECT * FROM app_rate_limits WHERE key LIKE '%' || ?").all(A.userId)).toEqual([]);
    expect(keysUnder(`users/${A.userId}/`)).toEqual([]);
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);

    expect(everythingOf(B.userId)).toEqual(keptB);
    expect(keysUnder(`users/${B.userId}/`)).toEqual(keptKeys);
    expect(db.sqlite.query("SELECT * FROM app_rate_limits WHERE key LIKE '%' || ? ORDER BY key").all(B.userId)).toEqual(keptCounters);
    expect(db.sqlite.query("SELECT * FROM app_rate_limits WHERE key NOT LIKE '%' || ? ORDER BY key").all(A.userId)).toEqual(unrelated);
    for (const table of ownedTables()) expect({ table, rows: rowsOf(table, B.userId).length > 0 }).toEqual({ table, rows: true });
  });

  test("the account is found by its email whatever the case", async () => {
    expect((await planDeletion(target, "  A@Example.TEST "))?.userId).toBe(A.userId);
  });

  test("an unknown email, and a second run for the same one, find nothing and change nothing", async () => {
    await seed(A, "alpha");
    await seed(B, "beta");
    const before = dumpAll();
    const objects = new Map(r2.objects);
    expect(await planDeletion(target, "nobody@example.test")).toBeNull();
    expect({ tables: dumpAll(), objects: r2.objects }).toEqual({ tables: before, objects });

    await run("a@example.test");
    const afterFirst = dumpAll();
    const objectsAfterFirst = new Map(r2.objects);
    expect(await planDeletion(target, "a@example.test")).toBeNull();
    expect({ tables: dumpAll(), objects: r2.objects }).toEqual({ tables: afterFirst, objects: objectsAfterFirst });
  });

  test("without step 1 a Browser evaluation blocks the user row (why the targets go first)", async () => {
    await seed(A, "alpha");
    expect(() => db.sqlite.query('DELETE FROM "user" WHERE id=?').run(A.userId)).toThrow(/FOREIGN KEY constraint failed/);
  });

  test("an R2 failure after the row is gone names the user id and what is left, and a rerun cannot find the account", async () => {
    await seed(A, "alpha");
    const failing = { ...target, bucket: { list: r2.list.bind(r2), delete: async () => { throw new Error("R2 unavailable"); } } as unknown as R2Bucket };
    const plan = (await planDeletion(failing, "a@example.test"))!;
    await expect(deleteAccount(failing, plan)).rejects.toThrow(new RegExp(`${A.userId}.*deleting the R2 objects failed.*R2 unavailable.*users/${A.userId}/`));
    expect(db.sqlite.query('SELECT 1 FROM "user" WHERE id=?').get(A.userId)).toBeNull();
    expect(keysUnder(`users/${A.userId}/`).length).toBeGreaterThan(0);
    expect(await planDeletion(target, "a@example.test")).toBeNull();
  });

  test("a user id that could widen the R2 prefix is refused before anything is deleted", async () => {
    db.sqlite.exec("PRAGMA foreign_keys=OFF");
    db.sqlite.query('UPDATE "user" SET id=? WHERE id=?').run("x/", A.userId);
    r2.objects.set("users/x/anything", "1");
    const before = dumpAll();
    await expect(planDeletion(target, "a@example.test")).rejects.toThrow(/does not look like an id/);
    expect(dumpAll()).toEqual(before);
    expect(r2.objects.has("users/x/anything")).toBe(true);
  });

  test("an account with more objects than one R2 page is emptied", async () => {
    await seed(A, "alpha");
    for (let i = 0; i < 25; i++) r2.objects.set(`users/${A.userId}/many/${i}.md`, "x");
    r2.list = (async ({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) => {
      const all = [...r2.objects.keys()].filter((k) => k.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + 10).map((key) => ({ key }));
      return start + 10 < all.length ? { objects: page, truncated: true, cursor: String(start + 10) } : { objects: page, truncated: false };
    }) as typeof r2.list;
    const plan = (await planDeletion(target, "a@example.test"))!;
    expect(plan.r2Objects).toBeGreaterThan(25);
    expect(isClean(await deleteAccount(target, plan))).toBe(true);
  });
});
