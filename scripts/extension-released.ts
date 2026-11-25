// Fails when the extension version this commit declares is already released (tag extension-v<version>) from
// other extension or protocol code (FAC-282). Two PRs that raise the version to the same number from one base
// both pass the bump check against their base; once the first is released, the second can't ship its changes
// under that number. On PRs this catches the second whenever its check runs after the first's release; on
// main, the bump check against the push's previous head catches it even before the tag exists.
// Usage: bun scripts/extension-released.ts
import { $ } from "bun";
import { SHIPPED } from "./extension-version";

type Trees = Record<string, string>;

const PACKAGE = "apps/extension/package.json";
const DIRS = SHIPPED.map((dir) => dir.replace(/\/$/, ""));

export function releasedCodeProblem(version: string, released: Trees | null, head: Trees): string | null {
  if (!released) return null;
  const changed = Object.keys(head).filter((dir) => released[dir] !== head[dir]);
  if (!changed.length) return null;
  return (
    `Extension ${version} is already released (tag extension-v${version}) from different code under ${changed.join(" and ")}. ` +
    `Another change probably raised the extension to the same version first. Raise "version" in ${PACKAGE} above ${version}.`
  );
}

async function trees(commit: string): Promise<Trees> {
  const entries = await Promise.all(DIRS.map(async (dir) => [dir, (await $`git rev-parse --verify -q ${`${commit}:${dir}`}`.nothrow().quiet().text()).trim()] as const));
  return Object.fromEntries(entries);
}

if (import.meta.main) {
  const version: string = (await Bun.file(PACKAGE).json()).version;
  const tag = `refs/tags/extension-v${version}`;
  let released: Trees | null = null;
  // Fails the run when GitHub can't be asked: a guard that can't look must not pass.
  if ((await $`git ls-remote --tags origin ${tag}`.text()).trim()) {
    // CI checkouts are shallow; a full local clone must not become one.
    const shallow = (await $`git rev-parse --is-shallow-repository`.text()).trim() === "true";
    await $`git fetch --quiet --no-tags ${shallow ? ["--depth=1"] : []} origin ${`+${tag}:${tag}`}`;
    released = await trees(`${tag}^{commit}`);
  }
  const problem = releasedCodeProblem(version, released, await trees("HEAD"));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(released ? `Extension ${version}: same code as its release.` : `Extension ${version}: not released yet.`);
}
