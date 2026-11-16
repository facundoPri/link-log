import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";

// Every client read goes through the query cache and can be aborted (FAC-228). Typecheck covers the
// helpers in src/api.ts (`apiRead` needs a signal, `api` takes no GET). This test covers what types
// cannot: a new `fetch` or auth-client read that skips them.

const TRANSPORTS = ["src/api.ts", "src/browser/api.ts"];
// The Bun dev server's proxy to Wrangler, not client code.
const SERVER_ONLY = ["src/proxy.ts"];

const files = [...new Glob("src/**/*.{ts,tsx}").scanSync(".")].filter((f) => !SERVER_ONLY.includes(f));
// Comments are dropped so a word in one cannot satisfy or trip a rule. (A URL's `//` inside a string is
// cut too, which only shortens the line.)
const read = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Each `fetch(...)` call's text, through its matching closing parenthesis. */
const fetchCalls = (source: string) =>
  [...source.matchAll(/\bfetch\(/g)].map((m) => {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) return source.slice(m.index, i + 1);
    }
    return source.slice(m.index);
  });

describe("client reads", () => {
  test("only the two transports call fetch", () => {
    const offenders = files.filter((f) => !TRANSPORTS.includes(f) && fetchCalls(read(f)).length > 0);
    expect(offenders).toEqual([]);
  });

  test("each transport fetch passes the signal it was given", () => {
    for (const file of TRANSPORTS) {
      const calls = fetchCalls(read(file));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect({ file, passesSignal: /\bsignal,/.test(call) }).toEqual({ file, passesSignal: true });
    }
  });

  test("the API keys list is read only through apiKeysRead, which needs a signal", () => {
    const offenders = files.filter((f) => f !== "src/api.ts" && /\bapiKey\.list\(/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
