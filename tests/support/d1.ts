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

/**
 * Splits a script into statements. bun:sqlite's exec() on a multi-statement string reports a runtime error
 * (a failed constraint) only when the last statement fails; an earlier one fails silently and the rest still run,
 * where D1 rejects the script. A `;` ends a statement outside quotes, brackets and comments, and a CREATE TRIGGER
 * only at the `END;` that closes its body, not one that closes a CASE inside it.
 */
// Comments become a space, so `CREATE/**/TRIGGER` keeps its token boundary. Used only to classify a statement.
const withoutComments = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");

export function statements(sql: string) {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = sql.indexOf(c === "[" ? "]" : c, i + 1);
      i = close < 0 ? sql.length : close;
    }
    else if (c === "-" && sql[i + 1] === "-") i = sql.indexOf("\n", i) < 0 ? sql.length : sql.indexOf("\n", i);
    else if (c === "/" && sql[i + 1] === "*") i = sql.indexOf("*/", i + 2) < 0 ? sql.length : sql.indexOf("*/", i + 2) + 1;
    else if (c === ";") {
      const stmt = sql.slice(start, i + 1);
      const code = withoutComments(stmt);
      const words = (re: RegExp) => code.replace(/'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\]/g, " ").match(re)?.length ?? 0;
      const trigger = /^\s*CREATE\s+(TEMP\w*\s+)?TRIGGER\b/i.test(code);
      if (trigger && !(/\bEND\s*;$/i.test(code.trimEnd()) && words(/\bEND\b/gi) > words(/\bCASE\b/gi))) continue;
      if (code.trim() !== ";") out.push(stmt);
      start = i + 1;
    }
  }
  if (withoutComments(sql.slice(start)).trim()) out.push(sql.slice(start));
  return out;
}

export const MAX_BOUND_PARAMETERS = 100;
// Remote D1 caps a LIKE or GLOB pattern at 50 bytes; SQLite's default, used by bun:sqlite and miniflare, is
// 50,000. Measured on remote D1: 50 bytes runs, 51 fails, and multibyte characters count per byte.
export const MAX_LIKE_PATTERN_BYTES = 50;

/** String-literal LIKE/GLOB patterns in `text` that remote D1 rejects. `text` may be SQL or source holding SQL. */
export const oversizedLikePatterns = (text: string) =>
  [...text.matchAll(/\b(?:like|glob)\s+'((?:[^']|'')*)'/gi)]
    .map((m) => m[1]!.replaceAll("''", "'"))
    .filter((pattern) => Buffer.byteLength(pattern) > MAX_LIKE_PATTERN_BYTES);

export const LIKE_PATTERN_HINT = "For a prefix match, use instr(col,'text')=1.";

/** Values bound to `LIKE ?` / `GLOB ?` (or `?N`), which D1 limits like literal patterns. */
const boundLikePatterns = (sql: string, params: unknown[]) => {
  let next = 0;
  return [...sql.replace(/'(?:[^']|'')*'/g, "''").matchAll(/(\b(?:like|glob)\s*)?\?(\d*)/gi)].flatMap((m) => {
    const index = m[2] ? Number(m[2]) - 1 : next;
    next = Math.max(next, index + 1);
    const value = params[index];
    return m[1] && typeof value === "string" ? [value] : [];
  });
};

const assertLikePatterns = (sql: string, params: unknown[] = []) => {
  const pattern = [...oversizedLikePatterns(sql), ...boundLikePatterns(sql, params)].find(
    (p) => Buffer.byteLength(p) > MAX_LIKE_PATTERN_BYTES,
  );
  if (pattern === undefined) return;
  throw new Error(
    `D1_ERROR: LIKE or GLOB pattern too complex: SQLITE_ERROR ('${pattern}' is ${Buffer.byteLength(pattern)} bytes > ${MAX_LIKE_PATTERN_BYTES}). ${LIKE_PATTERN_HINT}`,
  );
};

export class TestD1 {
  readonly sqlite: Database;
  constructor(sqlite = new Database(":memory:")) {
    this.sqlite = sqlite;
    // Seeds call db.sqlite.exec(...) directly too; every script runs statement by statement (see statements()).
    const exec = sqlite.exec.bind(sqlite);
    sqlite.exec = ((sql: string, ...params: never[]) => {
      if (params.length) return exec(sql, ...params);
      let last = { changes: 0, lastInsertRowid: 0 } as ReturnType<typeof exec>;
      for (const stmt of statements(sql)) last = exec(stmt);
      return last;
    }) as typeof sqlite.exec;
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
      if ((!from || name > `${from}~`) && name <= `${upTo}~`) await this.exec(await Bun.file(file).text());
    }
  }
  run(sql: string, params: unknown[]) {
    // D1's limit, also per statement inside batch() (developers.cloudflare.com/d1/platform/limits/).
    // SQLite itself allows far more, so without this the tests could not catch it.
    if (params.length > MAX_BOUND_PARAMETERS) throw new Error(`D1_ERROR: too many SQL variables (${params.length} > ${MAX_BOUND_PARAMETERS})`);
    assertLikePatterns(sql, params);
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
    assertLikePatterns(sql);
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
