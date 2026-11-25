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
  [...source.matchAll(/\bfetch\s*\(/g)].map((m) => {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")" && --depth === 0) return source.slice(m.index, i + 1);
    }
    return source.slice(m.index);
  });

/** Whether a `fetch(url, options)` call's options object has its own `signal` property (not a nested one). */
const passesSignal = (call: string) => {
  // Text at each bracket depth: 1 is fetch's arguments, 2 is the top level of an object argument.
  let depth = 0;
  let args = "";
  let options = "";
  for (const ch of call.slice(call.indexOf("("))) {
    if ("{([".includes(ch)) {
      depth++;
      if (depth === 2 && ch === "{" && args.includes(",")) options = " ";
      continue;
    }
    if ("})]".includes(ch)) {
      if (--depth === 0) break;
      continue;
    }
    if (depth === 1) args += ch;
    else if (depth === 2 && options) options += ch;
  }
  return /(^|,)\s*signal\s*(,|:|$)/.test(options.trim());
};

const apiKeyList = /\bapiKey\s*\.\s*list\s*\(/;

describe("client reads", () => {
  test("only the two transports call fetch", () => {
    const offenders = files.filter((f) => !TRANSPORTS.includes(f) && fetchCalls(read(f)).length > 0);
    expect(offenders).toEqual([]);
  });

  test("each transport fetch passes the signal it was given", () => {
    for (const file of TRANSPORTS) {
      const calls = fetchCalls(read(file));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect({ file, passesSignal: passesSignal(call) }).toEqual({ file, passesSignal: true });
    }
  });

  test("the guards see through spacing and nesting", () => {
    expect(fetchCalls('fetch ("/api/library")')).toHaveLength(1);
    expect(passesSignal("fetch(path, { method, signal, headers: {} })")).toBe(true);
    expect(passesSignal("fetch(path, { method, signal: controller.signal })")).toBe(true);
    expect(passesSignal("fetch(path, { body: JSON.stringify({ signal, }) })")).toBe(false);
    expect(passesSignal("fetch(path, { headers: { signal: 1 } })")).toBe(false);
    expect(apiKeyList.test("authClient.apiKey . list ()")).toBe(true);
  });

  test("the API keys list is read only through apiKeysRead, which needs a signal", () => {
    const offenders = files.filter((f) => f !== "src/api.ts" && apiKeyList.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
