// Every rollback script in scripts/migrations/rollback restores the schema of the migration before it: the same
// tables, columns, foreign keys, indexes and triggers. Asserting a few chosen clauses missed a CASCADE that the
// 0029 rollback put where 0028 had SET NULL.
import { expect, test } from "bun:test";
import { TestD1 } from "./support/d1";

const schema = (db: TestD1) =>
  (db.sqlite.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name<>'d1_migrations' ORDER BY type,name").all() as { sql: string | null }[])
    // A rebuilt table keeps its definition but not its layout; the rename leaves the name quoted.
    .map((r) => ({ ...r, sql: r.sql && normalize(r.sql) }));
// Layout is normalized outside single-quoted literals only, so `DEFAULT 'a  b'` stays distinct from `DEFAULT 'a b'`.
const normalize = (sql: string) =>
  sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",").replace(/"(\w+)"/g, "$1")))
    .join("");

// Differences a rollback documents in its header. 0013 keeps a nullable, unused user_id: SQLite can't drop it.
const KEPT: Record<string, (sql: string) => string> = {
  "0013": (sql) => sql.replace(/, user_id TEXT REFERENCES user\(id\) ON DELETE CASCADE\)$/, ")"),
};

const migrations = [...new Bun.Glob("migrations/*.sql").scanSync()].map((f) => f.split("/").pop()!.slice(0, 4)).sort();
for (const file of [...new Bun.Glob("scripts/migrations/rollback/*.down.sql").scanSync()].sort()) {
  const n = file.split("/").pop()!.slice(0, 4);
  test(`rollback ${n} restores the schema of ${migrations[migrations.indexOf(n) - 1]}`, async () => {
    const before = await TestD1.migrated(migrations[migrations.indexOf(n) - 1]);
    const after = await TestD1.migrated(n);
    after.sqlite.exec("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT)");
    await after.exec(await Bun.file(file).text());
    const kept = KEPT[n] ?? ((sql: string) => sql);
    expect(schema(after).map((r) => ({ ...r, sql: r.sql && kept(r.sql) }))).toEqual(schema(before));
  });
}

test("normalizing layout keeps distinct literals distinct", () => {
  expect(normalize("CREATE TABLE t(a TEXT DEFAULT 'a  b')")).not.toBe(normalize("CREATE TABLE t(a TEXT DEFAULT 'a b')"));
  expect(normalize('CREATE TABLE "t" (\n  a TEXT ,\n  b TEXT\n)')).toBe("CREATE TABLE t (a TEXT, b TEXT)");
});
