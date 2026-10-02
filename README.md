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
- Data created before accounts existed stays in D1/R2 but belongs to nobody and is invisible until you assign it with the local tool `bun run legacy:adjudicate` (inventory → backup → assign to a verified user). See `planning/research/auth-implementation-report.md`.

- **Add link** button or `⌘/Ctrl K`: one URL or a list, with optional tags.
- Paste a URL or a list outside of a field, or drag a link from the browser onto the page: saves directly.
- `/`: focuses search. Searches title, description, URL, domain and tags.
- **Filter** menu: domain and context filters; tags filter with AND semantics.
- Click a row to open the inspector: preview, tags, AI confidence, content and details. `↑`/`↓` move between links and `Esc` closes it.
- Hover `…` on a row for actions (open, copy URL, edit tags, extract, delete).
- Row checkboxes open a floating selection bar: **Auto-tag**, **Ask**, **Extract context**.
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

A blocked, slow or HTML-less page keeps the link and allows a retry. If the Worker restarts mid-extraction, the pending state expires after 30s to allow recovery. Remote images have a fallback; their availability depends on the site. There is no image archive or oEmbed. R2 stores the Markdown and transcripts.

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
  paying for an evaluation. Select links and use **Auto-tag** or **Ask**.
- Auto-tag groups one Noul per tag into one call per link. A complete, valid
  response replaces all of its tags (including manual ones) and scores.
  Failures preserve the previous state. The initial threshold is 80%, editable;
  it is a starting configuration, not a guaranteed calibration.
- Each score keeps the description, threshold, tag version and content version
  of that run. Changing a tag does not re-evaluate previous links.
  All scores are visible in the inspector's confidence list; discarded ones also
  appear in the tag picker. Auto-tagged chips show the percentage on hover.
- Ask offers Noul or Choice, with per-link results, without modifying tags.
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
work is not duplicated on redelivery. Paid steps are not silently retried; the
user can create a new attempt. There are two shared provider slots via five-minute
D1 leases; steps have a two-minute timeout. Cron recovers pending jobs;
`scripts/dev.ts` simulates this cron every 30 seconds because Wrangler does not
run cron automatically in local dev.

The full content is stored in R2 (maximum 2 MB; manual upload 500,000 characters).
Classification sends the full content and lets the provider's tokenizer validate
the real window, without confusing bytes with tokens. TypeSafe documents 32,000
tokens for `state` plus the longest question and 64,000 for the complete request.
If the provider rejects the size, the job fails with a clear message and preserves
content, tags and previous scores. It is not truncated and no per-fragment
probabilities are added automatically; the strategy for documents that truly
exceed the window is still pending.
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
