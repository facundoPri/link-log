import { describe, expect, test } from "bun:test";
import {
  applyPatch,
  diffSnapshots,
  documentKey,
  lensFingerprint,
  matchesAllLensFilters,
  matchesLensFilter,
  parsePageRequest,
  parseTargetKey,
  patternCovers,
  targetKey,
  urlAccess,
  type Answer,
  type BrowserTab,
  type Lens,
  type WindowSnapshot,
} from "../src";

const lens = (p: Partial<Lens> = {}): Lens => ({
  id: "l1",
  name: "L",
  type: "noul",
  scope: "browser",
  question: "Is it relevant?",
  options: [],
  levels: [],
  criteria: { yes: "", no: "" },
  threshold: 0.8,
  version: 1,
  created_at: "t",
  ...p,
});

describe("lens identity", () => {
  test("threshold changes keep the fingerprint; question/options change it", () => {
    const base = lens();
    expect(lensFingerprint({ ...base, threshold: 0.6 } as Lens)).toBe(lensFingerprint(base));
    expect(lensFingerprint({ ...base, question: "Other?" })).not.toBe(lensFingerprint(base));
    expect(lensFingerprint({ ...base, criteria: { yes: "x", no: "" } })).not.toBe(lensFingerprint(base));
    const choice = lens({ type: "choice", options: [{ key: "a", label: "A", description: "" }] });
    expect(lensFingerprint({ ...choice, options: [{ key: "a", label: "B", description: "" }] })).not.toBe(lensFingerprint(choice));
  });
});

describe("filters", () => {
  const yes: Answer = { type: "noul", noul: 0.9 };
  const no: Answer = { type: "noul", noul: 0.1 };
  test("inverse answers are filterable but unknowns never match a constraint", () => {
    const f = { lensId: "l1", keys: ["no"], minLevel: null };
    expect(matchesLensFilter(lens(), no, f)).toBe(true);
    expect(matchesLensFilter(lens(), yes, f)).toBe(false);
    expect(matchesLensFilter(lens(), undefined, f)).toBe(false); // missing/failed ≠ No
    expect(matchesLensFilter(lens(), undefined, { ...f, keys: [] })).toBe(true); // no constraint
  });
  test("OR within a lens, AND across lenses", () => {
    const a = lens({ id: "a" });
    const b = lens({
      id: "b",
      type: "multi",
      threshold: 0.5,
      options: [
        { key: "x", label: "X", description: "" },
        { key: "y", label: "Y", description: "" },
      ],
    });
    const answers: Record<string, Answer> = { a: yes, b: { type: "multi", probabilities: { x: 0.9, y: 0.1 } } };
    const filters = [
      { lensId: "a", keys: ["yes", "unsure"], minLevel: null },
      { lensId: "b", keys: ["y", "x"], minLevel: null },
    ];
    expect(matchesAllLensFilters([a, b], (id) => answers[id], filters)).toBe(true);
    expect(matchesAllLensFilters([a, b], (id) => answers[id], [filters[0]!, { lensId: "b", keys: ["y"], minLevel: null }])).toBe(false);
    expect(matchesAllLensFilters([a, b], (id) => answers[id], [filters[0]!, { lensId: "b", keys: ["none"], minLevel: null }])).toBe(false);
  });
  test("score range", () => {
    const s = lens({ type: "score", levels: [{ label: "0", description: "" }, { label: "1", description: "" }, { label: "2", description: "" }] });
    const ans: Answer = { type: "score", score: 1.4, confidence: 1, probabilities: {}, legend: {} };
    expect(matchesLensFilter(s, ans, { lensId: "l1", keys: [], minLevel: 1 })).toBe(true);
    expect(matchesLensFilter(s, ans, { lensId: "l1", keys: [], minLevel: 2 })).toBe(false);
  });
});

describe("keys", () => {
  test("documents ignore fragments but not path or query (SPA navigations)", () => {
    expect(documentKey("https://a.dev/x#top")).toBe(documentKey("https://a.dev/x"));
    expect(documentKey("https://a.dev/x?page=2")).not.toBe(documentKey("https://a.dev/x"));
    expect(documentKey("https://a.dev/issues/2")).not.toBe(documentKey("https://a.dev/issues/1"));
  });
  test("target keys round-trip", () => {
    const parts = { tabInstanceId: "tab-1", documentRevision: 3, lensId: "lens", fingerprint: "abc", generation: 2 };
    expect(parseTargetKey(targetKey(parts))).toEqual(parts);
    expect(parseTargetKey("nope")).toBeNull();
  });
  test("restricted pages and permission patterns", () => {
    expect(urlAccess("chrome://settings")).toBe("restricted");
    expect(urlAccess("https://chromewebstore.google.com/detail/x")).toBe("restricted");
    expect(urlAccess("https://example.com")).toBe("available");
    expect(patternCovers("https://*/*", "https://example.com/a")).toBe(true);
    expect(patternCovers("https://*/*", "http://example.com/a")).toBe(false);
    expect(patternCovers("http://127.0.0.1/*", "http://127.0.0.1:3099/x")).toBe(true);
    expect(patternCovers("http://127.0.0.1:3000/*", "http://127.0.0.1:3099/x")).toBe(false);
    expect(patternCovers("https://*.github.com/*", "https://gist.github.com/x")).toBe(true);
  });
});

describe("messages", () => {
  test("validates commands and rejects unknown or malformed ones", () => {
    expect(parsePageRequest({ id: "r1", command: "snapshot", args: {} })?.command).toBe("snapshot");
    expect(parsePageRequest({ id: "r1", command: "eval", args: {} })).toBeNull();
    expect(parsePageRequest({ id: "r1", command: "closeTabs", args: { tabs: [{ tabId: "1" }] } })).toBeNull();
    expect(parsePageRequest({ id: "r1", command: "moveToGroup", args: { tabs: [], target: { kind: "new", title: "x", color: "neon", description: "" } } })).toBeNull();
    expect(parsePageRequest({ id: "<script>", command: "snapshot", args: {} })).toBeNull();
  });
});

describe("snapshots", () => {
  const tab = (tabId: number, index: number, title = `t${tabId}`): BrowserTab => ({
    tabId,
    tabInstanceId: `i${tabId}`,
    documentRevision: 0,
    windowId: 1,
    index,
    groupId: null,
    title,
    url: `https://x.dev/${tabId}`,
    favIconUrl: null,
    status: "complete",
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
    frozen: false,
    content: "available",
    openedAt: 0,
  });
  const snap: WindowSnapshot = { revision: 5, windowId: 1, tabs: [tab(1, 0), tab(2, 1)], groups: [], linklogTabs: 1 };
  test("small patches reproduce the next snapshot", () => {
    const next = { windowId: 1, tabs: [tab(2, 0, "renamed"), tab(3, 1)], groups: [], linklogTabs: 1 };
    const patch = diffSnapshots(snap, next, 6)!;
    expect(patch.upsertTabs.map((t) => t.tabId)).toEqual([2, 3]);
    expect(patch.removeTabs).toEqual([1]);
    expect(applyPatch(snap, patch)).toEqual({ ...next, revision: 6 });
    expect(diffSnapshots(snap, snap, 7)).toBeNull();
  });
  test("a patch for another revision is rejected so the page asks for a snapshot", () => {
    const patch = diffSnapshots(snap, { ...snap, tabs: [tab(1, 0)] }, 6)!;
    expect(applyPatch({ ...snap, revision: 4 }, patch)).toBeNull();
  });
});
