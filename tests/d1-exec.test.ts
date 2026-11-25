// TestD1.exec and its sqlite.exec run a script one statement at a time, so a statement that fails before the last one fails the
// script as it does on D1. bun:sqlite's exec() on the whole string reports only the last statement's error.
import { expect, test } from "bun:test";
import { statements, TestD1 } from "./support/d1";

test("a statement failing before the last one fails the script", async () => {
  const db = new TestD1();
  await db.exec("CREATE TABLE t(a NOT NULL)");
  await expect(db.exec("INSERT INTO t VALUES(NULL); INSERT INTO t VALUES(1);")).rejects.toThrow(/NOT NULL/);
  expect(() => db.sqlite.exec("INSERT INTO t VALUES(NULL); INSERT INTO t VALUES(2);")).toThrow(/NOT NULL/);
  expect(db.sqlite.query("SELECT a FROM t").all()).toEqual([]);
});

test("splits on semicolons outside quotes, comments and trigger bodies", () => {
  const sql = `-- a comment; not a split
CREATE TABLE t(a TEXT DEFAULT 'x;y'); /* block; comment */
CREATE TRIGGER tr BEFORE INSERT ON t WHEN NEW.a = ';'
BEGIN SELECT RAISE(ABORT, 'no;'); END;
INSERT INTO t VALUES("q;"); PRAGMA foreign_keys = ON;
`;
  expect(statements(sql).map((s) => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "").trim().split(/\s+/).slice(0, 2).join(" "))).toEqual([
    "CREATE TABLE",
    "CREATE TRIGGER",
    "INSERT INTO",
    "PRAGMA foreign_keys",
  ]);
});
