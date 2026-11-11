# Production observability

What production (`https://linklog.facundopri.com`, `wrangler.jsonc` → `env.production`) records, and the known gaps. The `triage-production` skill adds a gap here whenever a triage could not measure something it needed; `retro` reviews this file under "Information access".

## Signals

| Signal | What it answers | Reach |
| --- | --- | --- |
| D1 `jobs` + `batches` | Outcome of every job (`status`, `step`, `error`, `reason`), when it was saved and settled. The source of truth for success or failure. | `prod.ts sql` / `prod.ts timeline` |
| D1 `usage_events` | Each provider call: `provider`, `service`, `status`, `duration_ms`, tokens, `estimated_usd`. | `prod.ts sql` |
| Workflow instances (`linklog-process-link-production`, id = job id) | When `create()` ran ("Queued"), when it started, each step's start, end, output and error. | `wrangler workflows instances describe` |
| Workers Logs | `console.log` JSON events, mostly failures (`grep -rhoE 'event: "[a-z_]+"' worker` lists them). | Dashboard → Workers → linklog → Logs. The Observability API answers 403 to Wrangler's OAuth token. |
| Workers Issues | Errors grouped by cause: uncaught exceptions, failed invocations, 5xx responses and `console.error` lines, with counts, first/last seen and source-mapped stack traces. Only traffic since FAC-219's deploy. | Dashboard → Workers → linklog → Issues. |
| Workers Traces | One trace per invocation (fetch, cron, queue, Workflow step) with automatic spans for D1, R2, subrequests and their durations. Every invocation is sampled (`head_sampling_rate: 1`); kept 7 days. | Dashboard → Workers → linklog → Observability → Traces. |
| `wrangler tail` | Live invocations: URL, outcome, wall/CPU time, logs, exceptions. Only while connected. | `bunx wrangler tail linklog --format json` |
| Queue `linklog-jobs-production` | Producers and consumers. | `wrangler queues info` |
| Deployments | Which version is live, and its tag/message. | `wrangler deployments list --env production` |

### Jev timing events (Workers Logs)

One JSON line each, ids and numbers only (`worker/jev-metrics.ts`). Group by `batch_id` or `job_id`. Durations are milliseconds.

| Event | Fields | Answers |
| --- | --- | --- |
| `jev_job_started` | `job_id`, `batch_id`, `kind`, `queue_wait_ms` | How long a job waited, from its creation, before it started running. |
| `jev_call` | `job_id`, `batch_id`, `provider`, `latency_ms`, `waited_ms`, `ok`, `http_status`, `reason` | Jev call latency (a call sent, answered or failed). `waited_ms` is the job's age when the call was sent: queue wait plus slot wait. |
| `jev_rate_limited` | `job_id`, `batch_id`, `retry_after_s` | One line per 429 from Jev. Count them. |
| `jev_batch_first_result` | `batch_id`, `kind`, `job_id`, `ms` | Time from the batch's creation to its first successful job. |
| `jev_batch_done` | `batch_id`, `kind`, `jobs`, `done`, `failed`, `first_result_ms`, `duration_ms` | Batch duration, once no job is left. Jobs settling together can log it twice: use the latest line per batch. A batch retry logs it again with the longer duration. |

Only Jev kinds log them (`autotag`, `lens`, `query`, `browser-lens`, `browser-autogroup`). In the Workers Logs query builder the JSON fields are queryable. p95 Jev latency: filter `event = jev_call` and `ok = true`, then calculate `p95` of `latency_ms`. 429 count: filter `event = jev_rate_limited` and count. These lines do not exist before the deploy that ships them.

`invocation_logs` stay off on purpose: auth links carry tokens in the URL. Traces still record each request's `url.full` and `url.path`, and Cloudflare's docs don't say whether `redact_query_string` applies to them, so verify, magic-link and reset tokens may appear in traces of `/api/auth/*` requests for up to 7 days. Only account members can read them; lower `head_sampling_rate` or turn traces off if that is not acceptable.

Issues, traces and source maps are set in `wrangler.jsonc` (top level and `env.production`) and in `scripts/preview/model.ts` for PR previews. Keep `observability.issues.enabled` there: a Wrangler deploy without it turns Issues off. From 2026-12-01 traces count toward Workers Observability ingestion.

## Gaps

Each entry: what could not be measured, the triage that hit it, and the cheapest fix. Remove an entry when it is fixed.

- **Dispatch is invisible.** Nothing logs the Queue consumer (`dispatch`, `worker/jobs.ts`): how long saving → Workflow `create()` takes, per job, is reconstructed by joining D1 times with each instance's "Queued" time. Hit by the 2026-10-30 Browser lens slowness (21 tabs; `create()` ran up to 12 s after the jobs were saved). Fix: a `queue_dispatch` event with counts and duration.
- **No job lifecycle event for non-Jev jobs.** Jev jobs log `jev_job_started` and batch events, but extraction and preview jobs log nothing about how long they waited and ran; their timeline comes from D1 plus Workflows. Fix: the same helpers for those kinds.
- **Stored logs need the dashboard.** The Workers Observability query API returns 403 to Wrangler's OAuth token. Fix: a read-only API token with Workers Observability read, kept out of the repo.
- **Deploys don't name their commit.** The 2026-10-30 deploy has no tag or message, so the live code can't be tied to a commit. Fix: deploy with `--tag`/`--message` (see README → Cloudflare: production).
- **No alerts.** Nobody is told when errors spike or jobs pile up. Issues groups errors but nothing pushes them to anyone. Fix: a Cloudflare notification, or a scheduled check over D1 failures.
