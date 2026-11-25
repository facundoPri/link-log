import { describe, expect, test } from "bun:test";
import { EXPECTED_EXTENSION_VERSION, extensionUpdate, isOlderVersion } from "../src/browser/extensionVersion";
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
    for (const v of ["", "dev", "0.0", "1.x.0", undefined, null, 3] as unknown[]) expect(isOlderVersion(v, "0.2.0")).toBe(false);
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
