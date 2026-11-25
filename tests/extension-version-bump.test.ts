import { describe, expect, test } from "bun:test";
import { versionBumpProblem } from "../scripts/extension-version";

describe("versionBumpProblem", () => {
  test("a PR that leaves the extension and protocol alone needs no bump", () => {
    expect(versionBumpProblem(["src/App.tsx", "docs/x.md"], "0.2.0", "0.2.0")).toBeNull();
  });

  test("a change to the extension or the protocol it bundles must raise the version", () => {
    for (const file of ["apps/extension/src/bridge/index.ts", "packages/browser-protocol/src/browser.ts"])
      expect(versionBumpProblem([file], "0.2.0", "0.2.0")).toContain("0.2.0");
    expect(versionBumpProblem(["apps/extension/src/x.ts"], "0.2.0", "0.1.9")).toContain("0.1.9");
  });

  test("a raised version passes", () => {
    expect(versionBumpProblem(["apps/extension/src/x.ts"], "0.2.0", "0.2.1")).toBeNull();
    expect(versionBumpProblem(["packages/browser-protocol/src/x.ts"], "0.1.1", "0.2.0")).toBeNull();
  });

  test("a version Chrome can't load fails, even without extension changes", () => {
    for (const head of ["0.3", "0.02.0", "0.2.65536"]) expect(versionBumpProblem(["apps/extension/package.json"], "0.2.0", head)).toContain("Chrome");
    expect(versionBumpProblem(["src/App.tsx"], "0.2.0", "0.02.0")).toContain("Chrome");
  });
});
