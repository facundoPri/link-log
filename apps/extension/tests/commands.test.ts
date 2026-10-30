import { beforeEach, describe, expect, test } from "bun:test";
import { BROWSER_LIMITS, jsonBytes, toEvaluationTarget, type PageRequest } from "@linklog/browser-protocol";
import { fakeChrome } from "./fake-chrome";
import { ResultCache } from "../src/background/cache";
import { handle, type Services } from "../src/background/commands";
import { GroupMetaStore } from "../src/background/groups";
import { Hub, type Connection } from "../src/background/hub";
import { memoryKV, Mutex } from "../src/background/kv";
import { OpenLedger } from "../src/background/opens";
import { TabRegistry } from "../src/background/registry";

const LINKLOG_TAB = 99;
let chromeFake: ReturnType<typeof fakeChrome>;
let s: Services;
let c: Connection;
let seq = 0;

async function setup(count: number, markdown?: (i: number) => string) {
  chromeFake = fakeChrome();
  const kv = memoryKV();
  const mutex = new Mutex();
  const registry = new TabRegistry(kv, () => `inst${++seq}`, () => 0);
  const groups = new GroupMetaStore(kv, mutex);
  const hub = new Hub(kv, registry, groups);
  hub.grants = ["http://*/*", "https://*/*"];
  s = { registry, cache: new ResultCache(kv, mutex), groups, hub, opens: new OpenLedger(kv), ids: { installationId: "inst", browserSessionId: "sess" } };
  chromeFake.addTab(LINKLOG_TAB, "http://localhost:4321/");
  for (let i = 1; i <= count; i++) {
    chromeFake.addTab(i, `https://site.dev/${i}`);
    if (markdown) chromeFake.pages.get(i)!.markdown = markdown(i);
  }
  c = { id: "c1", port: { postMessage() {} } as unknown as chrome.runtime.Port, tabId: LINKLOG_TAB, windowId: null, scope: null, last: null };
  hub.connections.set(c.id, c);
}

const run = <K extends PageRequest["command"]>(command: K, args: Extract<PageRequest, { command: K }>["args"]) =>
  handle({ id: `r${++seq}`, command, args } as PageRequest, c, s) as Promise<any>;
/** Handshake, then a first snapshot (which registers the tabs, as when the page connects). */
const hello = async () => {
  await run("hello", { libraryScope: "local:lib" });
  await run("snapshot", {});
};
const lens = { id: "lens", fingerprint: "fp" };

beforeEach(() => {
  seq = 0;
});

