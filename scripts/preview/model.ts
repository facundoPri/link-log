import { createHmac, randomBytes, scryptSync } from "node:crypto";

export const WRANGLER_VERSION = "4.136.1";
export function names(repositoryId: string, pr: string) {
  for (const value of [repositoryId, pr]) {
    if (!/^[1-9][0-9]{0,14}$/.test(value)) throw new Error("Invalid numeric repository/PR identity");
  }
  const worker = `llpr-${repositoryId}-${pr}`;
  return { worker, db: `${worker}-db`, bucket: `${worker}-content`, queue: `${worker}-jobs`, workflow: `${worker}-process` };
}
export type PullRequest = {
  number: number; state: string; head: { sha: string; repo: { id: number } | null };
  base: { repo: { id: number } }; labels: { name: string }[]; user: { login: string };
};
export function desired(pr: PullRequest, repositoryId: string): "deploy" | "cleanup" | "skip" {
  names(repositoryId, String(pr.number));
  if (String(pr.base.repo.id) !== repositoryId) throw new Error("Wrong base repository");
  // Never execute or deploy code from forks, even when someone adds the label.
  if (pr.head.repo && String(pr.head.repo.id) !== repositoryId) return "skip";
  if (pr.state !== "open" || !pr.labels.some(l => l.name === "pr-preview")) return "cleanup";
  if (!pr.head.repo) return "skip";
  if (!/^[a-f0-9]{40}$/.test(pr.head.sha)) throw new Error("Invalid head SHA");
  return "deploy";
}
export function authSecret(seed: string, repositoryId: string, pr: string) {
  const { worker } = names(repositoryId, pr);
  if (seed.length < 32) throw new Error("PREVIEW_AUTH_SEED must contain at least 32 random characters");
  return createHmac("sha256", seed).update(`linklog-preview-v1:${worker}`).digest("hex");
}
// A verified email+password account seeded into each preview, published in the PR comment.
// Derived from the seed so it stays stable across pushes and differs per PR and from authSecret.
export function testAccount(seed: string, repositoryId: string, pr: string) {
  const { worker } = names(repositoryId, pr);
  if (seed.length < 32) throw new Error("PREVIEW_AUTH_SEED must contain at least 32 random characters");
  const password = createHmac("sha256", seed).update(`linklog-preview-tester-v1:${worker}`).digest("base64url").slice(0, 24);
  return { email: "preview-tester@example.com", password };
}
// Better Auth's scrypt format (@better-auth/utils/password): hex salt, colon, hex key.
export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const key = scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 });
  return `${salt}:${key.toString("hex")}`;
}
export function seedSql(email: string, passwordHash: string, now = new Date().toISOString()) {
  if (!/^[^\s'"<>@]+@[^\s'"<>@]+\.[a-z]+$/.test(email) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) {
    throw new Error("Invalid test account");
  }
  const id = "preview-tester";
  // Idempotent: keep the user (and its content) across deploys, reset only its password.
  return `INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('${id}','Preview tester','${email}',1,'${now}','${now}') ON CONFLICT(email) DO UPDATE SET "emailVerified"=1;
DELETE FROM account WHERE "providerId"='credential' AND "userId"=(SELECT id FROM "user" WHERE email='${email}');
INSERT INTO account(id,"accountId","providerId","userId",password,"createdAt","updatedAt") SELECT 'preview-tester-credential',id,'credential',id,'${passwordHash}','${now}','${now}' FROM "user" WHERE email='${email}';
`;
}
export function config(repositoryId: string, pr: string, databaseId: string, subdomain: string, sender: string) {
  const n = names(repositoryId, pr);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) throw new Error("Invalid workers.dev subdomain");
  if (!/^[a-f0-9-]{36}$/.test(databaseId)) throw new Error("Invalid D1 ID");
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender)) throw new Error("PREVIEW_EMAIL_FROM must be a bare verified email address");
  return {
    name: n.worker, main: "./worker/index.js", no_bundle: true,
    compatibility_date: "2026-09-21", compatibility_flags: ["nodejs_compat"],
    workers_dev: true, preview_urls: false,
    assets: { directory: "./dist", binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: ["/api/*"] },
    d1_databases: [{ binding: "DB", database_name: n.db, database_id: databaseId, migrations_dir: "./migrations" }],
    r2_buckets: [{ binding: "CONTENT", bucket_name: n.bucket }],
    queues: {
      producers: [{ binding: "JOBS", queue: n.queue }],
      consumers: [{ queue: n.queue, max_batch_size: 10, max_batch_timeout: 1, max_retries: 3, max_concurrency: 10 }],
    },
    workflows: [{ binding: "PROCESS_LINK", name: n.workflow, class_name: "LinkWorkflow" }],
    triggers: { crons: ["*/5 * * * *"] },
    ai: { binding: "AI" }, browser: { binding: "BROWSER" }, send_email: [{ name: "EMAIL" }],
    vars: { APP_ENV: "preview", BETTER_AUTH_URL: `https://${n.worker}.${subdomain}.workers.dev`, EMAIL_FROM: sender, JEV_PROVIDER: "cloudflare" },
    observability: { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false } },
  };
}
