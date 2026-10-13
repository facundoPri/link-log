import { appendFile } from "node:fs/promises";
import { desired, type PullRequest } from "./model";

export function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
export async function github(path: string) {
  const repository = required("GITHUB_REPOSITORY");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository");
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${required("GH_TOKEN")}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub read failed (${response.status})`);
  return response.json();
}
export async function current() {
  const number = required("PR_NUMBER");
  if (!/^[1-9][0-9]{0,14}$/.test(number)) throw new Error("Invalid PR number");
  const pr = await github(`pulls/${number}`) as PullRequest;
  if (String(pr.number) !== number) throw new Error("Wrong PR response");
  const action = desired(pr, required("GITHUB_REPOSITORY_ID"));
  if (action === "deploy") {
    const permission = await github(`collaborators/${encodeURIComponent(pr.user.login)}/permission`) as { permission: string };
    if (!["admin", "maintain", "write"].includes(permission.permission)) {
      throw new Error("Preview author must currently have repository write permission");
    }
  }
  return { action, sha: pr.head.sha };
}
if (import.meta.main) {
  const result = await current();
  await appendFile(required("GITHUB_OUTPUT"), `action=${result.action}\nsha=${result.action === "deploy" ? result.sha : ""}\n`);
}
