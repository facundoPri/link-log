// Rejects files that belong to the owner's machine, not the repo: `local/`, `fixtures/private/`,
// and the folders .gitignore already marks as local output. The pre-commit hook runs it on the
// staged files (`--staged`); CI runs it on the PR diff (`<base-ref>`), because a local hook can be skipped.
import { $ } from "bun";

export const PRIVATE_PATHS = [/^local\//, /(^|\/)fixtures\/private\//, /^\.profiles\//, /^qa\/out\//, /(^|\/)\.dev\.vars(\.(?!example$)[^/]+)?$/, /(^|\/)\.env(\.(?!example$)[^/]+)?$/];

export function privatePaths(files: string[]): string[] {
  return files.filter((file) => PRIVATE_PATHS.some((pattern) => pattern.test(file)));
}

if (import.meta.main) {
  const arg = process.argv[2];
  if (!arg) throw new Error("Usage: bun scripts/check-private-paths.ts --staged | <base-ref>");
  const diff = arg === "--staged" ? $`git diff --cached --name-only --no-renames --diff-filter=AMR -z` : $`git diff --name-only --no-renames --diff-filter=AMR -z ${arg}...HEAD`;
  const bad = privatePaths((await diff.text()).split("\0").filter(Boolean));
  if (bad.length) {
    console.error(`Private paths must stay out of git (${bad.join(", ")}). Unstage them: git restore --staged <path>.`);
    process.exit(1);
  }
  console.log("No private paths in the change: ok.");
}
