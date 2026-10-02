// LOCAL tool: assigns library rows that predate FAC-41 (user_id IS NULL) to one verified user.
// Until this runs, those rows stay in D1/R2 untouched but unreachable through the API.
//
//   bun scripts/adjudicate-legacy.ts inventory --state-dir .wrangler/state
//   bun scripts/adjudicate-legacy.ts backup    --state-dir .wrangler/state
//   bun scripts/adjudicate-legacy.ts assign    --state-dir .wrangler/state --user-id <id> --email <email> [--dry-run]
//
// It only opens a local Wrangler/Miniflare state dir (never remote D1) and refuses to write while
// another process holds the database file. See planning/research/auth-implementation-report.md.
import { Database } from "bun:sqlite";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const OWNED = ["links", "tags", "lenses", "batches", "usage_events"] as const;
const DERIVED: Record<string, string> = {
  link_tags: "link_id IN (SELECT id FROM links WHERE user_id IS NULL)",
  jobs: "batch_id IN (SELECT id FROM batches WHERE user_id IS NULL)",
  tag_evaluations: "link_id IN (SELECT id FROM links WHERE user_id IS NULL)",
  lens_results: "link_id IN (SELECT id FROM links WHERE user_id IS NULL)",
  media_items: "link_id IN (SELECT id FROM links WHERE user_id IS NULL)",
  hidden_related_links: "link_id IN (SELECT id FROM links WHERE user_id IS NULL)",
  "links with R2 content": "user_id IS NULL AND content_key IS NOT NULL",
};

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export function findDatabase(stateDir: string) {
  const dir = join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) throw new Error(`No local D1 under ${dir}.`);
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => join(dir, f))
    .filter((file) => {
      const db = new Database(file, { readonly: true });
      try {
        return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='links'").get();
      } finally {
        db.close();
      }
    });
  if (candidates.length !== 1)
    throw new Error(`Expected one Linklog database in ${dir}, found ${candidates.length}. Pass --db-file.`);
  return candidates[0]!;
}