describe("bridge commands", () => {
  test("nothing but hello is accepted before the handshake", async () => {
    await setup(1);
    expect(run("snapshot", {})).rejects.toThrow("Connect first.");
    expect(run("closeTabs", { tabs: [] })).rejects.toThrow("Connect first.");
    await hello();
    const snap = await run("snapshot", {});
    // The Linklog page itself (its bridge is connected) is never listed.
    expect(snap.tabs.map((t: { tabId: number }) => t.tabId)).toEqual([1]);
    expect(snap.linklogTabs).toBe(1);
  });

  test("forget drops only this account's scope and ends the handshake", async () => {
    await setup(2, (i) => `page ${i}`);
    await hello();
    const mine = await run("claim", { lens, limit: 20 });
    await run("accepted", { requestId: mine.requestId, batchId: "b", jobs: [] });
    // Another account (library scope) in the same browser.
    await run("hello", { libraryScope: "local:other" });
    const theirs = await run("claim", { lens, limit: 20 });
    await run("hello", { libraryScope: "local:lib" });
    expect((await run("pending", {})).requests.map((r: { requestId: string }) => r.requestId)).toEqual([mine.requestId]);
    const result = await run("forget", {});
    expect(result.removed).toBe(2);
    expect(run("pending", {})).rejects.toThrow("Connect first.");
    await run("hello", { libraryScope: "local:lib" });
    expect((await run("pending", {})).requests).toEqual([]);
    await run("hello", { libraryScope: "local:other" });
    expect((await run("pending", {})).requests.map((r: { requestId: string }) => r.requestId)).toEqual([theirs.requestId]);
    expect((await run("hello", { libraryScope: "local:other" })).capabilities).toContain("forget");
  });

  test("a pinned group's Linklog metadata is only visible to the account that wrote it", async () => {
    await setup(1);
    await hello();
    const tab = (await run("snapshot", {})).tabs[0];
    await run("moveToGroup", {
      tabs: [{ tabId: tab.tabId, tabInstanceId: tab.tabInstanceId }],
      target: { kind: "pinned", pinnedId: "pin-a", title: "Research", color: "blue", description: "A's private brief" },
    });
    chromeFake.groups.set(1, { id: 1, windowId: 1, title: "Research", color: "blue", collapsed: false } as chrome.tabGroups.TabGroup);
    const mine = (await run("snapshot", {})).groups[0];
    expect([mine.description, mine.pinnedId]).toEqual(["A's private brief", "pin-a"]);
    // Same profile, another account (no forget: e.g. the session expired).
    await run("hello", { libraryScope: "local:other" });
    const theirs = (await run("snapshot", {})).groups[0];
    expect([theirs.title, theirs.description, theirs.pinnedId]).toEqual(["Research", "", null]);
    // The other account can't unbind A's pin either; A still sees its metadata.
    expect((await run("unbindPinned", { pinnedId: "pin-a" })).groups).toBe(0);
    await run("hello", { libraryScope: "local:lib" });
    expect((await run("snapshot", {})).groups[0].description).toBe("A's private brief");
    // Sign-out of A removes it for good.
    await run("forget", {});
    await run("hello", { libraryScope: "local:lib" });
    expect((await run("snapshot", {})).groups[0].description).toBe("");
  });

  test("claims are budgeted in UTF-8 bytes of the request body", async () => {
    // 8 captures × 160k two-byte characters: ~2.6 MB of JSON, although only 1.28M characters.
    await setup(8, () => "é".repeat(BROWSER_LIMITS.maxCaptureChars));
    await hello();
    const first = await run("claim", { lens, limit: 20 });
    const body = { kind: "lens", requestId: first.requestId, libraryId: "lib", sessionId: "sess", lens, targets: first.targets.map(toEvaluationTarget) };
    expect(first.targets.length).toBeGreaterThan(0);
    expect(first.targets.length).toBeLessThan(8);
    expect(jsonBytes(body)).toBeLessThanOrEqual(BROWSER_LIMITS.maxRequestBytes);
    expect(first.skipped).toBe(8 - first.targets.length);
    expect(first.attempted).toHaveLength(first.targets.length);
    // The rest are missing again and a later claim takes them.
    const second = await run("claim", { lens, limit: 20 });
    expect(new Set([...first.attempted, ...second.attempted]).size).toBe(8);
  });

  test("an explicit re-evaluation only attempts the tabs it was given", async () => {
    await setup(3);
    await hello();
    const all = await run("claim", { lens, limit: 20 });
    await s.cache.deposit(all.requestId, "b", all.targets.map((t: { targetKey: string }) => ({ targetKey: t.targetKey, state: "done", answer: { type: "noul", noul: 1 } })), () => 0);
    const snap = await run("snapshot", {});
    const ids = snap.tabs.map((t: { tabInstanceId: string }) => t.tabInstanceId);
    const again = await run("claim", { lens, limit: 1, force: true, tabInstanceIds: ids.slice(0, 2) });
    expect(again.attempted).toEqual([ids[0]]);
    expect(again.skipped).toBe(1);
    const rest = await run("claim", { lens, limit: 1, force: true, tabInstanceIds: [ids[1]] });
    expect(rest.attempted).toEqual([ids[1]]);
    expect(rest.skipped).toBe(0);
  });

  test("a lost POST is resumed with the same request id and a fresh capture", async () => {
    await setup(2);
    await hello();
    const first = await run("claim", { lens, limit: 20 });
    const resumed = await run("claim", { lens, resumeRequestId: first.requestId });
    expect(resumed.requestId).toBe(first.requestId);
    expect(resumed.targets.map((t: { targetKey: string }) => t.targetKey)).toEqual(first.targets.map((t: { targetKey: string }) => t.targetKey));
  });

  test("capture reuses this revision's capture unless asked to read fresh", async () => {
    await setup(1);
    await hello();
    const ref = { tabId: 1, tabInstanceId: s.registry.get(1)!.tabInstanceId, documentRevision: 0 };
    await run("capture", { tabs: [ref] });
    const after = chromeFake.scripts;
    await run("capture", { tabs: [ref] });
    expect(chromeFake.scripts).toBe(after);
    chromeFake.pages.get(1)!.markdown = "# Changed";
    const fresh = await run("capture", { tabs: [ref], fresh: true });
    expect(chromeFake.scripts).toBeGreaterThan(after);
    expect(fresh.captures[0].capture.markdown).toBe("# Changed");
  });

  test("a tab that navigated is refused instead of pairing one URL with another page", async () => {
    await setup(1);
    await hello();
    const instance = s.registry.get(1)!.tabInstanceId;
    // The page saw revision 0; the tab has moved on.
    await s.registry.observe(1, "https://site.dev/other");
    const stale = await run("capture", { tabs: [{ tabId: 1, tabInstanceId: instance, documentRevision: 0 }] });
    expect(stale.captures[0].error).toBe("The tab navigated to another page.");
    // Navigation while the page is being read: the document read isn't the tab's.
    chromeFake.tabs.get(1)!.url = "https://site.dev/other";
    chromeFake.pages.get(1)!.url = "https://site.dev/third";
    const racing = await run("capture", { tabs: [{ tabId: 1, tabInstanceId: instance }] });
    expect(racing.captures[0].error).toBe("The tab navigated while it was being read.");
  });

  test("Linklog pages and other windows' tabs can't be managed", async () => {
    await setup(1);
    chromeFake.addTab(50, "https://elsewhere.dev/", 2);
    await hello();
    await run("snapshot", {});
    const own = await run("closeTabs", { tabs: [{ tabId: LINKLOG_TAB, tabInstanceId: "x", url: "http://localhost:4321/" }] });
    expect(own.items[0].ok).toBe(false);
    await s.registry.observe(50, "https://elsewhere.dev/");
    const other = await run("closeTabs", { tabs: [{ tabId: 50, tabInstanceId: s.registry.get(50)!.tabInstanceId, url: "https://elsewhere.dev/" }] });
    expect(other.items[0]).toMatchObject({ ok: false, error: "The tab is no longer in this window." });
    expect(chromeFake.tabs.has(50)).toBe(true);
  });

  describe("openTabs", () => {
    const outcomes = (r: { items: { outcome: string }[] }) => r.items.map((i) => i.outcome);
    const created = () => [...chromeFake.tabs.values()].filter((t) => t.id! >= 1000);

    test("opens inactive tabs in the page's window, in order", async () => {
      await setup(1);
      chromeFake.addTab(50, "https://elsewhere.dev/", 2);
      await hello();
      const urls = ["https://a.dev/1", "https://a.dev/2", "http://b.dev/"];
      const result = await run("openTabs", { operationId: "op1", urls });
      expect(result.items).toEqual(urls.map((url) => ({ url, outcome: "opened" })));
      expect(created().map((t) => [t.pendingUrl, t.windowId, t.active])).toEqual(urls.map((u) => [u, 1, false]));
    });

    test("a page already open in the window is reported, not duplicated", async () => {
      await setup(1);
      await hello();
      const result = await run("openTabs", {
        operationId: "op1",
        urls: ["https://site.dev/1#section", "https://other.dev/", "https://other.dev/#again"],
      });
      expect(outcomes(result)).toEqual(["already-open", "opened", "already-open"]);
      expect(created().map((t) => t.pendingUrl)).toEqual(["https://other.dev/"]);
    });

    test("a page open only in another window doesn't count", async () => {
      await setup(0);
      chromeFake.addTab(50, "https://elsewhere.dev/", 2);
      await hello();
      const result = await run("openTabs", { operationId: "op1", urls: ["https://elsewhere.dev/"] });
      expect(outcomes(result)).toEqual(["opened"]);
    });

    test("failures are reported per link and the rest still open", async () => {
      await setup(0);
      chromeFake.createErrors.set("https://broken.dev/", "Tabs cannot be edited right now.");
      await hello();
      const result = await run("openTabs", {
        operationId: "op1",
        urls: ["chrome://settings", "https://broken.dev/", "not a url", "https://fine.dev/"],
      });
      expect(result.items).toEqual([
        { url: "chrome://settings", outcome: "failed", error: "Only web links can be opened." },
        { url: "https://broken.dev/", outcome: "failed", error: "Tabs cannot be edited right now." },
        { url: "not a url", outcome: "failed", error: "Only web links can be opened." },
        { url: "https://fine.dev/", outcome: "opened" },
      ]);
      expect(created().map((t) => t.pendingUrl)).toEqual(["https://fine.dev/"]);
    });

    test("a retry replays what was opened, even after the tabs navigated", async () => {
      await setup(0);
      chromeFake.createErrors.set("https://broken.dev/", "Boom");
      await hello();
      const urls = ["https://a.dev/", "https://broken.dev/", "https://b.dev/"];
      await run("openTabs", { operationId: "op1", urls });
      for (const t of created()) {
        t.url = `${t.pendingUrl}redirected`;
        t.pendingUrl = undefined;
      }
      chromeFake.createErrors.clear();
      const retry = await run("openTabs", { operationId: "op1", urls });
      expect(outcomes(retry)).toEqual(["opened", "opened", "opened"]);
      expect(created().map((t) => t.pendingUrl ?? t.url)).toEqual([
        "https://a.dev/redirected",
        "https://b.dev/redirected",
        "https://broken.dev/",
      ]);
    });

    test("the same operation sent twice at once opens each page once", async () => {
      await setup(0);
      await hello();
      const urls = ["https://a.dev/", "https://b.dev/"];
      const [first, second] = await Promise.all([
        run("openTabs", { operationId: "op1", urls }),
        run("openTabs", { operationId: "op1", urls }),
      ]);
      expect(outcomes(first)).toEqual(["opened", "opened"]);
      expect(outcomes(second)).toEqual(["opened", "opened"]);
      expect(created()).toHaveLength(2);
    });

    test("different operations don't replay each other", async () => {
      await setup(0);
      await hello();
      await run("openTabs", { operationId: "op1", urls: ["https://a.dev/"] });
      const next = await run("openTabs", { operationId: "op2", urls: ["https://a.dev/"] });
      expect(outcomes(next)).toEqual(["already-open"]);
    });

    test("needs the handshake and is advertised", async () => {
      await setup(0);
      expect(run("openTabs", { operationId: "op1", urls: ["https://a.dev/"] })).rejects.toThrow("Connect first.");
      expect(created()).toHaveLength(0);
      const ack = await run("hello", { libraryScope: "local:lib" });
      expect(ack.capabilities).toContain("open");
    });
  });
});
