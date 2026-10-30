# Linklog

A personal link library: capture fast, find later. Built with `bun init --react`, React **19.x**, Bun and Cloudflare Workers + D1. The UI is Tailwind v4 + shadcn (`components.json`, `src/components/ui`).

## Run locally

```sh
bun install
bun run dev
```

Open http://127.0.0.1:3000 (localhost redirects there: cookies and the trusted origin are bound to one host). The command builds the assets with `bun scripts/build.ts` (Bun.build + bun-plugin-tailwind), applies **local** migrations, starts Wrangler on 127.0.0.1:8787 and Bun with HMR on 127.0.0.1:3000. Data persists in `.wrangler/state` (override with `LINKLOG_PERSIST_TO`; ports with `LINKLOG_UI_PORT`/`LINKLOG_API_PORT`); nothing is sent to a remote database.

### Accounts and privacy

Every library is private to its account (Better Auth on D1). Sign up with email + password (an emailed link verifies the address), or ask for a one-time magic link (5 minutes). "Forgot password" sends a reset link; resetting ends the other sessions. Locally, emails are **simulated**: Wrangler writes them under `.wrangler/tmp/email/` (they contain live sign-in links for that local state).

- `bun run demo` → isolated A/B demo at http://127.0.0.1:3100 (API 8800, state `.wrangler/demo-state`, local-only bindings). It creates `demo-a@linklog.test` and `demo-b@linklog.test` through the real sign-up flow and offers them on the sign-in screen. Never available in a built/deployed bundle.
- `bun run demo:connected` → the same local accounts and storage, with real Cloudflare Browser Run/AI bindings. Requires `wrangler login` and may incur cloud usage charges. Use this to test automatic page extraction: `quickAction` is not supported by Wrangler's local Browser simulator. Stop the other demo first; keep the same `LINKLOG_PERSIST_TO` to preserve its data. Email remains locally simulated in both modes; real delivery requires the hosted preview.
- Data created before accounts existed stays in D1/R2 but belongs to nobody and is invisible until you assign it with the local tool `bun run legacy:adjudicate` (inventory → backup → assign to a verified user). See `planning/research/auth-implementation-report.md`.

- **Add link** button or `⌘/Ctrl K`: one URL or a list, with optional tags.
- Paste a URL or a list outside of a field, or drag a link from the browser onto the page: saves directly.
- `/`: focuses search. Searches title, description, URL, domain and tags.
- **Filter** menu: domain and context filters; tags filter with AND semantics.
- Click a row to open the inspector: preview, tags, AI confidence, content and details. `↑`/`↓` move between links and `Esc` closes it.
- Hover `…` on a row for actions (open, copy URL, edit tags, extract, delete).
- Row checkboxes open a floating selection bar. On wide screens it shows the count (a menu with **Select all N visible** and **Clear selection**), **Auto-tag** `T`, **Lens** `L` and **Extract context** `E`, each with an `eligible/total` badge when only some of the links qualify and the reason in a tooltip, then **More** `⌘K` and **Clear**. Narrow and mobile screens keep the compact bar.
- While links are selected, `⌘K` opens an actions palette (it stays **Add link** otherwise). It has one row per action with its skip reason, `eligible/total` and key, a filter, and a lens picker with **New lens…**. With the filter empty, pressing an action's key runs it: `T` Auto-tag, `L` Lens, `E` Extract context, `C` Copy URLs, `⇧C` Copy URLs + titles. The keys are ignored while typing or while a menu or dialog is open.
- **Open** needs the Chrome extension (see Browser view): it opens up to 50 selected links as background tabs in
  this window and skips links that are already open there.
- When a batch started from the selection ends with failures, a card above the bar lists each failed link with its reason and **Select failed** selects exactly those links.
- To add a bulk action, add one entry to `BULK_ACTIONS` in `src/bulkActions.ts` (label, group, key, availability rule, runner). The bar, palette and keys read that list, so the availability rules live only there.
- In the sidebar, **Tags** `+` creates a tag and `…` edits it (name, description for the AI, confidence threshold) or deletes it. **Activity** and **Usage** live in the sidebar footer.

