// Fails when the extension version this commit declares already has a release built from other
// extension or protocol code. Two PRs that raise the version to the same number from one base both
// pass the bump check; the second to merge would deploy a web app expecting a ZIP that lacks its
// changes, since the release for that number already exists (FAC-282). Runs on PRs, before the
// production deploy and before publishing. Usage: bun scripts/extension-released.ts
import { $ } from "bun";
import { SHIPPED } from "./extension-version";

type Trees = Record<string, string>;

export function releasedCodeProblem(version: string, released: Trees | null, head: Trees): string | null {
  if (!released) return null;
  const changed = Object.keys(head).filter((dir) => released[dir] !== head[dir]);
  if (!changed.length) return null;
  return (
    `Extension ${version} is already released (tag extension-v${version}), from different code under ${changed.join(" and ")}. ` +
    `Another change probably raised the extension to the same version first. Raise "version" in apps/extension/package.json above ${version}.`
  );
}

async function trees(commit: string): Promise<Trees> {
  const entries = await Promise.all(
    SHIPPED.map((d) => d.replace(/\/$/, "")).map(async (dir) => [dir, (await $`git rev-parse --verify -q ${`${commit}:${dir}`}`.nothrow().quiet().text()).trim()] as const),
  );
  return Object.fromEntries(entries);
}

if (import.meta.main) {
  const version: string = (await Bun.file("apps/extension/package.json").json()).version;
  const tag = `refs/tags/extension-v${version}`;
  // Fails the run when GitHub can't be asked: a guard that can't look must not pass.
  const listed = (await $`git ls-remote --tags origin ${tag}`.text()).trim();
  let released: Trees | null = null;
  if (listed) {
    await $`git fetch --quiet --no-tags --depth=1 origin ${`+${tag}:${tag}`}`;
    released = await trees(`${tag}^{commit}`);
  }
  const problem = releasedCodeProblem(version, released, await trees("HEAD"));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(released ? `Extension ${version}: same code as its release.` : `Extension ${version}: not released yet.`);
}
