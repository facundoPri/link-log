// SQL that bun:sqlite runs but remote D1 rejects. Migrations and Worker SQL are scanned as text, so a
// statement no test executes is still caught before `migrations apply --remote` or a deploy.
import { expect, test } from "bun:test";
import { LIKE_PATTERN_HINT, MAX_LIKE_PATTERN_BYTES, TestD1, oversizedLikePatterns } from "./support/d1";

const files = (glob: string) => [...new Bun.Glob(glob).scanSync()].sort();
const offenders = async (glob: string) =>
  (await Promise.all(files(glob).map(async (file) => oversizedLikePatterns(await Bun.file(file).text()).map((p) => `${file}: '${p}' is over ${MAX_LIKE_PATTERN_BYTES} bytes. ${LIKE_PATTERN_HINT}`)))).flat();

test("migrations have no LIKE or GLOB pattern over D1's limit", async () => {
  expect(files("migrations/*.sql").length).toBeGreaterThan(0);
  expect(await offenders("migrations/*.sql")).toEqual([]);
});

test("Worker SQL has no LIKE or GLOB pattern over D1's limit", async () => {
  expect(files("worker/**/*.ts").length).toBeGreaterThan(0);
  expect(await offenders("worker/**/*.ts")).toEqual([]);
});

test("TestD1 rejects a LIKE or GLOB pattern over 50 bytes, as remote D1 does", async () => {
  const db = new TestD1();
  const at = (bytes: number, wildcard = "%") => `${"a".repeat(bytes - 1)}${wildcard}`;
  expect(await db.prepare(`SELECT 'abc' LIKE '${at(MAX_LIKE_PATTERN_BYTES)}' ok`).first<number>("ok")).toBe(0);
  expect(await db.prepare(`SELECT 'abc' GLOB '${at(MAX_LIKE_PATTERN_BYTES, "*")}' ok`).first<number>("ok")).toBe(0);
  for (const sql of [
    `SELECT 'abc' LIKE '${at(MAX_LIKE_PATTERN_BYTES + 1)}'`,
    `SELECT 'abc' NOT GLOB '${at(MAX_LIKE_PATTERN_BYTES + 1, "*")}'`,
    `SELECT 'abc' like '${"é".repeat(25)}%'`,
  ]) {
    await expect(db.prepare(sql).first()).rejects.toThrow("LIKE or GLOB pattern too complex");
    await expect(db.exec(sql)).rejects.toThrow("instr(col,'text')=1");
  }
});

test("TestD1 applies the same limit to a pattern bound to LIKE ? or GLOB ?N", async () => {
  const db = new TestD1();
  const long = `${"a".repeat(MAX_LIKE_PATTERN_BYTES)}%`;
  expect(await db.prepare("SELECT ? LIKE ? ok").bind(long, "a%").first<number>("ok")).toBe(1);
  expect(await db.prepare("SELECT 'a?' = ?2 AND ?1 GLOB ?3 ok").bind("a", "a?", "a*").first<number>("ok")).toBe(1);
  await expect(db.prepare("SELECT 'abc' LIKE ? ok").bind(long).first()).rejects.toThrow("LIKE or GLOB pattern too complex");
  await expect(db.prepare("SELECT ?1 NOT GLOB ?2 ok").bind("a", long).first()).rejects.toThrow(LIKE_PATTERN_HINT);
});
