import { describe, expect, test } from "bun:test";
import { normalizeUrl, domainOf, pastedUrl } from "../src/url";
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
