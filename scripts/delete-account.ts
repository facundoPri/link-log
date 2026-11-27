// OWNER TOOL: deletes one Linklog account and everything stored for it, on request.
// Ley 25.326 art. 16 and the privacy policy promise this within 5 business days of an email request.
//
// Runbook
//   1. Check that the request came from the account's own address (the email you pass below). If it came from
//      anywhere else, ask the user to write from the account's address first.
//   2. Run a dry run, check the plan it prints (user id, row counts, counters, R2 objects):
//        bun scripts/delete-account.ts <email> --production --dry-run
//   3. Run it for real; it prints the same plan and asks you to type the email back:
//        bun scripts/delete-account.ts <email> --production
//   4. Reply to the user within 5 business days of the request, saying the account and its data are deleted.
//      Backups: D1 Time Travel keeps deleted rows restorable for 7 days (Free) or 30 days (Paid); the policy says so.
//
// Target. Local by default: the state dir `bun dev` uses (LINKLOG_PERSIST_TO, else .wrangler/state), or
// --state-dir <dir>. Production only with --production: the `production` environment of wrangler.jsonc
// (D1 linklog-production, R2 linklog-content-production) through Wrangler's remote bindings, so it needs
// `wrangler login` or CLOUDFLARE_API_TOKEN. The target is printed before anything is read or deleted.
//
// Deletes, in this order (FAC-358, docs/grills/FAC-175.md D5):
//   1. the user's browser_targets (the one foreign key without ON DELETE; steps 1 and 2 are one D1 batch)
//   2. the user row; D1 cascades links, tags, lenses, batches, browser requests and groups, usage,
//      sessions, accounts, API keys and settings
//   3. the app_rate_limits keys writes:<id> and links:<id> (email:to:<sha256> expires within 2 days on its own)
//   4. every R2 object under users/<id>/
// Running it again, or with an unknown email, finds no account, deletes nothing and exits 1. If a run stops
// after step 2 (an R2 error, a lost connection), the account row is gone and the email no longer matches:
// rerun with the user id from the plan to do steps 3 and 4 for it:
//   bun scripts/delete-account.ts --user-id <id> --production
// That mode refuses while the user row still exists.
//
// Options: --dry-run (print the plan, delete nothing), --yes (skip the typed confirmation).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stateDir as devStateDir } from "./dev";

export type Target = { db: D1Database; bucket: R2Bucket };

export type Plan = {
  userId: string;
  email: string;
  rows: Record<string, number>;
  counters: string[];
  r2Objects: number;
  /** Foreign-key violations in the whole database before anything is deleted; the check afterwards is database-wide too. */
  foreignKeyViolations: number;
};

const SAFE_ID = /^[A-Za-z0-9_-]{16,}$/;
const r2Prefix = (userId: string) => `users/${userId}/`;
const counterKeys = (userId: string) => [`writes:${userId}`, `links:${userId}`];

