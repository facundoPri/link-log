import { describe, expect, test } from "bun:test";
import { normalizeUrl, domainOf, pastedUrl, extractUrls } from "../src/url";
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
    expect(extractUrls("https://example.com/a?utm_source=x")).toEqual(["https://example.com/a"]);
    expect(extractUrls("  example.com/path ")).toEqual(["https://example.com/path"]);
  });
  test("takes every http(s) URL in the text, in order, normalized and without repeats", () => {
    expect(
      extractUrls("See HTTP://one.example/a and https://two.example/b?fbclid=1, again http://one.example/a\nhttps://two.example/b"),
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
      expect(extractUrls(text)).toEqual(["https://example.com/"]);
  });
  test("keeps balanced parentheses and meaningful characters inside the URL", () => {
    expect(extractUrls("https://en.wikipedia.org/wiki/Rust_(language).")).toEqual(["https://en.wikipedia.org/wiki/Rust_(language)"]);
    expect(extractUrls("https://example.com/a,b?q=1&r=2#frag")).toEqual(["https://example.com/a,b?q=1&r=2#frag"]);
  });
  test("ignores non-http schemes, credentials, private hosts and prose", () => {
    expect(extractUrls("ftp://example.com/x mailto:a@example.com javascript:alert(1)")).toEqual([]);
    expect(extractUrls("ftp://example.com/x https://ok.example")).toEqual(["https://ok.example/"]);
    expect(extractUrls("https://user:pw@example.com https://localhost/x")).toEqual([]);
    expect(extractUrls("no links here, just example.com in prose")).toEqual([]);
    expect(extractUrls("")).toEqual([]);
  });
});