function assertMigrated(db: Database) {
  const cols = db.query("PRAGMA table_info(links)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "user_id"))
    throw new Error("Apply migrations first (bun run db:migrate or bun run dev); links has no user_id yet.");
}

export function inventory(db: Database) {
  assertMigrated(db);
  const counts: Record<string, number> = {};
  for (const table of OWNED)
    counts[table] = (db.query(`SELECT count(*) c FROM ${table} WHERE user_id IS NULL`).get() as { c: number }).c;
  for (const [label, where] of Object.entries(DERIVED)) {
    const table = label.startsWith("links ") ? "links" : label;
    counts[label] = (db.query(`SELECT count(*) c FROM ${table} WHERE ${where}`).get() as { c: number }).c;
  }
  counts["legacy settings"] = (db.query("SELECT count(*) c FROM settings").get() as { c: number }).c;
  const users = db
    .query('SELECT id,email,"emailVerified" verified,"createdAt" created FROM "user" ORDER BY "createdAt"')
    .all() as { id: string; email: string; verified: number; created: string }[];
  return { counts, users };
}

export function conflicts(db: Database, userId: string) {
  return {
    links: db
      .query("SELECT l.original_url FROM links l JOIN links o ON o.user_id=? AND o.original_url=l.original_url WHERE l.user_id IS NULL")
      .all(userId) as { original_url: string }[],
    tags: db
      .query("SELECT t.name FROM tags t JOIN tags o ON o.user_id=? AND o.name=t.name COLLATE NOCASE WHERE t.user_id IS NULL")
      .all(userId) as { name: string }[],
    lenses: db
      .query("SELECT l.name FROM lenses l JOIN lenses o ON o.user_id=? AND o.name=l.name COLLATE NOCASE WHERE l.user_id IS NULL")
      .all(userId) as { name: string }[],
  };
}

/** Assigns every unassigned row to `userId` in one transaction. Throws (nothing written) on any doubt. */
export function assign(db: Database, userId: string, email: string, dryRun: boolean) {
  assertMigrated(db);
  const user = db.query('SELECT id,email,"emailVerified" verified FROM "user" WHERE id=?').get(userId) as
    | { id: string; email: string; verified: number }
    | null;
  if (!user) throw new Error("No such user id.");
  if (user.email.toLowerCase() !== email.toLowerCase()) throw new Error("The email does not match that user id.");
  if (!user.verified) throw new Error("That user has not verified their email.");
  const clash = conflicts(db, userId);
  if (clash.links.length || clash.tags.length || clash.lenses.length)
    throw new Error(`Conflicts with rows the user already owns; resolve them first: ${JSON.stringify(clash)}`);

  const before = inventory(db).counts;
  const moved: Record<string, number> = {};
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of OWNED)
      moved[table] = db.query(`UPDATE ${table} SET user_id=? WHERE user_id IS NULL`).run(userId).changes;
    moved["settings copied"] = db
      .query("INSERT OR IGNORE INTO user_settings(user_id,key,value,updated_at) SELECT ?,key,value,? FROM settings")
      .run(userId, new Date().toISOString()).changes;
    const crossOwner = db
      .query(
        `SELECT
          (SELECT count(*) FROM link_tags lt JOIN links l ON l.id=lt.link_id JOIN tags t ON t.id=lt.tag_id WHERE l.user_id IS NOT t.user_id) +
          (SELECT count(*) FROM jobs j JOIN links l ON l.id=j.link_id JOIN batches b ON b.id=j.batch_id WHERE l.user_id IS NOT b.user_id) +
          (SELECT count(*) FROM tag_evaluations e JOIN links l ON l.id=e.link_id JOIN tags t ON t.id=e.tag_id WHERE l.user_id IS NOT t.user_id) +
          (SELECT count(*) FROM lens_results r JOIN links l ON l.id=r.link_id JOIN lenses x ON x.id=r.lens_id WHERE l.user_id IS NOT x.user_id) c`,
      )
      .get() as { c: number };
    if (crossOwner.c) throw new Error(`Integrity check failed: ${crossOwner.c} cross-owner relations.`);
    for (const table of OWNED)
      if (moved[table] !== before[table]) throw new Error(`Count mismatch for ${table}.`);
    const fk = db.query("PRAGMA foreign_key_check").all();
    if (fk.length) throw new Error(`Foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { before, moved, after: inventory(db).counts, dryRun };
}

function assertNotOpenElsewhere(file: string) {
  const lsof = Bun.spawnSync(["lsof", "-t", file, `${file}-wal`]);
  if (lsof.stdout.toString().trim()) throw new Error("The database is open in another process. Stop `bun run dev` first.");
}

if (import.meta.main) {
  const command = process.argv[2];
  const stateDir = resolve(arg("state-dir") ?? ".wrangler/state");
  const file = arg("db-file") ?? findDatabase(stateDir);
  if (command === "inventory") {
    const db = new Database(file, { readonly: true });
    console.log(JSON.stringify({ database: file, ...inventory(db) }, null, 2));
  } else if (command === "backup") {
    assertNotOpenElsewhere(file);
    const target = `${stateDir}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    cpSync(stateDir, target, { recursive: true, errorOnExist: true });
    console.log(`Copied ${stateDir} (D1 + R2 + auth secret) to ${target}. Restore by stopping dev and copying it back.`);
  } else if (command === "assign") {
    const userId = arg("user-id"), email = arg("email");
    if (!userId || !email) throw new Error("Pass --user-id and --email of a verified user (see inventory).");
    const dryRun = process.argv.includes("--dry-run");
    if (!dryRun) assertNotOpenElsewhere(file);
    const db = new Database(file);
    db.exec("PRAGMA foreign_keys=ON");
    console.log(JSON.stringify(assign(db, userId, email, dryRun), null, 2));
  } else {
    console.log("Usage: inventory | backup | assign --user-id <id> --email <email> [--dry-run]  [--state-dir dir] [--db-file file]");
    process.exit(1);
  }
}