async function listKeys(bucket: R2Bucket, prefix: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

async function remainingCounters(db: D1Database, userId: string) {
  const keys = counterKeys(userId);
  const { results } = await db
    .prepare(`SELECT key FROM app_rate_limits WHERE key IN (${keys.map(() => "?").join(",")}) ORDER BY key`)
    .bind(...keys)
    .all<{ key: string }>();
  return results.map((r) => r.key);
}

const foreignKeyViolations = async (db: D1Database) => (await db.prepare("PRAGMA foreign_key_check").all()).results.length;

const assertSafeId = (id: string) => {
  if (!SAFE_ID.test(id)) throw new Error(`Refusing: user id "${id}" does not look like an id, so users/<id>/ could match other users' objects.`);
};

/** What deleting this email would remove. Null when no account has that email. Reads only. */
export async function planDeletion(target: Target, email: string): Promise<Plan | null> {
  const wanted = email.trim().toLowerCase();
  const user = await target.db.prepare('SELECT id, email FROM "user" WHERE lower(email)=?').bind(wanted).first<{ id: string; email: string }>();
  if (!user) return null;
  assertSafeId(user.id);
  const id = user.id;
  const rows = await target.db
    .prepare(
      `SELECT
         (SELECT count(*) FROM browser_targets WHERE request_id IN (SELECT request_id FROM browser_requests WHERE user_id=?1)) browser_targets,
         (SELECT count(*) FROM browser_requests WHERE user_id=?1) browser_requests,
         (SELECT count(*) FROM browser_groups WHERE user_id=?1) browser_groups,
         (SELECT count(*) FROM links WHERE user_id=?1) links,
         (SELECT count(*) FROM tags WHERE user_id=?1) tags,
         (SELECT count(*) FROM lenses WHERE user_id=?1) lenses,
         (SELECT count(*) FROM batches WHERE user_id=?1) batches,
         (SELECT count(*) FROM usage_events WHERE user_id=?1) usage_events,
         (SELECT count(*) FROM apikey WHERE referenceId=?1) api_keys,
         (SELECT count(*) FROM session WHERE userId=?1) sessions,
         (SELECT count(*) FROM account WHERE userId=?1) accounts,
         (SELECT count(*) FROM user_settings WHERE user_id=?1) user_settings`,
    )
    .bind(id)
    .first<Record<string, number>>();
  return {
    userId: id,
    email: user.email,
    rows: rows!,
    counters: await remainingCounters(target.db, id),
    r2Objects: (await listKeys(target.bucket, r2Prefix(id))).length,
    foreignKeyViolations: await foreignKeyViolations(target.db),
  };
}

/** What a finish run for an already deleted account would remove (steps 3 and 4 only). Null when nothing is left. */
export async function planFinish(target: Target, userId: string): Promise<Plan | null> {
  assertSafeId(userId);
  if (await target.db.prepare('SELECT 1 FROM "user" WHERE id=?').bind(userId).first()) throw new Error(`The account ${userId} still exists. Run the script with its email instead.`);
  const counters = await remainingCounters(target.db, userId);
  const r2Objects = (await listKeys(target.bucket, r2Prefix(userId))).length;
  if (!counters.length && !r2Objects) return null;
  return { userId, email: "(already deleted)", rows: {}, counters, r2Objects, foreignKeyViolations: await foreignKeyViolations(target.db) };
}

export type Leftovers = { userRow: boolean; counters: string[]; r2Keys: string[]; foreignKeyViolations: number };
export const isClean = (l: Leftovers) => !l.userRow && !l.counters.length && !l.r2Keys.length && l.foreignKeyViolations === 0;

/** Runs steps 1 and 2 for a planned account, then steps 3 and 4, and reports whatever is still there. */
export async function deleteAccount(target: Target, plan: Plan): Promise<Leftovers> {
  const { db } = target;
  const id = plan.userId;
  try {
    await db.batch([
      db.prepare("DELETE FROM browser_targets WHERE request_id IN (SELECT request_id FROM browser_requests WHERE user_id=?)").bind(id),
      db.prepare('DELETE FROM "user" WHERE id=?').bind(id),
    ]);
  } catch (error) {
    throw new Error(`Deleting the D1 rows of ${id} failed: ${error}. Run the same command again: if it finds no account, the rows are gone, so finish with --user-id ${id}.`);
  }
  return finishCleanup(target, plan);
}

/** Steps 3 and 4 for a user whose row is already gone. */
export async function finishCleanup(target: Target, plan: Plan): Promise<Leftovers> {
  const { db, bucket } = target;
  const id = plan.userId;
  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      throw new Error(`The account row of ${id} is deleted, but ${name} failed: ${error}. Rerun with --user-id ${id} to finish.`);
    }
  };
  await step("deleting the rate-limit counters", async () => {
    const keys = counterKeys(id);
    await db.prepare(`DELETE FROM app_rate_limits WHERE key IN (${keys.map(() => "?").join(",")})`).bind(...keys).run();
  });
  await step("deleting the R2 objects", async () => {
    let page = await bucket.list({ prefix: r2Prefix(id) });
    while (page.objects.length) {
      await bucket.delete(page.objects.map((o) => o.key));
      page = await bucket.list({ prefix: r2Prefix(id) });
    }
  });
  return {
    userRow: !!(await db.prepare('SELECT 1 FROM "user" WHERE id=?').bind(id).first()),
    counters: await remainingCounters(db, id),
    r2Keys: await listKeys(bucket, r2Prefix(id)),
    foreignKeyViolations: await foreignKeyViolations(db),
  };
}

export function formatPlan(plan: Plan) {
  const rows = Object.entries(plan.rows).map(([table, n]) => `    ${table.padEnd(18)} ${n}`);
  return [
    `  account       ${plan.email} (user id ${plan.userId})`,
    ...(rows.length ? ["  D1 rows (the user row cascades to the rest; counts are the main tables):", ...rows] : []),
    `  counters      ${plan.counters.length ? plan.counters.join(", ") : "none"}`,
    `  R2 objects    ${plan.r2Objects} under ${r2Prefix(plan.userId)}`,
    ...(plan.foreignKeyViolations ? [`  WARNING       the database already has ${plan.foreignKeyViolations} foreign-key violation(s), unrelated to this run; the final check will report them`] : []),
  ].join("\n");
}

