# Isolated label-triggered PR previews — 2026-10-09

Implemented locally, not deployed. No Cloudflare resources or GitHub settings were changed and no commit was created. Hosted signup, delivery, cookies, extraction, lifecycle, and cleanup remain unverified.

## Why this uses a separate Worker

Installed Wrangler **4.136.1** supports `wrangler preview`, `preview delete`, `--worker-name`, `--ignore-base-config`, and `--secrets-file`. Official Previews require >=4.135.0 and do not require a prior production deploy. [Get started](https://developers.cloudflare.com/workers/previews/get-started/).

Native Previews currently cannot consume Queue messages or receive Cron invocations, and Workflow bindings call an existing deployed Workflow. D1, R2 and Queue bindings use the named account resource, rather than automatically creating per-Preview storage. Automatic isolation is for Durable Objects and Containers. Consequently, native Previews cannot run Linklog's complete extraction path without a second separately deployed Worker anyway. The smallest working alternative is one ordinary Worker plus D1, R2, Queue and Workflow per PR. Migration commands must target the same D1 used by the preview before deploying. [Resources and limitations](https://developers.cloudflare.com/workers/previews/resources/).

This deliberately does not add a decorative native Preview on top of that stack. No production `wrangler.jsonc` is read by the deployment controller.

## Implemented lifecycle

- `.github/workflows/pr-preview.yml` handles `pr-preview` labeled/unlabeled, synchronize, reopen and close. Per-repository/PR concurrency serializes runs with cancellation disabled. Each run reads current GitHub state, so queued event order does not decide whether to deploy or clean up.
- Only same-repository PRs whose author currently has write/maintain/admin permission may deploy. Forks are skipped. All actions are pinned to commit SHAs resolved from their official repositories on this date.
- `plan` reads the PR. `build` checks out its immutable head SHA, installs the frozen lockfile without install scripts, builds assets, and bundles the Worker without any Cloudflare/auth secrets or write token. There is no shared build cache.
- `reconcile` runs trusted base-branch scripts on a separate runner. It downloads only this run/attempt's artifact and never executes PR code, PR package installation, or PR Wrangler config with cloud credentials. Its generated config uses a prebundled Worker (`--no-bundle`), copied SQL and static files. Unexpected root entries, symlinks, extra Worker modules and non-SQL migration entries fail closed.
- Names are exclusively `llpr-<numeric repository ID>-<numeric PR number>` plus `-db`, `-content`, `-jobs`, `-process`. Reserve this namespace for this automation. No names, IDs, configuration hooks, routes or commands come from branch names or artifact manifests. Exact API result names are checked; a foreign Queue consumer blocks mutation. Discovery supports multiple account pages and partial previous creations.
- D1 migrations run **before the new Worker deployment**; a failure prevents publication. Existing deployments can still be serving while forward migrations run, so migrations on a reused PR database must remain compatible with the preceding version. No claim of transactionally draining old traffic is made.
- `APP_ENV=preview`; Better Auth gets the exact `https://llpr-<repo ID>-<PR>.<subdomain>.workers.dev` origin. Version preview URLs are disabled. A preview-only seed derives a stable, distinct per-PR secret using HMAC-SHA256; it is uploaded atomically with the deployment through a temporary mode-0600 file removed in `finally`. Keep the seed stable across pushes.
- Real AI, Browser, Email, Queue producer+consumer, Workflow and recovery Cron bindings are included. No fixture provider or development auth is configured. AI/Browser/Email use the selected account's services and quotas; the persistent application resources are distinct per PR.
- Current state is re-read before and after deployment. A new head discovered afterward disables the stale public endpoint, preserving D1/R2/accounts for the next serialized deploy. Closed/unlabeled triggers full cleanup. GitHub and Cloudflare cannot atomically commit together: a state change during the upload can expose that deployment briefly until the post-check disables it. An API outage or manual job cancellation requires rerunning reconciliation.
- Cleanup detaches the Queue consumer, deletes the Workflow/instances and Worker, deletes the Queue, empties R2 before deleting its bucket, then deletes D1. Missing resources (HTTP 404) are tolerated; permission/network/server failures remain failures. Rerun the job to continue partial cleanup. No wildcard deletes or deletion of `linklog` occur. Closing/removing the label intentionally destroys preview accounts and content; reopening creates a fresh stack.

R2 draining uses the official account REST [List Objects](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/) and [Delete Object](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/delete/) APIs, then [Delete Bucket](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/delete/). Object keys are encoded as one path parameter; dot-only keys fail with a manual-cleanup instruction. Repeated first-page reads avoid skipping objects as deletion changes the set. The [script subdomain API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/) disables stale HTTP access.

## First PR bootstrap — label alone cannot work yet

There are currently no workflows on the default/base branch. `pull_request_target` executes its trusted base workflow and code, not the unmerged PR implementation. Merely adding `pr-preview` to PR #5 therefore does **not** activate these newly added files. [GitHub event semantics and security warning](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

Land a small, separately reviewed infrastructure bootstrap change on the PR's base branch containing `.github/workflows/pr-preview.yml`, `scripts/preview/`, and preferably `tests/preview.test.ts` plus this report. This does not require merging PR #5's auth/application code. Then configure the environment below, make sure PR #5's intended app head is pushed, and add/re-add `pr-preview`. The workflow builds that PR's head using the trusted bootstrap scripts. Until this bootstrap is landed, use local demo/QA evidence; no hosted URL exists from this work.

## Exact remaining setup

Create GitHub environment **`pr-preview`**, with these secrets/variables (repository-level values also resolve). Environment review protection is optional and must allow the trusted base branch. Configure values without printing them in logs.

| Kind | Name | Required value |
| --- | --- | --- |
| Secret | `CLOUDFLARE_PREVIEW_API_TOKEN` | Account-scoped API token permitting Workers Scripts, D1, R2 bucket+object management, Queues, Workflows, Workers AI, Browser Rendering/Run, and Email Sending operations used here |
| Secret | `PREVIEW_AUTH_SEED` | New random preview-only secret, at least 32 characters; do not use production auth secret |
| Variable | `CLOUDFLARE_PREVIEW_ACCOUNT_ID` | Exact 32-hex account ID for the preview resources |
| Variable | `PREVIEW_WORKERS_SUBDOMAIN` | Registered workers.dev account subdomain, just the label; controller verifies it through the account API |
| Variable | `PREVIEW_EMAIL_FROM` | Bare verified sender address, e.g. `auth@your-verified-domain`; no display name |

A dedicated preview account is recommended to restrict token blast radius, but not required if this reserved namespace and account-scoped permissions are suitable. The code does not copy any production resource bindings. Confirm Workers/Queues/Workflows, R2, AI and Browser availability/billing for the selected account. Keep account/API credentials out of the build job.

Set up Cloudflare **Email Service** outbound sending and a verified sending domain/sender, including its required DNS records and any applicable recipient restrictions; a local mail sink or Email Routing configuration alone does not establish real transactional sending. [Email Service getting started](https://developers.cloudflare.com/email-service/get-started/). The existing application uses the Email Service structured `EMAIL.send` payload. The coordinator's current inventory reports no GitHub secrets/variables and an existing local OAuth session missing `queues/write` and `email_sending/write`; that session is not adequate CI setup. The sender decision is still pending.

Do not treat a deployed URL as full hosted acceptance. After authorized setup/deploy, verify fresh signup and delivered confirmation email, link origin and HTTPS secure session cookie, password login/logout, reset and magic link delivery, persistence across a synchronize, and real URL extraction through Queue → Workflow → Browser/AI → D1/R2. Verify cross-user isolation, then remove the label and confirm the exact preview resources disappear. Reopen/relabel once to verify recovery. R2 object deletion and resource API error shapes have documentation/mock evidence only until this run.

## Local evidence and repeatable checks

```sh
bun test tests/preview.test.ts
bun scripts/preview/dry-run.ts
bunx tsc --noEmit
```

- 14 focused tests / 82 assertions pass: fork and label decisions, injection rejection, secret stability, exact resource selection, partial provisioning, paginated discovery (including server-selected short pages), foreign-consumer refusal, multi-page R2 cleanup, error propagation, stale URL suppression preserving data, and workflow trust boundaries.
- Root TypeScript check passes. No package.json/runtime/auth/demo changes are part of this implementation.
- `dry-run.ts` passed with Wrangler 4.136.1: first bundles the actual Worker, then validates the same single-JS artifact with `--no-bundle`. Both report all required bindings and a 2234.73 KiB bundle / 417.08 KiB gzip. A synthetic static asset avoids touching the running demo's `dist`.
- All 14 migrations (0001–0014) successfully applied to disposable **local** D1. Evidence directory from this run: `/var/folders/h_/dr0vb70d1sdbk3wnx6kt2rxr0000gn/T/linklog-preview-offline-dGZ3UD`. This is not remote migration evidence.
- Verified installed command help: `preview`, `preview delete`, `deploy --dry-run --no-bundle --secrets-file`, `d1 migrations apply DB --remote --config`, `workflows delete`, `delete`, and `r2 bucket delete`. D1 apply has no `--yes` flag; it confirms automatically in CI/non-interactive mode. Native `preview` has no dry-run flag, so the offline check deliberately uses `deploy --dry-run`.
- No live provision, deployment, remote migration, cleanup, production access, secret listing values, GitHub mutation, push or commit was performed. Full GitHub Actions runner execution and hosted smoke tests remain outstanding.
