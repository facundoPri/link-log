// Minimal D1Database over bun:sqlite for tests. It keeps D1's observable contract for what Linklog
// and Better Auth use: async prepare/bind/first/all/run/raw, atomic batch(), exec(), result meta,
// foreign keys on. Better Auth detects it as D1 (batch+exec+prepare) and uses its D1 dialect.
import { Database } from "bun:sqlite";

type Value = string | number | bigint | null | Uint8Array;
const toSqlite = (v: unknown): Value => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as Value;
};
const returnsRows = (sql: string) => /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql);

export const MAX_BOUND_PARAMETERS = 100;

export class TestD1 {
  readonly sqlite: Database;
  constructor(sqlite = new Database(":memory:")) {
    this.sqlite = sqlite;
    this.sqlite.exec("PRAGMA foreign_keys=ON");
  }
  static async migrated(upTo?: string) {
    const db = new TestD1();
    await db.migrate(upTo);
    return db;
  }
  /** Applies migrations whose number is in (from, upTo], e.g. migrate("0009") or migrate(undefined, "0009"). */
  async migrate(upTo = "9999", from = "") {
    for (const file of [...new Bun.Glob("migrations/*.sql").scanSync()].sort()) {
      const name = file.split("/").pop()!;
      if ((!from || name > `${from}~`) && name <= `${upTo}~`) this.sqlite.exec(await Bun.file(file).text());
    }
  }
  run(sql: string, params: unknown[]) {
    // D1's limit, also per statement inside batch() (developers.cloudflare.com/d1/platform/limits/).
    // SQLite itself allows far more, so without this the tests could not catch it.
    if (params.length > MAX_BOUND_PARAMETERS) throw new Error(`D1_ERROR: too many SQL variables (${params.length} > ${MAX_BOUND_PARAMETERS})`);
    const stmt = this.sqlite.prepare(sql);
    const values = params.map(toSqlite);
    if (returnsRows(sql)) {
      const results = stmt.all(...(values as never[])) as Record<string, unknown>[];
      const meta = this.sqlite.query("SELECT changes() changes, last_insert_rowid() id").get() as { changes: number; id: number };
      return { results, success: true, meta: { changes: /^\s*(select|with|pragma)\b/i.test(sql) ? 0 : meta.changes, last_row_id: meta.id, duration: 0 } };
    }
    const info = stmt.run(...(values as never[]));
    return { results: [], success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 } };
  }
  prepare(sql: string) {
    return new TestStatement(this, sql, []);
  }
  async batch(statements: TestStatement[]) {
    this.sqlite.exec("BEGIN");
    try {
      const out = statements.map((s) => this.run(s.sql, s.params));
      this.sqlite.exec("COMMIT");
      return out;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
  get d1() {
    return this as unknown as D1Database;
  }
}

class TestStatement {
  constructor(
    readonly db: TestD1,
    readonly sql: string,
    readonly params: unknown[],
  ) {}
  bind(...params: unknown[]) {
    return new TestStatement(this.db, this.sql, params);
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.run(this.sql, this.params).results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all() {
    return this.db.run(this.sql, this.params);
  }
  async run() {
    return this.db.run(this.sql, this.params);
  }
  async raw() {
    return this.db.run(this.sql, this.params).results.map((r) => Object.values(r));
  }
}
