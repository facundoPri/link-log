// One sticky PR comment per preview, rewritten at each stage. Runs only trusted base code.
import { github, required } from "./github";
import { names } from "./model";

export const MARKER = "<!-- linklog-pr-preview -->";
const BOT = "github-actions[bot]";

export type Stage =
  | { stage: "building"; sha: string }
  | { stage: "ready"; sha: string; url: string; email: string; password: string }
  | { stage: "failed"; sha: string }
  | { stage: "removed" };

// `:account` lets the dashboard pick the signed-in account, so the account ID stays out of the PR.
export function dashboard(worker: string) {
  const base = `https://dash.cloudflare.com/?to=/:account/workers/services/view/${worker}/production`;
  return { deployments: `${base}/deployments`, observability: `${base}/observability/logs` };
}

export function body(repositoryId: string, pr: string, run: string, s: Stage) {
  const { worker } = names(repositoryId, pr);
  const cf = dashboard(worker);
  const links = `[Worker deployments](${cf.deployments}) · [Observability logs](${cf.observability}) · [Workflow run](${run})`;
  const commit = "sha" in s ? `\n\nCommit: \`${s.sha.slice(0, 7)}\`` : "";
  switch (s.stage) {
    case "building":
      return `${MARKER}\n### ⏳ PR preview deploying\n\nBuilding and deploying \`${worker}\`. This comment updates when it is ready.\n\n${links}${commit}\n\n<sub>On the first deploy the Cloudflare pages appear once the Worker is uploaded.</sub>`;
    case "ready":
      return `${MARKER}\n### ✅ PR preview ready\n\n**Preview:** ${s.url}\n\n| Test account | |\n| --- | --- |\n| Email | \`${s.email}\` |\n| Password | \`${s.password}\` |\n\n${links}${commit}`;
    case "failed":
      return `${MARKER}\n### ❌ PR preview failed\n\nSee the workflow run for the error; rerun it or push again to retry.\n\n${links}${commit}`;
    case "removed":
      return `${MARKER}\n### PR preview removed\n\nThe \`pr-preview\` label is gone or the PR is closed, so \`${worker}\` and its data were deleted.`;
  }
}

export async function publish(s: Stage) {
  const pr = required("PR_NUMBER");
  const run = `${required("GITHUB_SERVER_URL")}/${required("GITHUB_REPOSITORY")}/actions/runs/${required("GITHUB_RUN_ID")}`;
  const text = body(required("GITHUB_REPOSITORY_ID"), pr, run, s);
  let existing: { id: number } | undefined;
  for (let page = 1; !existing; page++) {
    const comments = await github(`issues/${pr}/comments?per_page=100&page=${page}`) as { id: number; body?: string; user?: { login: string } }[];
    existing = comments.find(c => c.user?.login === BOT && c.body?.startsWith(MARKER));
    if (comments.length < 100) break;
  }
  // A removal never opens a comment on a PR that had no preview.
  if (existing) await github(`issues/comments/${existing.id}`, "PATCH", { body: text });
  else if (s.stage !== "removed") await github(`issues/${pr}/comments`, "POST", { body: text });
}

if (import.meta.main) {
  const stage = process.argv[2];
  if (stage !== "building" && stage !== "failed") throw new Error("Usage: comment.ts building|failed");
  await publish({ stage, sha: required("PREVIEW_SHA") });
}
