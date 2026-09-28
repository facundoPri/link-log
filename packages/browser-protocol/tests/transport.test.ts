import { describe, expect, test } from "bun:test";
import {
  BROWSER_LIMITS,
  chunk,
  chunkByBytes,
  isBridgeOrigin,
  jsonBytes,
  parsePageRequest,
  toEvaluationTarget,
} from "../src";

describe("byte-based batching", () => {
  test("measures UTF-8 bytes, not string length", () => {
    expect(jsonBytes("abc")).toBe(5);
    expect(jsonBytes("é")).toBe(4); // 2 bytes + quotes
    expect(jsonBytes("😀")).toBe(6); // 4 bytes, 2 UTF-16 units
    expect("é".repeat(1000).length).toBe(1000);
    expect(jsonBytes("é".repeat(1000))).toBe(2002);
  });

  test("chunks stay within the byte budget with non-ASCII content", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ i, text: "é".repeat(100_000) })); // ~200 KB each
    const maxBytes = 1_000_000;
    const chunks = chunkByBytes(items, { maxItems: 100, maxBytes, overhead: 500 });
    // By string length all 10 (~1M chars) would look like one request; in bytes they're ~2 MB.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(items);
    for (const c of chunks) expect(jsonBytes(c) + 500).toBeLessThanOrEqual(maxBytes);
  });

  test("chunks respect the item limit and keep order; an oversized item gets its own chunk", () => {
    expect(chunkByBytes([1, 2, 3, 4, 5], { maxItems: 2, maxBytes: 1_000 })).toEqual([[1, 2], [3, 4], [5]]);
    const big = "x".repeat(2_000);
    expect(chunkByBytes(["a", big, "b"], { maxItems: 10, maxBytes: 100 })).toEqual([["a"], [big], ["b"]]);
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(chunkByBytes([], { maxItems: 1, maxBytes: 1 })).toEqual([]);
  });

  test("the widest possible single capture fits one request", () => {
    // 160k characters that each need 3 UTF-8 bytes stay well under the per-request budget.
    const target = toEvaluationTarget({
      targetKey: "k",
      url: "https://a.dev/" + "p".repeat(10_000),
      title: "t".repeat(5_000),
      capture: {
        source: "dom",
        capturedAt: "2026-01-01T00:00:00Z",
        completeness: "complete",
        reasons: [],
        chars: 0,
        facts: [],
        url: "",
        title: "",
        description: "d".repeat(5_000),
        siteName: "",
        markdown: "€".repeat(BROWSER_LIMITS.maxCaptureChars),
      },
    });
    expect(target.url.length).toBe(BROWSER_LIMITS.maxUrlChars);
    expect(target.title.length).toBe(BROWSER_LIMITS.maxTitleChars);
    expect(target.capture.description.length).toBe(2000);
    expect(jsonBytes(target) + BROWSER_LIMITS.requestOverheadBytes).toBeLessThan(BROWSER_LIMITS.maxRequestBytes);
  });
});

describe("page requests", () => {
  test("prototype keys are not commands", () => {
    for (const command of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"])
      expect(parsePageRequest({ id: "r1", command, args: {} })).toBeNull();
  });

  test("size limits on clean and deposit", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(parsePageRequest({ id: "r", command: "clean", args: { lensIds: ["l"], tabInstanceIds: ids(500) } })).not.toBeNull();
    expect(parsePageRequest({ id: "r", command: "clean", args: { lensIds: ["l"], tabInstanceIds: ids(501) } })).toBeNull();
    const item = (answer: unknown) => ({ id: "r", command: "deposit", args: { requestId: "q", items: [{ targetKey: "k", state: "done", answer }] } });
    expect(parsePageRequest(item({ type: "noul", noul: 0.9 }))).not.toBeNull();
    expect(parsePageRequest(item({ type: "noul", reason: "x".repeat(30_000) }))).toBeNull();
  });

  test("tab references may carry the document revision they were seen at", () => {
    const tabs = [{ tabId: 1, tabInstanceId: "i", documentRevision: 2 }];
    expect(parsePageRequest({ id: "r", command: "capture", args: { tabs } })).not.toBeNull();
    expect(parsePageRequest({ id: "r", command: "capture", args: { tabs: [{ ...tabs[0], documentRevision: "2" }] } })).toBeNull();
  });
});

describe("bridge origins", () => {
  test("local http on any port, configured origins, nothing else", () => {
    expect(isBridgeOrigin("http://localhost:3000", [])).toBe(true);
    expect(isBridgeOrigin("http://127.0.0.1:4123", [])).toBe(true);
    expect(isBridgeOrigin("http://localhost", [])).toBe(true);
    expect(isBridgeOrigin("https://localhost:3000", [])).toBe(false);
    expect(isBridgeOrigin("http://localhost.evil.dev", [])).toBe(false);
    expect(isBridgeOrigin("http://10.0.0.2:3000", [])).toBe(false);
    expect(isBridgeOrigin("https://linklog.example", [])).toBe(false);
    expect(isBridgeOrigin("https://linklog.example", ["https://linklog.example"])).toBe(true);
    expect(isBridgeOrigin("null", [])).toBe(false);
  });
});
