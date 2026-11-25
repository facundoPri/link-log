import { describe, expect, test } from "bun:test";
import { EXPECTED_EXTENSION_VERSION, extensionDownloadUrl, extensionUpdate, isOlderVersion, LATEST_EXTENSION_URL } from "../src/browser/extensionVersion";
import extensionPackage from "../apps/extension/package.json" with { type: "json" };

describe("isOlderVersion", () => {
  test("compares numeric parts, not strings", () => {
    expect(isOlderVersion("0.1.9", "0.1.10")).toBe(true);
    expect(isOlderVersion("0.1.10", "0.1.9")).toBe(false);
    expect(isOlderVersion("0.1.1", "0.2.0")).toBe(true);
    expect(isOlderVersion("1.0.0", "0.9.9")).toBe(false);
    expect(isOlderVersion("0.2.0", "0.2.0")).toBe(false);
  });

  test("an unreadable installed version is never reported as older", () => {
    for (const v of ["", "dev", "0.0", "1.x.0", "0.01.1", "0.1.65536", undefined, null, 3] as unknown[]) expect(isOlderVersion(v, "0.2.0")).toBe(false);
  });
});

describe("extensionUpdate", () => {
  test("names the installed and expected versions when the extension is behind", () => {
    expect(extensionUpdate("0.1.1", "0.2.0")).toEqual({ installed: "0.1.1", expected: "0.2.0" });
  });

  test("is null when current, newer or unknown", () => {
    expect(extensionUpdate("0.2.0", "0.2.0")).toBeNull();
    expect(extensionUpdate("0.3.0", "0.2.0")).toBeNull();
    expect(extensionUpdate(null, "0.2.0")).toBeNull();
  });

  test("expects the version the extension package declares", () => {
    expect(EXPECTED_EXTENSION_VERSION).toBe(extensionPackage.version);
  });
});

describe("extensionDownloadUrl", () => {
  const answer = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

  test("links the expected version's release when it exists", async () => {
    const asked: string[] = [];
    const fetchRelease = (async (url: string) => (asked.push(url), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
    expect(await extensionDownloadUrl("0.3.0", fetchRelease)).toBe("https://github.com/facundoPri/link-log/releases/tag/extension-v0.3.0");
    expect(asked).toEqual(["https://api.github.com/repos/facundoPri/link-log/releases/tags/extension-v0.3.0"]);
  });

  test("falls back to the latest release only when GitHub has no release for that version", async () => {
    expect(await extensionDownloadUrl("0.3.0", answer(404))).toBe(LATEST_EXTENSION_URL);
  });

  test("keeps the expected version's release when GitHub can't say (rate limit, outage, offline)", async () => {
    const tag = "https://github.com/facundoPri/link-log/releases/tag/extension-v0.3.0";
    for (const status of [403, 429, 500]) expect(await extensionDownloadUrl("0.3.0", answer(status))).toBe(tag);
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await extensionDownloadUrl("0.3.0", offline)).toBe(tag);
  });
});
