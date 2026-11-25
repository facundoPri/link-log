// Fails when a change to the extension (or the protocol package bundled into it) keeps
// apps/extension/package.json at the base version: merging it would deploy a web app that
// expects a version no release carries. Usage: bun scripts/extension-version.ts <base-ref>
import { $ } from "bun";
import { isOlderVersion, parseVersion } from "../src/browser/extensionVersion";

export const SHIPPED = ["apps/extension/", "packages/browser-protocol/"];
const PACKAGE = "apps/extension/package.json";

export function versionBumpProblem(changed: string[], base: string, head: string): string | null {
  if (!parseVersion(head)) return `${PACKAGE} version "${head}" is not x.y.z with parts 0–65535 and no leading zeros; Chrome won't load it.`;
  const shipped = changed.filter((f) => SHIPPED.some((dir) => f.startsWith(dir)));
  if (!shipped.length || isOlderVersion(base, head)) return null;
  return (
    `${shipped.length} file(s) under ${SHIPPED.join(" or ")} changed (${shipped.slice(0, 3).join(", ")}${shipped.length > 3 ? ", …" : ""}), ` +
    `but ${PACKAGE} is ${head}, not above ${base} on the base branch. ` +
    `Raise "version" there (x.y.z): merging to main publishes that version as a release.`
  );
}

if (import.meta.main) {
  const baseRef = process.argv[2];
  if (!baseRef) throw new Error("Usage: bun scripts/extension-version.ts <base-ref>");
  const changed = (await $`git diff --name-only --no-renames -z ${baseRef}...HEAD`.text()).split("\0").filter(Boolean);
  const base = JSON.parse(await $`git show ${baseRef}:${PACKAGE}`.text()).version;
  const head = (await Bun.file(PACKAGE).json()).version;
  const problem = versionBumpProblem(changed, base, head);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Extension version ${head} (base ${base}): ok.`);
}
