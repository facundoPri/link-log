# FAC-48 authenticated integration QA — 2026-10-19

This plan implements the confirmed integration agreement. The prior plan and recordings at feature commit `3e77f23` describe the pre-auth build and the superseded Settings toggle; they are historical evidence, not validation of this build. The historical chapters remain available to compare that build. Use the `integration` chapter for current end-to-end expectations.

## Automated checks

- `bun test`: authenticated router, owner-aware Workflow, D1 constraints, quotas, Browser contracts, extraction, atomic Jev claim/outcome, cancellation and stale recovery regressions.
- `bun test ./planning/research/needs-attention.repro.ts`: eleven original lifecycle reproductions, now through authenticated requests and the merged migration series.
- `bun run typecheck`, `bun run build`, `git diff --check`.
- `tests/fac48-integration.test.ts`: current contract, including real metadata failure envelopes rather than only thrown fixtures.

## Current acceptance matrix

| Area | Required observable behavior |
|---|---|
| Migration | Fresh schema and main through 0017 → FAC48 through 0025 preserve owned rows, content, foreign keys, attention/retry/Jev columns and indexes. |
| Old PR8 migration ledger | Recreate only the positively identified disposable PR8 resources. Never reset another preview or production. |
| Authentication | Real sign-up/verification/sign-in and authenticated library success. A cannot read or mutate B's library, retries, fallback, dismissal, jobs or batches. |
| Pending | Queued, running, retrying and Browser-slot waits do not create attention. A pre-existing warning stays until the failed step succeeds. |
| Preview | Transient 503 retries twice; blocked/login/not-found/non-HTML failures stop immediately. Resolved failed envelopes never publish ready. |
| Content | Browser Markdown retries once for transient failures. Failed re-extraction retains valid prior content. |
| DNS | NXDOMAIN is definitive and fail-fast. Empty answers, SERVFAIL and timeouts are transient. Private addresses/hosts and unsupported ports refuse immediately, including resolved redirects. |
| Automatic fallback | After definitive content failure, use genuine title/description text automatically. No Settings switch or account opt-in exists. Images alone, domain/URL defaults and generic adapter titles are insufficient. |
| Fallback storage | Exhausted storage failure preserves the original terminal failure; explicit Use preview can recover later. Concurrent metadata changes, a new job or cancellation fence stale publication. |
| Display fields | Metadata title/image/description have priority. Identifiable extraction fields fill missing values only; no arbitrary body prose or additional LLM calls. |
| Provenance | Row tooltip and Inspector distinguish available metadata from metadata used by an evaluation. Later extraction does not rewrite evaluation provenance. No UI label enters fallback text. |
| Jev | Explicit extraction may precede auto-tag, which waits per link. No implicit extraction. Only known transient pre-call failures retry once; a possibly sent call never resends. Account failure stops the rest of the batch. |
| Cancellation | Batch cancellation includes extraction workflows waiting for Browser capacity and their waiting dependents. Already-running provider work keeps committed data; single-job cancellation and all late writes remain fenced. |
| Recovery | Stale Queue recovery cannot restore/overwrite a successor extraction. |
| UI | Mixed auto-tag selection reports the skipped count, including links excluded by the client. Activity contains no nested buttons and shows Browser-slot waiting truthfully. |

## Current local UI run

`QA_OUT=qa/out/integration-20261019 LINKLOG_PERSIST_TO=.wrangler/fac48-integration-20261019 bun qa/video/run.ts --chapter integration --no-compose`

The harness uses two disposable local users created through real Better Auth verification and sign-in. API helpers and recorded browser contexts use their real session cookies. External preview/DNS/Browser/Jev responses are deterministic local fixtures, not hosted provider evidence. Use a new output directory to preserve old videos.

- INT-01: fallback after login wall, preview 503 recovery, unavailable page attention, skipped feedback, metadata evaluation provenance, valid Activity markup, Dismiss.
- INT-02: Browser capacity wait, batch cancellation, cancellation of dependent Jev work, no late content/warning on cancelled links.
- Manual authenticated A/B browser smoke supplements the deterministic regression suite.

## Hosted PR8 smoke

After pushing, retain `pr-preview`, identify the deployed commit and URL, and confirm the recreated database has the complete migration ledger. Verify real login and `/api/library` 200, unauthenticated 401, A/B isolation, link creation, recovery, cancellation and valid fallback. Exercise actual providers only as needed; report provider/account failures separately from application failures. Never infer readiness from homepage 200 or a successful deployment workflow alone.

Credentials, session cookies and verification tokens stay out of source, PR text, logs and screenshots. Current evidence and any remaining hosted limitation are recorded under `.reviews/`.
