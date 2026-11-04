import { expect, test } from "bun:test";
import { assertReadOnly, database } from "./prod";

test("production queries are single reads", () => {
  expect(assertReadOnly("SELECT * FROM jobs;")).toBe("SELECT * FROM jobs");
  expect(assertReadOnly("-- why\nWITH x AS (SELECT 1) SELECT * FROM x")).toStartWith("WITH");
  expect(assertReadOnly("SELECT count(*) FROM jobs WHERE error LIKE '%update%'")).toContain("update");
  expect(assertReadOnly("PRAGMA table_info(jobs)")).toBe("PRAGMA table_info(jobs)");
  for (const sql of [
    "DELETE FROM jobs",
    "SELECT 1; DROP TABLE jobs",
    "WITH x AS (SELECT 1) DELETE FROM jobs",
    "/* SELECT */ UPDATE jobs SET status='done'",
    "PRAGMA writable_schema=1",
  ])
    expect(() => assertReadOnly(sql)).toThrow();
});

test("--preview targets that PR's preview database, by the name scripts/preview gives it", () => {
  expect(database()).toEqual(["DB", "--env", "production"]);
  expect(database("21")).toEqual(["llpr-1384205267-21-db"]);
  for (const pr of ["", "0", "21; DROP", "-1"]) expect(() => database(pr)).toThrow();
});
