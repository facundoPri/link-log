import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { existsSync, readFileSync, readdirSync } from "node:fs";

// ADR numbers are unique, and every "ADR NNNN" a doc or the Worker cites has its file (FAC-228).
// `adrDir` and `roots` are parameters so the checks can run against a broken fixture.

export const adrNumbers = (files: string[]) => files.flatMap((f) => (/^(\d{4})-/.exec(f) ? [/^(\d{4})-/.exec(f)![1]] : []));

export const duplicateNumbers = (files: string[]) => {
  const numbers = adrNumbers(files);
  return [...new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i))];
};

export const missingCitations = (adrFiles: string[], texts: Record<string, string>) => {
  const have = new Set(adrNumbers(adrFiles));
  return Object.entries(texts).flatMap(([file, text]) =>
    [...text.matchAll(/\bADR[ -](\d{4})\b/g)].filter((m) => !have.has(m[1]!)).map((m) => `${file}: ADR ${m[1]}`),
  );
};

const adrFiles = () => readdirSync("docs/adr").filter((f) => f.endsWith(".md"));
const citingTexts = () => {
  const paths = [
    ...new Glob("{docs,worker}/**/*.{md,ts}").scanSync("."),
    "GLOSSARY.md",
    "README.md",
  ].filter((p) => existsSync(p));
  return Object.fromEntries(paths.map((p) => [p, readFileSync(p, "utf8")]));
};

describe("ADRs", () => {
  test("no two files share a number prefix", () => {
    expect(duplicateNumbers(adrFiles())).toEqual([]);
  });

  test("every cited ADR has a file", () => {
    expect(missingCitations(adrFiles(), citingTexts())).toEqual([]);
  });

  test("the checks catch a duplicate number and a missing ADR", () => {
    expect(duplicateNumbers(["0001-a.md", "0002-b.md", "0001-c.md"])).toEqual(["0001"]);
    expect(missingCitations(["0001-a.md"], { "x.md": "see ADR 0001 and ADR 0002" })).toEqual(["x.md: ADR 0002"]);
  });
});