## Browser view (Chrome extension)

The repo is a Bun workspace: the app/Worker stay at the root, plus
`packages/browser-protocol` (shared contract) and `apps/extension` (MV3 extension).
Browser shows the tabs and groups of **the Chrome window that holds the Linklog page**:
groups replace tags in the sidebar, lenses become toggles you can combine as filters,
and the selection bar saves, groups, autogroups and closes tabs.

```sh
bun run dev               # app + API as before (ports: LINKLOG_UI_PORT / LINKLOG_API_PORT)
bun run extension:build   # unpacked extension in apps/extension/dist
bun run extension:chrome  # Chromium with an isolated profile and the extension loaded
```

In Chrome stable: `chrome://extensions` → Developer mode → **Load unpacked** →
`apps/extension/dist`. The extension finds Linklog on `http://localhost` / `http://127.0.0.1`
on **any port** (the page identifies itself with `<meta name="linklog-app">`; other local apps
get no bridge). For another origin, e.g. a deployed Linklog, build with
`LINKLOG_ORIGINS=https://linklog.example bun run extension:build`. The extension asks for
page-content access from its own Connect page; without it, tabs and groups still work and
lenses show "No access". With it, row previews (description and image) are read locally for
every accessible tab, and those images load from each site's own servers.

Lens results live in the extension's session storage: they survive closing Linklog and the
service worker sleeping, but not a Chrome restart or reloading the extension. They are scoped to the signed-in account's library id, and signing out asks the extension to drop that account's results. Evaluating a tab
never saves it; **Save** adds the tabs' URLs exactly like adding links in All links (the server
fetches metadata and content, then autotags).
Details: [plan](docs/browser-feature-plan.md) · [implementation](docs/browser-implementation-handoff.md) ·
[validation](docs/browser-validation.md). Other commands: `extension:dev`, `extension:package`,
`build:all`, `test:browser` (real Chromium, isolated ports/DB, fixture Jev provider).

## Metadata and URLs

Saves immediately to D1; the extraction workflow enriches title, description, Open Graph and favicon. It follows up to six HTTP requests with manual redirects, a 10s timeout and a 1MiB read cap. It validates protocol, credentials, ports, host and public DNS addresses per hop. The preview does not execute remote JavaScript or access authenticated pages; the later Markdown extraction uses a Cloudflare browser. It decodes HTML entities; everything renders as React text.

The aliases `youtu.be`, `www.youtube.com`, `m.youtube.com` and `music.youtube.com` are grouped as `youtube.com`. Known tracking parameters are stripped; functional parameters and fragments are preserved. Exact-normalized duplicates or duplicates of an already-resolved destination return the existing link and merge tags, even with concurrent saves. Two different shorteners reaching the same destination after saving can still coexist; they are not merged automatically.

The preview is retried twice with exponential backoff when the site is slow, unreachable, rate limited or answers 5xx; a block (401/403 or a bot challenge), 404/410 or a non-HTML file (like a PDF) fails at once. A failed preview keeps the link, shows a plain reason and allows a retry; on a re-extract, a preview that worked before is kept and the failure is only listed in Activity. A link whose preview has not finished shows as processing while it has a queued or running job; if the Worker restarts mid-extraction, the cron recovery below resends the job. A link left without a preview and without a job (cancelled batch, interrupted extraction) stays neutral, never in Needs attention, and offers "Fetch preview", which runs as a queued job like any other.

