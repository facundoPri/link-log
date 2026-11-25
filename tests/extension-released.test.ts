import { describe, expect, test } from "bun:test";
import { releasedCodeProblem } from "../scripts/extension-released";

const head = { "apps/extension": "aaa", "packages/browser-protocol": "ppp" };

describe("releasedCodeProblem", () => {
  test("a version with no release yet is fine: merging publishes it", () => {
    expect(releasedCodeProblem("0.2.1", null, head)).toBeNull();
  });

  test("the commit the release was built from, or one that leaves the extension and protocol alone, passes", () => {
    expect(releasedCodeProblem("0.2.1", { ...head }, head)).toBeNull();
  });

  test("extension code that differs from the release of the same version fails, naming the version", () => {
    expect(releasedCodeProblem("0.2.1", { ...head, "apps/extension": "bbb" }, head)).toContain("0.2.1");
  });

  test("a protocol change alone counts too: the extension bundles it", () => {
    expect(releasedCodeProblem("0.2.1", { ...head, "packages/browser-protocol": "qqq" }, head)).toContain("packages/browser-protocol");
  });
});
