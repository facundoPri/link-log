---
name: triage-production
description: Investigate a bug, failure or slowdown in Linklog production (linklog.facundopri.com) from Cloudflare evidence (D1, Workflows, Workers Logs, tail), read-only, and explain how and why it happens with a suggested fix. Use when the user reports something broken, failing, wrong or slow in production or in the deployed app or extension. For a local red loop use diagnosing-bugs; for Linear states use triage.
---

# Triage production

The job is an **explanation**: how and why the reported behaviour happens in production, backed by measured evidence and a code path, plus a suggested fix. Fixing it is a separate task the user starts; this skill ends at the report.

Production is **read-only** here. Reading is free: `SELECT` queries, `list`/`describe`/`info` commands, `tail`, `GET` probes. Anything that changes production (deploy, D1 writes, secrets, Workflow terminate/restart, queue purge, Email Sending settings) needs the user's explicit go-ahead for that specific action.

Production rows are the user's private data. Quote ids, counts, statuses and timings. Describe URLs, titles, lens questions and page content by their shape ("a Jira ticket URL"), so they stay out of reports, tickets and chat. `tail` output carries full request URLs, and auth links carry tokens in them: keep it in the scratchpad and delete it when done.

`P` below stands for `bun .agents/skills/triage-production/scripts/prod.ts`. All commands run from the repo root with `export WRANGLER_SEND_METRICS=false`.

## 1. Workspace

Work in a dedicated worktree. If `git rev-parse --git-dir` equals `git rev-parse --git-common-dir`, you are in the main checkout: create one with the harness's worktree tool, or `git worktree add ../link-log-triage-<slug> -b triage/<slug> <commit>`.

`<commit>` is the code that is live. `bunx wrangler deployments list --env production` shows the active version with its tag and message; deploys tag the commit (README → Cloudflare: production). An untagged version means the live commit is unknown: use `origin/main`, say so in the report, and treat code paths as provisional.

Done when the worktree is checked out at the live commit, or at `origin/main` with that uncertainty recorded.

## 2. Symptom

Restate the symptom as something measurable: what the user did, what they expected, what happened, roughly when (the user's clock is UTC-3; D1 stores UTC), and which surface (web app, Browser view, extension, email). Ask only for what the evidence can't supply; a time window and the affected ids are usually findable in D1.

## 3. Evidence

Collect evidence layer by layer, starting where the symptom lives. [`docs/agents/production-observability.md`](../../../docs/agents/production-observability.md) lists every signal and how to reach it.

| Symptom | Start with |
| --- | --- |
| A job failed or shows the wrong result (extract, autotag, lens, Browser lens) | `P sql` on `jobs` + `batches` (`status`, `step`, `error`, `reason`), then the instance: `bunx wrangler workflows instances describe linklog-process-link-production <job id>` |
| Something is slow | `P timeline <batch or job id>`, then `describe` the first, a middle and the last job: compare saved → Workflow "Queued" (dispatch) → "Start" → each step |
| A provider call (Jev, OCR, Browser Rendering) | `usage_events`: `status`, `duration_ms`, tokens, `error` |
| API errors, sign-in, 4xx/5xx | `bunx wrangler tail linklog --format json > <scratchpad>/tail.json` in the background; wait for it to connect (the first seconds are dropped), then have the user reproduce. Stored logs: Dashboard → Workers → linklog → Logs |
| Auth email not arriving | `bunx wrangler email sending settings linklog.facundopri.com`, `tail` during a sign-up, the `auth_email` events |
| Site down or misrouted | `curl -s -o /dev/null -w "%{http_code}" https://linklog.facundopri.com/` and `/api/library` (401 without a session is healthy) |

Gotchas no config reveals:

- A Workflow instance that is `complete` can hold a **failed** job: handlers settle failures in D1 and return normally. Job outcome comes from `jobs`, never from the instance status.
- Instance id = job id. The instance's "Queued" time is when `dispatch` called `create()`, not when the job was saved.
- `wrangler workflows instances describe` prints the machine's local time; D1 and `usage_events` are UTC ISO strings.
- Browser jobs have `target_id` (a `browser_targets` row), not `link_id`. `browser-lens` and `browser-autogroup` use the `jev` pool (`worker/handlers/browser.ts`); slot limits are in `worker/jobs.ts` (`POOL_LIMITS`, overridable by `JEV_CONCURRENCY`/`BROWSER_CONCURRENCY`).
- `P sql` refuses anything but one read. `PRAGMA table_info(<table>)` shows a table's columns.

Done when every part of the symptom is **accounted for**: a failure has its error and the step that raised it; a slowdown has a timeline where every second between the user's action and the result falls in a measured segment. A segment you can't measure is a gap (step 5), named as such, never filled by a guess.

## 4. Cause

Tie the evidence to code at the live commit: the function and `file:line` that produce each measured segment or error, and why it behaves that way. When the mechanism needs proof beyond production evidence, reproduce it locally: `diagnosing-bugs` for a red loop, `verify-linklog` for the web UI and API, `bun run test:browser` for the extension.

Done when the cause is stated as mechanism → evidence → code path, and the user's own guess (if they offered one) is confirmed or refuted with numbers.

## 5. Report

Write `planning/triage/<YYYY-MM-DD>-<slug>.md`:

- **Symptom**: the measurable restatement from step 2.
- **Evidence**: the commands you ran and the redacted results that matter (timelines, counts, errors).
- **Cause**: mechanism, code path, and how sure you are.
- **Suggested fix**: the change, where it goes, and how to prove it (the measurement that should change). Not implemented.
- **Observability gaps**: every signal this triage needed and couldn't get, with the cheapest fix.

Add each new gap to the Gaps list in `docs/agents/production-observability.md`, or extend an existing entry with this triage as evidence. Commit the report and the ledger on the worktree branch.

Done when the report has all five sections and every gap is in the ledger.

## 6. Next steps

Summarise the cause and the suggested fix to the user, then put the route to them with your recommendation (one structured question). Every route ends with a Linear ticket: read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`, look for an existing ticket first, and write the ticket from the report (redacted as above, with its path on the branch).

- **In place.** The cause is certain, the fix is small, and it needs no product or design call: one code path, a measurement that proves it. Create the ticket (`ready-for-agent`), fix it in this worktree, and verify with the same measurement the report names. Under `poteto-mode`, continue its Bug fix playbook (or Perf issue, for a slowdown) from step 3, plan the fix: this triage already did steps 1–2, and the timeline is the baseline. Otherwise follow `diagnosing-bugs` from its fix phase. The PR links the ticket.
- **Grill now.** The fix hangs on a decision only the user can make (behaviour, scope, cost, a tradeoff the evidence can't settle). Run `grilling` in this session over the decisions the triage surfaced, seeded with the report. Then create the ticket, or `to-tickets` when the work splits into several slices, with the decisions recorded and the state the grill reached (`ready-for-agent` or `ready-for-human`).
- **Ticket for later.** The decision can wait. Create the ticket (`needs-triage`) with the report and the open decisions listed as questions, so a later grill starts from them.

Done when the ticket exists, read back with its identifier and URL, and the chosen route has started (fix in progress, grill under way, or the ticket parked).
