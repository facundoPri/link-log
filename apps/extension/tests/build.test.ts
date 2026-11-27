import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { manifest } from "../scripts/build";

const PROD = "https://linklog.facundopri.com";

describe("manifest", () => {
  test("a packaged build bridges only the configured origins", () => {
    const m = manifest([PROD], "0.3.0", [], false);
    expect(m.content_scripts[0]!.matches).toEqual([`${PROD}/*`]);
    expect(m.host_permissions).toEqual([]);
    expect(m.permissions).toEqual(["storage", "scripting", "tabGroups", "tabs"]);
    expect(m.optional_host_permissions).toEqual(["http://*/*", "https://*/*"]);
    expect(JSON.stringify(m)).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  test("a dev build also bridges localhost and 127.0.0.1", () => {
    expect(manifest([PROD], "0.3.0").content_scripts[0]!.matches).toEqual([
      "http://localhost/*",
      "http://127.0.0.1/*",
      `${PROD}/*`,
    ]);
  });

  test("the description is the store's short description", () => {
    const { description } = manifest([PROD], "0.3.0", [], false);
    expect(description).toBe(
      "Review, group and save your open Chrome tabs in Linklog. It reads tab URLs and titles only after you accept.",
    );
    expect(description.length).toBeLessThanOrEqual(132);
  });
});

describe("extension:package", () => {
  const pack = (origins: string | undefined) => {
    const env: Record<string, string | undefined> = { ...process.env, LINKLOG_ORIGINS: origins };
    delete env.LINKLOG_EXTRA_HOSTS;
    delete env.LINKLOG_EXTENSION_OUT;
    if (origins === undefined) delete env.LINKLOG_ORIGINS;
    return Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/build.ts"), "--package"], { env, stderr: "pipe" });
  };

  for (const [name, origins] of [
    ["without LINKLOG_ORIGINS", undefined],
    ["with an http origin", "http://linklog.example"],
    ["with one http origin among https ones", `${PROD},http://linklog.example`],
  ] as const)
    test(`refuses to build ${name}`, () => {
      const run = pack(origins);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain("A packaged build bridges only LINKLOG_ORIGINS, which must be https");
    });
});