type Connection = Target & { label: string; close(): Promise<void> };

/** Bindings through Wrangler's platform proxy, from a throwaway config that holds only D1 and R2 (no AI, Browser or Queue). */
async function connect(production: boolean, stateDir: string): Promise<Connection> {
  const { getPlatformProxy } = await import("wrangler");
  const config = (await Bun.file("wrangler.jsonc").text()).replace(/^\s*\/\/.*$/gm, "");
  const wrangler = Bun.JSONC.parse(config) as { d1_databases: Binding[]; r2_buckets: Binding[]; env: { production: { d1_databases: Binding[]; r2_buckets: Binding[] } } };
  const source = production ? wrangler.env.production : wrangler;
  const remote = production ? { remote: true } : {};
  const dir = mkdtempSync(join(tmpdir(), "linklog-delete-account-"));
  const configPath = join(dir, "wrangler.json");
  let proxy;
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        name: "linklog-delete-account",
        compatibility_date: "2026-09-21",
        d1_databases: source.d1_databases.map((d) => ({ ...d, migrations_dir: undefined, ...remote })),
        r2_buckets: source.r2_buckets.map((r) => ({ ...r, ...remote })),
      }),
    );
    proxy = await getPlatformProxy<{ DB: D1Database; CONTENT: R2Bucket }>({
      configPath,
      persist: production ? false : { path: join(stateDir, "v3") },
      remoteBindings: production,
    });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  const d1 = source.d1_databases[0]!, r2 = source.r2_buckets[0]!;
  return {
    db: proxy.env.DB,
    bucket: proxy.env.CONTENT,
    label: production ? `PRODUCTION (remote D1 ${d1.database_name}, R2 ${r2.bucket_name})` : `local state ${stateDir} (D1 ${d1.database_name}, R2 ${r2.bucket_name})`,
    close: async () => {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Binding = { database_name?: string; bucket_name?: string } & Record<string, unknown>;

function parseArgs(argv: string[]) {
  const options = { production: false, dryRun: false, yes: false, stateDir: devStateDir, email: "", userId: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--production") options.production = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--state-dir") options.stateDir = resolve(argv[++i] ?? "");
    else if (arg === "--user-id") options.userId = argv[++i] ?? "";
    else if (arg.startsWith("--") || options.email) throw new Error(`Unexpected argument "${arg}".`);
    else options.email = arg;
  }
  if (options.email.includes("@") === !!options.userId) throw new Error("Usage: bun scripts/delete-account.ts <email> | --user-id <id>  [--production] [--state-dir <dir>] [--dry-run] [--yes]");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.production && !existsSync(join(options.stateDir, "v3", "d1"))) throw new Error(`No local D1 under ${join(options.stateDir, "v3", "d1")}. Pass --state-dir, or --production.`);
  const conn = await connect(options.production, options.stateDir);
  try {
    console.log(`Target: ${conn.label}`);
    const finishing = !!options.userId;
    const plan = finishing ? await planFinish(conn, options.userId) : await planDeletion(conn, options.email);
    if (!plan) throw new Error(`${finishing ? `Nothing is left for the user id ${options.userId}` : `No account with the email ${options.email}`} on this target. Nothing was deleted.`);
    console.log(`Will delete:\n${formatPlan(plan)}`);
    if (options.dryRun) return console.log("Dry run: nothing was deleted.");
    const answer = finishing ? plan.userId : plan.email;
    if (!options.yes && prompt(`Type ${finishing ? "the user id" : "the email"} to delete ${options.production ? "PRODUCTION " : ""}data for ${answer}:`)?.trim().toLowerCase() !== answer.toLowerCase()) throw new Error("Not confirmed. Nothing was deleted.");
    const left = await (finishing ? finishCleanup(conn, plan) : deleteAccount(conn, plan));
    if (!isClean(left)) throw new Error(`Deleted, but this is still there: ${JSON.stringify(left)}`);
    console.log("Deleted: no user row, counters or R2 keys left, and PRAGMA foreign_key_check is empty.");
    console.log("Reply to the user within 5 business days of the request.");
  } finally {
    await conn.close();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
