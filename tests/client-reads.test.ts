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
const read = (file: string) => readFileSync(file, "utf8");

/** Each `fetch(...)` call's text, up to its closing `});`. */
const fetchCalls = (source: string) => [...source.matchAll(/\bfetch\(/g)].map((m) => source.slice(m.index, source.indexOf("});", m.index) + 3));

describe("client reads", () => {
  test("only the two transports call fetch", () => {
    const offenders = files.filter((f) => !TRANSPORTS.includes(f) && fetchCalls(read(f)).length > 0);
    expect(offenders).toEqual([]);
  });

  test("each transport fetch passes the signal it was given", () => {
    for (const file of TRANSPORTS) {
      const calls = fetchCalls(read(file));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect({ file, passesSignal: /\bsignal\b/.test(call) }).toEqual({ file, passesSignal: true });
    }
  });

  test("the API keys list is read only through apiKeysRead, which needs a signal", () => {
    const offenders = files.filter((f) => f !== "src/api.ts" && /\bapiKey\.list\(/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
