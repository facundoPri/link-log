// Fails when the extension version this commit declares was, or will be, released from other
// extension or protocol code. Two PRs that raise the version to the same number from one base both
// pass the bump check; the second to merge would deploy a web app expecting a ZIP that lacks its
// changes, since the release for that number comes from the first (FAC-282). Runs on PRs, before
// the production deploy and before publishing. Usage: bun scripts/extension-released.ts
import { $ } from "bun";
import { SHIPPED } from "./extension-version";

type Trees = Record<string, string>;
type Source = { label: string; trees: Trees };

const PACKAGE = "apps/extension/package.json";
const DIRS = SHIPPED.map((dir) => dir.replace(/\/$/, ""));

export function releasedCodeProblem(version: string, sources: Source[], head: Trees): string | null {
  for (const source of sources) {
    const changed = Object.keys(head).filter((dir) => source.trees[dir] !== head[dir]);
    if (changed.length)
      return (
        `Extension ${version} is (or will be) released from ${source.label}, which has different code under ${changed.join(" and ")}. ` +
        `Another change probably raised the extension to the same version first. Raise "version" in ${PACKAGE} above ${version}.`
      );
  }
  return null;
}

async function trees(commit: string): Promise<Trees> {
  const entries = await Promise.all(DIRS.map(async (dir) => [dir, (await $`git rev-parse --verify -q ${`${commit}:${dir}`}`.nothrow().quiet().text()).trim()] as const));
  return Object.fromEntries(entries);
}

/** The release workflow runs in push order and publishes a version once, from the first push that declares it. */
async function firstDeclaring(version: string): Promise<string | null> {
  const commits = (await $`git log --first-parent --reverse --format=%H HEAD -- ${PACKAGE}`.text()).split("\n").filter(Boolean);
  for (const sha of commits) {
    const declared = await $`git show ${`${sha}:${PACKAGE}`}`.nothrow().quiet().text();
    if (declared && JSON.parse(declared).version === version) return sha;
  }
  return null;
}

if (import.meta.main) {
  if ((await $`git rev-parse --is-shallow-repository`.text()).trim() === "true")
    throw new Error("extension-released.ts needs the full history (actions/checkout with fetch-depth: 0).");
  const version: string = (await Bun.file(PACKAGE).json()).version;
  const sources: Source[] = [];
  const tag = `refs/tags/extension-v${version}`;
  // Fails the run when GitHub can't be asked: a guard that can't look must not pass.
  if ((await $`git ls-remote --tags origin ${tag}`.text()).trim()) {
    await $`git fetch --quiet --no-tags origin ${`+${tag}:${tag}`}`;
    sources.push({ label: `tag extension-v${version}`, trees: await trees(`${tag}^{commit}`) });
  }
  const first = await firstDeclaring(version);
  if (first) sources.push({ label: `${first.slice(0, 7)}, the first commit on this branch declaring ${version}`, trees: await trees(first) });
  const problem = releasedCodeProblem(version, sources, await trees("HEAD"));
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(`Extension ${version}: same code as ${sources.map((s) => s.label).join(" and ") || "nothing released yet"}.`);
}
