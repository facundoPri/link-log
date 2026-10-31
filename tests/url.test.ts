import { describe, expect, test } from "bun:test";
import { normalizeUrl, domainOf, pastedUrl, scanUrls } from "../src/url";
import { publicAddress } from "../worker/metadata";
describe("link capture", () => {
  test("normalizes scheme and trackers while preserving meaningful parameters and fragments", () => {
    expect(
      normalizeUrl("example.com/watch?v=abc&utm_source=news#chapter"),
    ).toBe("https://example.com/watch?v=abc#chapter");
  });
  test("groups YouTube aliases without grouping lookalikes", () => {
    for (const url of [
      "https://youtu.be/abc",
      "https://www.youtube.com/watch?v=abc",
      "https://m.youtube.com/shorts/abc",
    ])
      expect(domainOf(url)).toBe("youtube.com");
    expect(domainOf("https://youtube.com.example.com")).toBe(
      "youtube.com.example.com",
    );
  });
  test("rejects non-web schemes, credentials and ordinary pasted prose", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:password@example.com",
      "hello world",
    ])
      expect(() => normalizeUrl(url)).toThrow();
    expect(pastedUrl("hello https://example.com")).toBeNull();
    expect(pastedUrl("https://example.com")).toBe("https://example.com/");
  });
  test("rejects private, loopback, mapped and reserved destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "169.254.169.254",
      "192.168.1.1",
      "172.16.0.1",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
    ])
      expect(publicAddress(ip)).toBe(false);
    expect(publicAddress("1.1.1.1")).toBe(true);
    expect(publicAddress("2606:4700:4700::1111")).toBe(true);
  });
});

test("bulk paste accepts the app's Copy with titles output and formatted lists", async () => {
  const { pastedUrls } = await import("../src/url");
  const expected = ["https://example.com/a", "https://example.com/b"];
  for (const clipboard of [
    "https://example.com/a — Article A\nhttps://example.com/b — Article B",
    "• https://example.com/a\n• https://example.com/b",
    "1. https://example.com/a\r\n2. https://example.com/b",
    "[Article A](https://example.com/a)\n[Article B](https://example.com/b)",
    "https://example.com/a\r\n\r\nhttps://example.com/b",
  ]) expect(pastedUrls(clipboard)).toEqual(expected);
});

describe("extracting URLs from text", () => {
  test("a bare URL, with or without a scheme, is the whole input", () => {
    expect(scanUrls("https://example.com/a?utm_source=x").urls).toEqual(["https://example.com/a"]);
    expect(scanUrls("  example.com/path ").urls).toEqual(["https://example.com/path"]);
  });
  test("takes every http(s) URL in the text, in order, normalized and without repeats", () => {
    expect(
      scanUrls("See HTTP://one.example/a and https://two.example/b?fbclid=1, again http://one.example/a\nhttps://two.example/b").urls,
    ).toEqual(["http://one.example/a", "https://two.example/b"]);
  });
  test("leaves out surrounding text, trailing punctuation, markdown and angle brackets", () => {
    for (const text of [
      "Example page: [https://example.com](<https://example.com>)",
      "[Example](https://example.com/)",
      "<https://example.com>",
      "(see https://example.com).",
      'He said "https://example.com!"',
      "https://example.com/, https://example.com;",
    ])
      expect(scanUrls(text).urls).toEqual(["https://example.com/"]);
  });
  test("keeps balanced parentheses and meaningful characters inside the URL", () => {
    expect(scanUrls("https://en.wikipedia.org/wiki/Rust_(language).").urls).toEqual(["https://en.wikipedia.org/wiki/Rust_(language)"]);
    expect(scanUrls("https://example.com/a,b?q=1&r=2#frag").urls).toEqual(["https://example.com/a,b?q=1&r=2#frag"]);
  });
  test("ignores non-http schemes, credentials, private hosts and prose", () => {
    expect(scanUrls("ftp://example.com/x mailto:a@example.com javascript:alert(1)").urls).toEqual([]);
    expect(scanUrls("ftp://example.com/x https://ok.example").urls).toEqual(["https://ok.example/"]);
    expect(scanUrls("https://user:pw@example.com https://localhost/x").urls).toEqual([]);
    expect(scanUrls("no links here, just example.com in prose").urls).toEqual([]);
    expect(scanUrls("").urls).toEqual([]);
  });
});

describe("scanning cost", () => {
  // A 1 MB tail of closing parentheses or punctuation used to cost seconds (quadratic trim loop).
  test("a very long run of trailing characters is scanned in linear time", () => {
    for (const tail of [")", ".", "(", ")."]) {
      const started = performance.now();
      const { urls } = scanUrls(`http://a.co/x${tail.repeat(500_000)}`);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(urls.length).toBeLessThanOrEqual(1);
    }
    expect(scanUrls(`http://a.co/x(${")".repeat(1000)}`).urls).toEqual(["http://a.co/x()"]);
  });
});

describe("why a text yielded no URL", () => {
  test("a URL-looking candidate that breaks a URL rule reports that rule's reason", () => {
    expect(scanUrls("https://user:pw@example.com")).toEqual({ urls: [], reason: "Use a public http or https link." });
    expect(scanUrls("visit https://localhost/x today")).toEqual({ urls: [], reason: "Use a public http or https link." });
    expect(scanUrls(`https://example.com/${"a".repeat(4100)}`)).toEqual({ urls: [], reason: "Paste a valid URL." });
  });
  test("with no candidate there is no reason, and valid URLs next to a refused one are still found", () => {
    for (const text of ["", "no links here", "ftp://example.com/x mailto:a@example.com", "localhost"]) expect(scanUrls(text)).toEqual({ urls: [] });
    expect(scanUrls("https://localhost/x https://ok.example")).toEqual({ urls: ["https://ok.example/"], reason: "Use a public http or https link." });
    expect(scanUrls("https://ok.example")).toEqual({ urls: ["https://ok.example/"] });
  });
});