Needs attention is stored on the link (`attention_kind` = `preview` or `content`, with its reason) and set only when a job settles with a step that failed for good, after its retries. It is never set while a link is queued, running or retrying, nor by a cancelled or interrupted job, nor when a failed re-extract still shows the previous content or preview (that failure is only listed in Activity). Retry runs only the failed step: the preview alone, or the content alone from the URL the preview resolved. The link stays in the list while the retry runs and leaves it only when that step succeeds (pasting content also resolves a content failure). Dismiss removes it from the list without changing anything else; a later final failure brings it back. When both steps failed, the content failure is shown first. When content definitively cannot be obtained, genuine metadata is used automatically (`content_source='preview'`, partial). There is no preference switch. A real title or description is required: domain/URL placeholders, generic adapter labels and images alone are insufficient. Existing valid content wins, including after failed re-extraction. The row icon and Inspector distinguish metadata available for evaluation from metadata actually used by an existing evaluation; UI labels are never added to Jev's input. Explicit Use preview can recover a failed fallback storage write. A later successful extraction replaces fallback content without silently rerunning Jev.

List fields prefer fetched metadata. Extraction fills only missing fields from an identifiable heading, social caption or usable image; descriptions remain empty when unavailable. No extra LLM requests generate display fields. Failed or partial metadata refreshes preserve good existing values, including YouTube oEmbed previews. Confirmed NXDOMAIN fails fast; empty DNS answers, timeouts and resolver failures use bounded retries. Private destinations and unsupported ports remain fail-fast. R2 stores owner-scoped Markdown and transcripts.

FAC-48 migrations start at `0018`, after main's shipped `0012`–`0017`. Fresh databases and upgrades from main are tested. Disposable pre-auth PR8 databases must be recreated before deploying this ordered series; never apply the renamed series over an old PR8 migration ledger or reset production. The PR8 preview was explicitly recreated for this integration. See `planning/qa/fac-48-test-plan.md` for current validation and historical recording limits.

## Cloudflare: current boundary

The API runs on the Workers runtime (Hono for HTTP, Better Auth for sessions) and uses the real D1 binding emulated locally. **It is not deployed and not connected to a remote database.** Bun is used for development/build; it is not the Workers production runtime.

Configuration fails closed: a deployed Worker defaults to `APP_ENV=production` and answers 503 until `BETTER_AUTH_URL` (public HTTPS origin), the `BETTER_AUTH_SECRET` secret, `EMAIL_FROM` and the `EMAIL` (Cloudflare Email Service) binding are valid; requests for any other host get 403. `wrangler.jsonc` still contains an explicitly local D1 ID. Before a deployment: provision D1/R2, the domain and Email Service, set the secrets, apply remote migrations and verify delivery — see the runbook in `planning/research/auth-implementation-report.md`. Remote exposure also calls for hardening egress/DNS against rebinding and paginating the library.

