import { describe, expect, test } from "bun:test";
import type { HelloAck, OpenOutcome } from "@linklog/browser-protocol";
import { openLimitReason, openUnavailable, summarizeOpen } from "../src/browser/openLinks";
import type { Connection } from "../src/browser/useBrowser";

const hello = (capabilities: string[]) => ({ capabilities }) as HelloAck;
const reason = (connection: Connection, caps?: string[]) =>
  openUnavailable({ connection, hello: caps ? hello(caps) : null });

describe("openUnavailable", () => {
  test("is usable only when connected to an extension that can open", () => {
    expect(reason("connected", ["tabs", "open"])).toBeNull();
    expect(reason("connected", ["tabs"])).toBe("Update the Linklog extension to open links");
    expect(reason("outdated")).toBe("Update the Linklog extension to open links");
    expect(reason("missing")).toBe("Install or enable the Linklog extension to open links");
    expect(reason("unsupported")).toBe("Opening links needs desktop Chrome with the Linklog extension");
    expect(reason("reload")).toBe("Reload this page to reconnect the extension");
    expect(reason("checking")).toBe("Connecting to the Linklog extension…");
    expect(reason("reconnecting", ["open"])).toBe("Connecting to the Linklog extension…");
  });

  test("more than 50 links at once is refused", () => {
    expect(openLimitReason(50)).toBeNull();
    expect(openLimitReason(51)).toBe("Open up to 50 links at once");
  });
});

describe("summarizeOpen", () => {
  const links = [
    { url: "https://a.dev/", title: "Alpha" },
    { url: "https://b.dev/", title: "" },
    { url: "https://c.dev/", title: "Gamma" },
    { url: "https://d.dev/", title: "Delta" },
    { url: "https://e.dev/", title: "Epsilon" },
  ];
  const ok = (url: string): OpenOutcome => ({ url, outcome: "opened" });
  const open = (url: string): OpenOutcome => ({ url, outcome: "already-open" });
  const bad = (url: string, error = "Nope."): OpenOutcome => ({ url, outcome: "failed", error });

  test("success counts opened links and mentions the ones already open", () => {
    expect(summarizeOpen([ok("a")], links)).toEqual({ kind: "success", message: "Opened 1 link" });
    expect(summarizeOpen([ok("a"), ok("b"), ok("c")], links).message).toBe("Opened 3 links");
    expect(summarizeOpen([ok("a"), open("b")], links).message).toBe("Opened 1 link · 1 already open");
    expect(summarizeOpen([open("a"), open("b")], links).message).toBe("2 links already open");
    expect(summarizeOpen([open("a")], links).message).toBe("1 link already open");
  });

  test("partial failure names the failed links, using the URL when there is no title", () => {
    const summary = summarizeOpen([ok("https://a.dev/"), open("https://c.dev/"), bad("https://b.dev/", "Only web links can be opened.")], links);
    expect(summary).toEqual({
      kind: "error",
      message: "Opened 2 of 3 links",
      description: "https://b.dev/: Only web links can be opened.",
    });
  });

  test("lists three failures and counts the rest", () => {
    const summary = summarizeOpen(links.map((l) => bad(l.url)), links);
    expect(summary.message).toBe("Opened 0 of 5 links");
    expect(summary.description).toBe("Alpha: Nope.; https://b.dev/: Nope.; Gamma: Nope.; +2 more");
  });
});
