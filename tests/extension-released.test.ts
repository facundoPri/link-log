import { describe, expect, test } from "bun:test";
import { releasedCodeProblem } from "../scripts/extension-released";

const head = { "apps/extension": "aaa", "packages/browser-protocol": "ppp" };
const tag = (trees: Record<string, string>) => ({ label: "tag extension-v0.2.1", trees });
const firstOnMain = (trees: Record<string, string>) => ({ label: "abc1234, the first commit on main declaring 0.2.1", trees });

describe("releasedCodeProblem", () => {
  test("a version nothing released or declared before is fine: merging publishes it", () => {
    expect(releasedCodeProblem("0.2.1", [], head)).toBeNull();
  });

  test("the code the release was or will be built from passes", () => {
    expect(releasedCodeProblem("0.2.1", [tag({ ...head }), firstOnMain({ ...head })], head)).toBeNull();
  });

  test("extension code that differs from the release of the same version fails, naming the version", () => {
    expect(releasedCodeProblem("0.2.1", [tag({ ...head, "apps/extension": "bbb" })], head)).toContain("0.2.1");
  });

  test("a protocol change alone counts too: the extension bundles it", () => {
    expect(releasedCodeProblem("0.2.1", [tag({ ...head, "packages/browser-protocol": "qqq" })], head)).toContain("packages/browser-protocol");
  });

  test("before the first commit's release exists, its code is what will be released, so a second PR on that version fails", () => {
    const problem = releasedCodeProblem("0.2.1", [firstOnMain({ ...head, "apps/extension": "bbb" })], head);
    expect(problem).toContain("abc1234");
  });

  test("any differing source fails, not only the first one listed", () => {
    expect(releasedCodeProblem("0.2.1", [tag({ ...head }), firstOnMain({ ...head, "apps/extension": "bbb" })], head)).toContain("abc1234");
  });
});