Documentation consulted: [Bun React](https://bun.sh/guides/ecosystem/react), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/).

## Verify

```sh
bun run typecheck
bun test
# Real local runtime (workerd + D1/R2/Queue/Workflow) behind the proxy: sign-up, verification,
# magic link, reset, logout, two-account isolation incl. Browser. Throwaway state, ports 3197/8897.
bun run test:e2e
# With dev running: integration against local D1 as a local account; cleans up only its own records.
LINKLOG_CHECK_EMAIL=... LINKLOG_CHECK_PASSWORD=... bun scripts/check-api.ts
# Build and run without HMR on the Workers runtime:
bun run preview
```

## Context and classification

`bun run dev` applies migrations and opens the library at `http://localhost:3000`.
D1, R2, Queues and Workflows run **locally**. Browser Rendering and, if selected,
Workers AI are **remote** bindings: their calls use real services. The library is
not deployed and public access is not enabled.

- Saving a link or pasting a list outside of a field creates an extraction batch.
  Large lists are split into batches of 100, with deduplication by normalized URL.
- The workflow resolves redirects and fetches metadata; the adapter registry in
  `worker/adapters/index.ts` chooses source-specific adapters before the web fallback.
- Web uses Browser Rendering → Markdown. YouTube uses public captions via
  `youtube-transcript-plus`; video selection follows original language → English
  with an explanation → manual track choice. It does not transcribe audio or
  access private content. The inspector accepts pasted/uploaded `.txt`, `.md`,
  `.srt` and `.vtt` when no public transcript is available.
- YouTube posts, public Instagram posts/reels and X posts keep the author's text
  and ordered attachments from the exact post. Images receive automatic OCR
  from Gemma 4 in Workers AI. Accessible still previews of attached videos receive the same OCR,
  labeled as text from the still preview; video motion and audio are not analyzed.
  OCR and the author's text share the saved Markdown used by tags and lenses. The inspector
  shows each image's result, partial failures and an explicit retry. Completed
  OCR is reused on re-extraction.
- The "With context" filter and "Untagged" view help narrow the selection before
  paying for an evaluation. Select links and use **Auto-tag** or **Lens**.
- Auto-tag groups one Noul per tag into one call per link. A complete, valid
  response replaces all of its tags (including manual ones) and scores.
  Failures preserve the previous state. The initial threshold is 80%, editable;
  it is a starting configuration, not a guaranteed calibration.
- Each score keeps the description, threshold, tag version and content version
  of that run. Changing a tag does not re-evaluate previous links.
  All scores are visible in the inspector's confidence list; discarded ones also
  appear in the tag picker. Auto-tagged chips show the percentage on hover.
- A lens offers Noul or Choice, with per-link results, without modifying tags.
  Choice includes an "Other" option. Results and progress are stored per batch.

### Credentials

For Markdown, authenticate Wrangler with `browser:write`, in addition to its
Worker and account permissions. `bunx wrangler login` opens the authorization
flow.

For TypeSafe, fill in `.dev.vars` **locally** (ignored by Git):

```dotenv
JEV_PROVIDER="typesafe"
TYPESAFE_API_KEY="your-key"
```

Save and restart `bun run dev` if Wrangler does not reload the variables. Keys
are never sent to the browser. For Cloudflare, use `JEV_PROVIDER="cloudflare"`;
it requires the `ai:write` permission and balance for `typesafe/jev`. Insufficient
balance is reported as an error; the provider is not switched automatically.

### Costs, retries and current limits

"Usage" records every provider attempt, reported tokens, model, latency, browser
time, link, batch and status. USD rates are configured manually per the provider
contract and stored with each attempt; without measurement or a rate the cost is
**unknown**, never assumed zero. Estimates do not represent final billing and do
not include storage infrastructure, Workflows, Queue, minimums, discounts or
Browser Rendering concurrency. The panel shows the latest 1,000 operations.
Gemma OCR estimates use configured input/output token rates when both counts are
reported. Images are fetched temporarily from public platform CDNs with an 8 MB
cap; media are not archived, and remote preview URLs can expire. Extraction uses
public access without login or personal cookies. A blocked image remains visible
as a partial result when useful text was obtained.

D1 acts as the outbox, Queue delivers IDs and each Workflow uses a stable ID so
work is not duplicated on redelivery. A link runs one job at a time: an auto-tag or
lens job requested while another is queued, running or waiting on the same link is
stored as `waiting` (never sent to the Queue) and starts, oldest first, in the same
transaction that settles the job ahead of it; cron also starts any waiting job left
without one ahead. An explicit extraction or preview is refused instead ("Some
selected links are still processing.") while its link is busy.
Auto-tag and lenses accept links with content or with an extraction on the way and
skip the rest ("Extract, then auto-tag" extracts them first, only when asked); Jev
never starts an extraction. If that extraction ends without content, the waiting
Jev job fails as "Content missing" before any provider call, and stays out of Needs
attention. A link with a waiting job counts as processing, and one-off edits (paste
content, Use preview, tags, retry) wait for it. Cancelling a batch drops its queued
and waiting jobs; cancelling a not-yet-started extraction also cancels the auto-tag
and lens jobs waiting for it. A single job can also be cancelled from Activity
(`DELETE /api/jobs/:id`), whether queued, waiting or running: a running job's
Workflow is terminated first. The job ends as Cancelled (not counted as failed),
the link keeps whatever already ran (previous content, a fetched preview) and goes
back to how it was otherwise, Needs attention is never touched, a cancelled
extraction takes the Jev jobs waiting for it along, and the link's next waiting
job starts. A late write from the terminated job (content, completion, failure,
preview fallback) is ignored. A Jev job cancelled after sending may still be billed
("Cancelled after calling Jev"); its Usage row is kept and it is never resent. Paid steps are not silently retried. A Jev failure
is split by phase: before the request is sent ("Failed before calling Jev (no cost)",
no Usage row) only a known transient R2 read or D1 conflict/timeout is retried, once;
a job sends at most one Jev request, authorized by an atomic claim (`jobs.jev_call`)
written with its Usage row, so a late or overlapping attempt never sends again;
once the request may have been sent (HTTP error, timeout, network error, invalid
answer: "may have been billed") it is never retried automatically, and failed
auto-tag and lens jobs can be retried from Activity. If Jev refuses the account
(401/402/403, insufficient balance, quota), the rest of that batch stops without
calling. Jev failures never put a link in Needs attention and are logged as
`jev_step_failed` (phase, reason, provider, HTTP status, attempt). Browser Rendering → Markdown is retried once on a
transient failure (each attempt is a row in Usage), and Activity shows the current
attempt and the reason of the previous one. A failed re-extract keeps the previous
content. If the Markdown is a short login wall, captcha or block page
("Sign in", "Log in to continue", "Just a moment", "Access denied", "Verify you are
human" and similar), it is discarded without a retry and never stored: a link with
no content fails with "Got a login page instead of the content." (Needs attention,
or the preview as content when that setting is on), while a link with content keeps
the previous version and the failure stays in Activity. Each detection is logged as
`login_wall_detected` (domain, matched pattern, text length). Each failed attempt is logged as a `link_step_failed` JSON line (step,
reason, HTTP status, content type, domain, attempt) in Workers Logs. Provider slots are shared through five-minute D1 leases, in two
pools: Browser Rendering 2 and Jev 16 by default, configurable with
`BROWSER_CONCURRENCY` and `JEV_CONCURRENCY`. The preview step times out after 30
seconds (each attempt gives up after 20) and the Markdown step after two minutes
(each attempt gives up after 100 seconds). Cron recovers pending jobs;
`scripts/dev.ts` simulates this cron every 30 seconds because Wrangler does not
run cron automatically in local dev.

The full content is stored in R2 (maximum 2 MB; manual upload 500,000 characters).
Classification sends the content up to 160,000 characters (`MAX_STATE_CHARS`);
longer content is cut there and ends with "[Content truncated for classification]",
so the end of a long document does not reach Jev. The provider's tokenizer still
validates the real window, without confusing bytes with tokens. TypeSafe documents
32,000 tokens for `state` plus the longest question and 64,000 for the complete
request. If the provider rejects the size, the job fails with a clear message and
preserves content, tags and previous scores. No per-fragment probabilities are
added automatically; the strategy for documents that truly exceed the window is
still pending.
Processing uses full context per link, not embeddings or a vector index.

### Verification

- `bun test`: URLs, Noul/Choice answers, complete probabilities and SQLite
  transactions: manual-tag replacement, rejected scores, threshold snapshots and
  rollback on error. Models used in unit tests are explicit fixtures.
- `bun run typecheck` and `bun run build`.
- `bun scripts/check-api.ts`: with the server up; uses its own records, verifies
  concurrent deduplication, D1 and origin/URL guards, and cleans up its links.
  It performs one real example extraction (may consume Browser Rendering).
- Markdown, `youtu.be` resolution and public transcripts, mobile viewer, tag
  editor, Choice queries, usage panel and multi-paste were verified for real.
  Jev via TypeSafe was verified with real calls to `jev-1.13.0`: auto-tag,
  discarded scores, snapshot and threshold change on a new run, Noul/Choice
  queries without modifying tags, and token logging. Credentials live
  exclusively in `.dev.vars`.
