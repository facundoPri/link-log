# FAC-48 test plan: Needs attention, retries and recovery (FAC-48, FAC-52 to FAC-57)

Branch `facundoPri/fac-48-needs-attention` (HEAD `75ea1c0`). This plan covers the parent FAC-48 and its six sub-issues. It is the input for the manual QA pass and for the scenario-video agents.

Sources: Linear FAC-48 and FAC-52 to FAC-57 (descriptions, acceptance criteria, "Manual QA" comments), `.reviews/S1–S10-impl.md`, the step reviews and `FINAL-review.md`, `.reviews/CR-impl.md`, `planning/research/needs-attention-map.md` (§2 transitions, §3 scenarios A–J, §7–§8 owner decisions), `README.md`, and the code for exact strings (`src/failures.ts`, `src/attention.ts`, `src/components/*`, `worker/jobs.ts`, `worker/index.ts`).

How to read this plan:

- Every case has an ID, a ticket and acceptance criterion (AC), a type, a priority and a video verdict.
- **P0** blocks merge. **P1** should pass before deploy. **P2** is a nice-to-have, or an accepted-limit check.
- **Video: yes** means the scenario can run locally, deterministically and quickly enough to record with asserted captions (QA rules: a clip only counts if its assertions passed). **Video: no** gives the reason: needs hosted Cloudflare, paid or remote calls with uncontrolled responses, real race or timing control, the extension, or it is an API/DB-only check already covered by `bun test`.
- Quoted text is the exact UI or API string from the code. `…` marks where a reason message is filled in.

---

## 0. Common setup

### 0.1 Environment profiles

Always use an isolated state and your own ports (QA rules). The `-c` config must live in the repo root, so relative paths still resolve. Create it under `qa/` as `qa/wrangler.<profile>.jsonc`, a copy of `wrangler.jsonc` with `main`, `assets.directory` and `migrations_dir` prefixed with `../`, plus the `vars` below. There is no `.dev.vars` in this worktree; don't create one, because other workers share the directory.

```sh
LINKLOG_WRANGLER_CONFIG=qa/wrangler.<profile>.jsonc \
LINKLOG_PERSIST_TO=$(mktemp -d) LINKLOG_UI_PORT=31xx LINKLOG_API_PORT=88xx \
LINKLOG_RECOVERY_MS=30000 bun run dev 2>&1 | tee qa/out/dev-<profile>.log
```

| Profile | `vars` | Used for |
|---|---|---|
| **FIX** (default) | `JEV_PROVIDER=fixture`, `ALLOW_FIXTURE_JEV=1` | Everything with Jev. Deterministic, unpaid. |
| **FIX-SLOT1** | FIX + `BROWSER_CONCURRENCY=1` | Queue waits, held `queued` jobs, cancel-while-queued. |
| **NOKEY** | `JEV_PROVIDER=typesafe` and no `TYPESAFE_API_KEY` | FAC-52. |
| **BADKEY** | `JEV_PROVIDER=typesafe`, `TYPESAFE_API_KEY=x` | FAC-54 account stop. Makes **one real request** to `api.typesafe.ai`, which answers 401 (no cost). |
| **CF** (repo default) | none (provider `cloudflare`, remote `AI` binding) | Regression only. Workers AI calls are **paid**; avoid. |

Notes:

- Browser Rendering is `"remote": true` in `wrangler.jsonc`. **Every content extraction in local dev makes a real Browser Rendering call** (metered). Keep counts low, and prefer paste-based fixtures where the case allows.
- Content can be provided without Browser Rendering. Import the URL, cancel the batch from the toast, then use Inspector → "Paste text" (or `PUT /api/links/:id/content {"markdown": "..."}`).
- `wrangler dev` does not fire cron. `scripts/dev.ts` calls `/cdn-cgi/local/scheduled` every `LINKLOG_RECOVERY_MS` (default 30 s). That is `recover()`: it promotes orphaned waiting jobs and resends queued/running ones.
- "Workers log event" locally means a JSON line in the `wrangler dev` stdout (`qa/out/dev-*.log`). Use `grep '"event":"link_step_failed"'`. Hosted, it means Workers Logs (§10).

### 0.2 Fixture URLs (public; private hosts are refused by `publicAddress`)

| Key | URL | Preview result | Content result (Browser Rendering) |
|---|---|---|---|
| U-OK | `https://example.com/`, `https://example.org/`, `https://example.net/`, `https://httpbin.org/html` | ready | ready |
| U-SLOW | `https://httpbin.org/delay/10` (or `/delay/5`) | ready after ~10 s (holds the preview step running) | ready (JSON echo) |
| U-503 | `https://httpbin.org/status/503` | `site_error`, retryable, 3 attempts | ready (error body; detecting error pages is a known gap) |
| U-429 | `https://httpbin.org/status/429` | `rate_limited`, 3 attempts | as above |
| U-404 | `https://httpbin.org/status/404` | `not_found`, fail fast | ready (error body) |
| U-403 | `https://httpbin.org/status/403` | `blocked`, fail fast | ready (error body) |
| U-410 | `https://httpbin.org/status/410` | `not_found`, fail fast | ready (error body) |
| U-FILE | `https://arxiv.org/pdf/1706.03762`; cheap alternative `https://httpbin.org/robots.txt` (`text/plain`) | `not_html`, fail fast | PDF: `empty` (observed); robots: plain text |
| U-EMPTY | `https://httpbin.org/status/200` (empty `text/html` body) | ready (title `httpbin.org`) | `empty`, fail fast → **content failure with a working preview** |
| U-DNS | `https://linklog-qa-nonexistent.invalid/` | `unreachable`, 3 attempts | `unreachable` → **both axes fail** |
| U-WALL-JAM | `https://httpbin.org/base64/<b64>` of `<html><head><title>QA wall</title></head><body><h1>Just a moment...</h1></body></html>` | ready (title "QA wall"; `/base64` serves `text/html`, verified) | `login_wall` (pattern "just a moment") |
| U-WALL-SIGNIN | `/base64/` of `<title>QA sign-in</title><h1>Sign in</h1><p>Email</p><p>Password</p><p>Forgot your password?</p>` | ready | `login_wall` (sign-in + password field) |
| U-WALL-* | `/base64/` pages with a single standalone line: `Access denied`, `Please complete the security check CAPTCHA`, `Our systems have detected unusual traffic from your computer network.`, `You have been blocked` | ready | `login_wall` (one per pattern) |
| U-LONG-SIGNIN | `/base64/` of a header line `[Sign in](/login)` plus >1,500 characters of article prose (or a real news article) | ready | ready, **not** a wall |
| U-PROSE | `/base64/` of a short page whose prose says "To change your password, sign in to your account settings." and "access denied errors happen when…" | ready | ready, **not** a wall |

Build the base64 with `printf '%s' '<html>…' | base64 | tr -d '\n'` (URL-safe enough for these strings; if `+` or `/` appear, use `base64 | tr '+/' '-_'`, which httpbin also decodes). A transient-then-success preview has no deterministic public endpoint. `https://httpbin.org/status/503,200` picks at random, so cases that need it are covered by `bun test` and marked "video: no".

### 0.3 Fixture Jev content markers (`worker/ai/fixture.ts`, profile FIX)

The markers go in the link's **content**, usually pasted: `jev:yes`, `jev:no`, `jev:unsure`, `jev:choice=<label>`, `jev:score=<n>`, **`jev:fail`** (throws, classified as a sent `provider_error`, shown as "Jev returned an error (may have been billed)."), **`jev:slow=<ms>`** (up to 99999; holds the Jev call in flight for cancel and waiting cases). Without markers the answer is a stable hash.

### 0.4 API calls used for verification (port `$API` = `LINKLOG_API_PORT`)

```sh
curl -s localhost:$API/api/library | jq '.links[] | {id,title,status,content_state,processing,previewing,attention_kind,attention_reason,preview_reason,content_reason,content_source}'
curl -s localhost:$API/api/batches/<batch>            # jobs: status, step, attempt, max_attempts, reason, waiting_for, error
curl -s -XPOST localhost:$API/api/batches -H 'content-type: application/json' -d '{"kind":"autotag","ids":["<id>"]}'
curl -s -XPOST localhost:$API/api/links/<id>/retry   [-d '{"step":"content"}']
curl -s -XPOST localhost:$API/api/links/<id>/dismiss
curl -s -XPOST localhost:$API/api/links/<id>/use-preview
curl -s -XPUT  localhost:$API/api/links/<id>/content -d '{"markdown":"…"}'
curl -s -XPUT  localhost:$API/api/settings -d '{"preview_fallback":true}'
curl -s -XDELETE localhost:$API/api/jobs/<job>        # FAC-55
curl -s -XDELETE localhost:$API/api/batches/<batch>   # batch cancel
curl -s -XPOST localhost:$API/api/batches/<batch>/retry
curl -s localhost:$API/api/usage
```

DB invariant check (local D1): `bunx wrangler d1 execute linklog --local --persist-to $LINKLOG_PERSIST_TO [-c …] --command "SELECT link_id, COUNT(*) FROM jobs WHERE status IN ('queued','running') GROUP BY link_id HAVING COUNT(*)>1"` must return no rows.

### 0.5 Automated baseline (run first, every time)

`bun test` (288 pass), `bun test ./planning/research/needs-attention.repro.ts` (11 pass), `bun run typecheck`, `bun run build`. If any of these fail, stop: manual QA results don't count against a red suite.

---

## 1. Needs attention core (FAC-48)

FAC-48 acceptance criteria referenced below:
- **AC1**: representative cases captured (repro A–I).
- **AC2**: attention is added only on final failure, and cleared on success of the failed step or on Dismiss; no stale warning.
- **AC3**: transient failure → automatic retry → success never shows attention; a persistent failure shows it with a readable reason.
- **AC4**: identical after reload and reprocessing.

Owner decisions are cited as §7/§8.x of the research map.

### 1.1 The 30 s rule is gone; processing and neutral states

**NA-01: Queue wait longer than 30 s never enters Needs attention** (reported symptom, repro A)
- Ticket/AC: FAC-48 AC2, AC3; §7 "only after all retries are exhausted". Type: AC. Priority: **P0**.
- Fixtures: profile FIX-SLOT1. Six URLs: U-SLOW ×2 (`/delay/10`, `/delay/8`), then `example.com`, `example.org`, `example.net`, `httpbin.org/html`.
- Steps:
  1. Add Link and paste all six at once.
  2. Wait 60 s without touching anything.
  3. Watch the sidebar and rows throughout.
- Expected:
  - Waiting rows read "Fetching title and preview…" with an "Extracting…" badge. The **Needs attention** sidebar item never appears, and the count stays 0.
  - The menu of a waiting row shows neither "Retry preview" nor "Fetch preview".
  - Every link ends ready. The batch toast ends "Extracted 6 links".
- Verify: UI, plus a `/api/library` poll every 5 s with `processing:true, attention_kind:null` for each waiting link.
- Video: **yes**. Deterministic with one browser slot. It is the headline "before/after" story.

**NA-02: Reload during the wait keeps links processing, not failed**
- Ticket/AC: FAC-48 AC4; repro A "+31s reload". Type: AC. Priority: **P0**.
- Fixtures: as NA-01. Reload the page about 40 s in, while at least two links are still queued.
- Expected: after the reload, the same rows show "Fetching title and preview…". No Needs attention. Activity shows those jobs as "Queued".
- Verify: UI; `/api/library` returns `processing:true` and `status:"pending"` (never `failed`).
- Video: **yes** (same chapter as NA-01).

**NA-03: Activity shows "Queued", not "En cola"**
- Ticket/AC: FINAL review nit (S10). Type: regression. Priority: P2.
- Steps: during NA-01, open Activity and expand the Extract context batch.
- Expected: queued jobs read "Queued". No Spanish "En cola" anywhere.
- Video: **yes** (one shot inside chapter 1).

**NA-04: A cancelled import is neutral ("as if nothing happened")**
- Ticket/AC: FAC-48 scope 1; §7 "Cancelar un batch"; repro F. Type: AC. Priority: **P0**.
- Fixtures: FIX-SLOT1. Import 4 URLs (U-SLOW first, so the others stay queued).
- Steps:
  1. Click **Cancel** in the "Extracting context for 4 links…" toast before the queued ones start.
  2. Wait more than 60 s.
  3. Reload.
- Expected:
  - Toast "Cancelled N queued jobs".
  - Cancelled rows read "No preview yet" (muted, no spinner, no badge). They are not in Needs attention, before or after the reload.
  - Inspector Preview row reads "Not fetched yet · Fetch". The Content area reads "No context yet".
  - Polling stops: no repeating `/api/library` requests in the network tab once nothing is active.
- Verify: UI; `/api/library` returns `status:"pending", content_state:"missing", processing:false, attention_kind:null`.
- Video: **yes**.

**NA-05: "Fetch preview" on a neutral link runs a queued preview job**
- Ticket/AC: FAC-48 scope 3 (preview through the Queue). Type: AC. Priority: P1.
- Fixtures: a cancelled link from NA-04.
- Steps: row menu → **Fetch preview** (or Inspector "Fetch").
- Expected:
  - Activity shows a new batch "Fetch preview". The row shows the "Fetching preview…" badge, then the title and description. Content stays "No context yet" (preview only).
  - The link never enters Needs attention.
- Verify: UI; batch `kind:"preview"`.
- Video: **yes**.

**NA-06: A pending link busy with auto-tag doesn't claim to be fetching a preview**
- Ticket/AC: S1 round 2 nit (`previewing`). Type: edge case. Priority: P2.
- Fixtures: FIX. Cancelled import, then paste content `jev:slow=8000 hello`, then Auto-tag.
- Expected: while the job runs, the row reads "No preview yet" with a "Tagging…" badge (not "Fetching title and preview…"). There is no Fetch preview action while processing.
- Video: no (minor wording; covered by `tests/needs-attention.test.ts`).

### 1.2 Reasons, retries, attempts and timing in Activity

**NA-07: Transient preview failure is retried visibly and enters only after the final attempt**
- Ticket/AC: FAC-48 AC2, AC3; scope 2. Type: AC. Priority: **P0**.
- Fixtures: FIX; U-503.
- Steps:
  1. Save the URL.
  2. Open Activity → Extract context and keep it open.
  3. Watch the row and sidebar until the job ends (about 15–25 s of backoff plus the content step).
- Expected:
  - While running, Activity reads "Fetching preview · Attempt 2 of 3 · Ns of 20s". Between attempts it reads "Fetching preview · Attempt 2 of 3 · Waiting to retry" with the note "Previous attempt: The site had a problem.". Then "Attempt 3 of 3".
  - The link is **not** in Needs attention while the job runs, even though the preview already failed and content is extracting.
  - After the job ends, the row shows "Couldn't get the preview: The site had a problem." with **Retry** and **Dismiss**, plus a "No preview" badge. Needs attention (1).
  - The Activity job is done, with the note "No preview: The site had a problem.".
- Verify: UI; `/api/batches/<id>` during the backoff returns `attempt:2, max_attempts:3, reason:"site_error", attempt_started_at:null`; log shows 3 × `link_step_failed` with `step:"preview"`, `attempt` 1/2/3, `final:true` only on 3, `adapter:"preview"`.
- Video: **yes**. Deterministic; timing is about 30 s and can be sped up in the edit.

**NA-08: Rate-limited preview (429) also retries 3 times**
- Ticket/AC: §8.2 (429 is retryable). Type: edge case. Priority: P1.
- Fixtures: U-429. Expected: 3 attempts; final row "Couldn't get the preview: The site is limiting requests right now.".
- Verify: log shows 3 `link_step_failed` lines with `reason:"rate_limited"`, `http_status:429`.
- Video: no (duplicates NA-07).

**NA-09: DNS failure retries, then both axes fail; content is shown first**
- Ticket/AC: repro G; S4 "content first". Type: edge case. Priority: P1.
- Fixtures: U-DNS.
- Expected:
  - Preview makes 3 attempts and content 2 (`unreachable` is retryable).
  - The row shows "Couldn't get the content: The site could not be reached." plus the "Context failed" and "No preview" badges, with Retry and Dismiss and **no** Use preview (no preview obtained).
- Verify: `attention_kind:"content", attention_reason:"unreachable"`, `preview_reason:"unreachable"`.
- Video: **yes** (needed as the setup for NA-20 and PF-07).

**NA-10: A file link (PDF or non-HTML) fails fast with a readable reason**
- Ticket/AC: FAC-48 AC3; §8.7.1 (non-HTML fails fast); repro B. Type: AC. Priority: **P0**.
- Fixtures: U-FILE (`arxiv.org/pdf/1706.03762`; `httpbin.org/robots.txt` as the cheap alternative).
- Expected:
  - Exactly one preview attempt (no "Attempt 2").
  - After the job: Needs attention (1). The row reads "Couldn't get the preview: This link is a file (like a PDF), not a web page." with **Retry** and **Dismiss**.
  - Inspector Preview reads "Failed · This link is a file (like a PDF), not a web page.".
- Verify: one `link_step_failed` with `attempt:1, final:true, reason:"not_html"` and `content_type:"application/pdf"` (or `text/plain`).
- Video: **yes**.

**NA-11: 404 and 410 fail fast with "The page no longer exists."**
- Ticket/AC: §8.7.1. Type: AC. Priority: P1.
- Fixtures: U-404, U-410. Expected: one attempt each; row "Couldn't get the preview: The page no longer exists.".
- Verify: log `reason:"not_found"`, `http_status` 404 or 410.
- Video: no (API and log check; same UI as NA-10).

**NA-12: 403 fails fast with "The site blocks automated access."**
- Ticket/AC: §8.7.1 (401/403/anti-bot). Type: AC. Priority: P1.
- Fixtures: U-403. Expected: one attempt; "Couldn't get the preview: The site blocks automated access.".
- Video: no.

**NA-13: Transient failure followed by success never shows Needs attention**
- Ticket/AC: FAC-48 **AC3**; repro A and G. Type: AC. Priority: **P0**.
- Fixtures: no deterministic public endpoint. Run `bun test tests/retries.test.ts tests/attention.test.ts` (scenario "transient then success"; snapshots during every attempt show `attention:false`). Optional manual check: `https://httpbin.org/status/503,200` (random; repeat until a run shows "Attempt 2 of 3" and then succeeds).
- Expected: the link is never in Needs attention, ends ready with no reasons, and leaves no stale warning.
- Video: no (non-deterministic publicly; the harness covers it).

**NA-14: Markdown retry is visible and metered**
- Ticket/AC: FAC-48 scope 2 (Browser Rendering → Markdown: 1 retry). Type: AC. Priority: P1.
- Fixtures: needs a transient Browser Rendering 5xx or 429; not reproducible on demand locally. Covered by `tests/retries.test.ts` (503 then OK: 2 calls, "Attempt 2 of 2", no attention).
- Expected: "Extracting content · Attempt 2 of 2"; Usage shows two `browser-markdown` rows for the job.
- Video: no (needs remote fault control). Re-check hosted in HO-06.

**NA-15: Timing line survives a reload**
- Ticket/AC: S3 round 2 item 5. Type: AC. Priority: P2.
- Fixtures: a slow page (heavy real page) during "Extracting content".
- Steps: reload Activity mid-attempt.
- Expected: "Extracting content · Attempt 1 of 2 · 40s of 1m 40s" (elapsed time keeps growing after the reload; capped at the budget).
- Video: no (needs a page that is reliably slow in Browser Rendering).

**NA-16: Content failure on a fresh link, with the preview working**
- Ticket/AC: FAC-48 AC2, AC3. Type: AC. Priority: **P0**.
- Fixtures: FIX, Settings fallback **off**; U-EMPTY.
- Expected:
  - Row: "Couldn't get the content: The page returned no content. You can paste it manually." with a "Context failed" badge, and **Retry**, **Use preview** and **Dismiss**.
  - Exactly one content attempt (`empty` fails fast).
- Verify: `attention_kind:"content", attention_reason:"empty"`; log `step:"content"`, `adapter:"web"`.
- Video: **yes**.

**NA-17: Telemetry line carries the agreed fields**
- Ticket/AC: FAC-48 scope 2; §8.5. Type: AC. Priority: P1.
- Steps: after NA-07, NA-10 and NA-16, grep the dev log.
- Expected: each `link_step_failed` has `link_id, job_id, step, attempt, max_attempts, final, reason, retryable, http_status, content_type, domain, adapter, detail`. Only the **domain** is logged (no full URL, no query string). Technical text appears only in `detail`, never in the UI.
- Verify: `grep link_step_failed qa/out/dev-*.log | jq .`.
- Video: no (log inspection).

**NA-18: Browser Rendering auth failure says the reader is unavailable**
- Ticket/AC: S3 round 3; CR finding 1. Type: edge case. Priority: P2.
- Fixtures: an invalid Browser Rendering account or token (remote config), or rely on `tests/failure-reasons.test.ts` ("auth words inside a quoted URL…").
- Expected: "The page reader is unavailable right now. Try again later." after **1** call, never "The site blocks automated access.".
- Video: no (needs a broken remote binding).

### 1.3 Persisted attention, Retry of the failed step, Dismiss

**NA-19: Retry of a preview failure keeps the row in the list, without flicker**
- Ticket/AC: FAC-48 AC2; scope 3; repro B and D. Type: AC. Priority: **P0**.
- Fixtures: the U-FILE link from NA-10.
- Steps:
  1. Filter by Needs attention.
  2. Click **Retry** on the row.
  3. Watch the counter.
  4. Reload when it ends.
- Expected:
  - Activity gets a new "Fetch preview" batch.
  - The row stays in the filtered list with a "Fetching preview…" badge. Retry and Dismiss are hidden while it runs.
  - The counter never drops to 0.
  - The retry fails again with the same reason "Couldn't get the preview: This link is a file (like a PDF), not a web page.". The reload shows the same view.
  - Content is **not** re-extracted: the batch is `kind:"preview"` and there are no Browser Rendering Usage rows.
- Verify: UI; `/api/library` keeps `attention_kind:"preview"` throughout; Usage.
- Video: **yes**.

**NA-20: Content-only Retry starts at "Extracting content"; Paste resolves the content**
- Ticket/AC: FAC-48 scope 3 (Retry runs only the failed step); AC2. Type: AC. Priority: **P0**.
- Fixtures: the U-EMPTY link from NA-16.
- Steps:
  1. **Retry** on the row.
  2. Watch Activity.
  3. Inspector → Paste text "QA pasted body" → Save.
- Expected:
  - The Retry runs an Extract context batch whose job goes straight to "Extracting content" (no "Fetching preview" step). The row stays in the list ("Extracting…" badge) and fails with the same reason.
  - The paste removes the link from Needs attention, and the counter drops by one.
- Verify: `/api/batches/<id>` steps; `attention_kind:null` after the paste.
- Video: **yes**.

**NA-21: Both axes failed: the paste clears content and the preview warning takes over**
- Ticket/AC: S4 "content first, then the preview takes over"; repro B and G. Type: edge case. Priority: P1.
- Fixtures: the U-DNS link from NA-09.
- Steps: paste text into it.
- Expected: the link stays in Needs attention, now reading "Couldn't get the preview: The site could not be reached.". The "Context failed" badge disappears. "No preview" stays.
- Video: **yes**.

**NA-22: Retry success clears the warning (no stale warning)**
- Ticket/AC: FAC-48 AC2; repro G. Type: AC. Priority: **P0**.
- Fixtures: needs a URL that fails, then works. Covered by `tests/attention.test.ts` B, D and G (a 200 after a 403 clears preview attention; content success clears content attention). Manual option: none deterministic locally.
- Expected: attention clears only when the failed step succeeds, never at enqueue.
- Video: no.

**NA-23: Dismiss removes the link from the list and changes nothing else**
- Ticket/AC: FAC-48 AC2; §8.3c. Type: AC. Priority: **P0**.
- Fixtures: the U-FILE link (preview attention) and the U-EMPTY link (content attention).
- Steps:
  1. Click **Dismiss** on one row.
  2. Use the row menu → "Dismiss from Needs attention" on the other.
  3. Reload.
- Expected:
  - Both leave the list, and the counter goes 2 → 1 → 0. The **Needs attention** sidebar item disappears at 0.
  - The rows (in All links) still show "No preview" / "Context failed". Inspector data is unchanged (title, reasons, `content_state`).
  - The reload keeps them dismissed.
- Verify: `attention_kind:null`, while `status`, `content_state`, `preview_reason` and `content_reason` are unchanged.
- Video: **yes**.

**NA-24: The same failure after Dismiss brings the link back**
- Ticket/AC: §8.3c "a later final failure raises it again". Type: AC. Priority: P1.
- Steps: on the dismissed U-EMPTY link, row menu → "Extract context".
- Expected: after the job, the link is back in Needs attention with the same reason.
- Video: **yes**.

**NA-25: Dismiss during a running retry stays dismissed after it fails**
- Ticket/AC: S4 round 3 (Dismiss vs settlement race). Type: race. Priority: P2.
- Fixtures: FIX-SLOT1. Occupy the slot with U-SLOW so the retry stays queued or running. The link has attention (e.g. U-FILE).
- Steps: click Retry; while it runs, row menu → "Dismiss from Needs attention" (the menu item stays available; the inline buttons are hidden).
- Expected: when the retry fails, the link stays out of Needs attention, also after a reload.
- Note: the exact interleaving (Dismiss between the read and the write) is covered by `tests/attention.test.ts`. This manual case only checks the user-level order.
- Video: no (timing-sensitive; the race itself is harness-only).

**NA-26: Guard: no Retry or Dismiss buttons while a job is active; the API refuses**
- Ticket/AC: repro I; FAC-48 manual QA 11. Type: AC. Priority: **P0**.
- Fixtures: FIX-SLOT1. A link with attention gets a queued retry behind U-SLOW.
- Steps: look at the row while the retry is queued; then `curl -XPOST …/links/<id>/retry` and `…/use-preview`.
- Expected:
  - Inline Retry, Use preview and Dismiss are hidden. The menu has no "Retry preview" or "Fetch preview".
  - Both API calls return 400 `{"error":"Wait for the running job to finish."}`.
  - There is still exactly one active job.
- Video: **yes** (UI plus a terminal overlay of the API response).

**NA-27: Re-extract with previous content: the failure stays out of Needs attention**
- Ticket/AC: §7 "Re-extract falla con contenido previo"; repro E; S4 round 2. Type: AC. Priority: **P0**.
- Fixtures: import U-EMPTY, cancel it, paste "QA previous version" (content ready, manual), then row menu → "Extract context".
- Expected:
  - The job fails (`empty`). The link is **not** in Needs attention (neither preview nor content).
  - Inspector shows "Last extraction failed, showing the previous version: The page returned no content. You can paste it manually." above the pasted text.
  - During the job, the inspector reads "Updating extraction… showing saved content".
  - Activity lists the failed job with that reason.
- Verify: `content_key` and `content_version` are unchanged; `attention_kind:null`.
- Video: **yes**.

**NA-28: A failed re-extract with a failing preview keeps the old preview**
- Ticket/AC: repro C; S3. Type: edge case. Priority: P1.
- Fixtures: needs a site that worked and now returns 403 or 429. Covered by `tests/retries.test.ts` and `tests/attention.test.ts` C.
- Expected: title and image are kept. No attention. The Activity job note reads "No preview: …".
- Video: no.

**NA-29: Cancelling a retry restores the previous failure, not neutral**
- Ticket/AC: §7 "Cancelar un batch"; repro F; S4. Type: AC. Priority: P1.
- Fixtures: FIX-SLOT1. The U-EMPTY content-failed link, with the slot held by U-SLOW.
- Steps: click Retry (content-only, queued); cancel that batch from Activity (or the toast) before it runs.
- Expected: the row returns to "Context failed" and stays in Needs attention with the same reason. No flicker to neutral.
- Video: **yes** (chapter 6).

**NA-30: Reload and reprocess give an identical view**
- Ticket/AC: FAC-48 **AC4**. Type: AC. Priority: **P0**.
- Steps:
  1. Note the Needs attention list and counter.
  2. Reload.
  3. Re-extract one listed link that fails the same way, and reload again.
- Expected: the same members, reasons and counter every time. `attention_at` is unchanged when the state didn't change.
- Verify: diff of the `/api/library` attention fields before and after.
- Video: **yes** (short; at the end of chapter 2).

**NA-31: An interrupted job (Worker restart) is neutral, never failed**
- Ticket/AC: repro H; S1, S4, S10. Type: race. Priority: P1.
- Fixtures: FIX. Save U-SLOW. While it is "Fetching preview", stop `bun run dev` (Ctrl-C), wait 10 s, and restart with the **same** `LINKLOG_PERSIST_TO`.
- Expected:
  - After the recovery tick (≤30 s) the job either resumes (same Workflow ID), or is marked failed/Interrupted in Activity.
  - The link is never in Needs attention: it ends ready, or neutral "No preview yet".
  - A link that already had attention keeps it, and Retry still recovers it.
- Video: no (needs a process kill at a precise moment; the local Workflow restart behaviour is not deterministic).

**NA-32: Link deletion and the counter**
- Ticket/AC: §8.1 "clears on delete". Type: edge case. Priority: P2.
- Steps: delete a link in Needs attention. Expected: the counter decrements, and the item disappears at 0.
- Video: no.

### 1.4 Migrations 0012–0018 on existing data

Procedure for MG-02 to MG-05 (local only; never `--remote`):

1. Build a "main-era" D1. Copy `migrations/0001…0011` into `qa/tmp/migrations-main/`, make `qa/wrangler.main.jsonc` with `migrations_dir` pointing there, and apply them with `wrangler d1 migrations apply linklog --local --persist-to $P -c qa/wrangler.main.jsonc`.
2. Seed histories with `wrangler d1 execute --local --persist-to $P --file qa/tmp/seed.sql`. Use rows modelled on the fixtures in `tests/attention.test.ts` (`histories(true)`, pre-0012 schema: no `preview_reason`/`reason`/`adapter`).
3. Snapshot what main would show: `status='failed' OR content_state='failed'`.
4. Run `bun run dev` on the **same** `$P` with the branch config (applies 0012–0018).
5. Compare against the expected table below.

**MG-01: A fresh database applies 0001–0018**
- Ticket/AC: CR (0018); release hygiene. Type: migration. Priority: **P0**.
- Expected: `bun run dev` with an empty persist dir logs 18 migrations applied and the app loads. `PRAGMA integrity_check` returns ok.
- Video: no.

**MG-02: The upgrade backfills attention from settled history**
- Ticket/AC: FAC-48 manual QA 12; S4 rounds 3–4. Type: migration. Priority: **P0**.
- Seeded histories and expected result after the upgrade:

| History (pre-upgrade) | Main showed | Expected after upgrade |
|---|---|---|
| Last extract `failed` (not Cancelled/Interrupted), no content | Context failed | content attention; reason NULL → "Couldn't get the content: Something went wrong." |
| `status='failed'` from the last done extract's preview, content ready | No preview | preview attention "Couldn't get the preview: Something went wrong." |
| Fresh `pending`, extract queued or running | (virtual failed after 30 s) | neutral, processing |
| Cancelled import (`pending`, `missing`) | No preview after 30 s | neutral "No preview yet" |
| Interrupted fresh job | Context failed (pre-S1) | **no** attention (the stored `content_state='failed'` remains: accepted limit) |
| Failed re-extract(s) that kept earlier content (done earlier, or `content_updated_at` < job) | Context failed or No preview | neutral |
| Genuine failure, then a running retry | Context failed | content attention kept |
| Genuine done preview failure, then an interrupted retry that saved content, then a failed re-extract | No preview | preview attention kept |
| Failed preview fetched outside the queue (`metadata_started_at`), no later extract | No preview | preview attention |

- Verify: `/api/library` attention fields, plus the UI list and counter.
- Video: no (DB seeding; deterministic but not a user story; the upgrade tests cover it too).

**MG-03: Accepted ambiguous legacy cases are documented, not "fixed"**
- Ticket/AC: FAC-48 comment, "Accepted known limits". Type: migration. Priority: P2.
- Cases: `fixedThenKept` (pre-0012 fixed preview, then a failed re-extract that kept content) → preview attention with "Something went wrong.". A legacy job that failed in the preview step → content attention (its Retry re-runs content). Content with NULL `content_updated_at` is not counted as kept.
- Expected: matches the accepted behaviour; file nothing as a bug.
- Video: no.

**MG-04: Upgrading with work in flight**
- Ticket/AC: S4 QA 15 and 17. Type: migration, race. Priority: P1.
- Seed: a running extract whose post-0012 job has `preview_reason` set; and a content-failed link with a re-extract running.
- Expected: the first is not in Needs attention until its job ends with a final failure. The second stays in Needs attention during the run.
- Video: no.

**MG-05: Index 0018 is used by the active-job lookups**
- Ticket/AC: CR finding 3. Type: migration. Priority: P2.
- Steps: `wrangler d1 execute --local … --command "EXPLAIN QUERY PLAN SELECT 1 FROM jobs WHERE link_id='x' AND status IN ('queued','running','waiting')"`.
- Expected: `USING INDEX jobs_link_status` (no `SCAN jobs`).
- Video: no.

**MG-06: A stale pre-consolidation 0014 must be reset**
- Ticket/AC: FAC-48 comment "Before you start". Type: migration. Priority: P2.
- Expected: the doc and README warn about it. Any local state that ran the early 0014/0015 is discarded (always use a fresh `LINKLOG_PERSIST_TO`). Nothing to fix in code.
- Video: no.

---

## 2. FAC-52: Jev configuration preflight

ACs:
- **52-AC1**: with no key, no job, Workflow or usage row is created, and the user sees why.
- **52-AC2**: repro J becomes a regression test.

Profile **NOKEY** unless stated. Prepare 2 ready links (content via paste, so no Browser Rendering is needed) and one tag ("QA tag").

**JC-01: Selection bar Auto-tag and Lens are disabled, with the reason**
- Ticket/AC: 52-AC1. Type: AC. Priority: **P0**.
- Steps: select a ready link; hover Auto-tag, then Lens.
- Expected: both are disabled. The tooltip reads "Jev is not configured: API key missing.".
- Video: **yes**.

**JC-02: Inspector Re-evaluate and lens "Run again" are disabled**
- Ticket/AC: 52-AC1. Type: AC. Priority: P1.
- Fixtures: a link with an earlier lens result (create it under FIX, then restart the same persist dir under NOKEY).
- Expected: Inspector → Analysis shows Re-evaluate disabled with the tooltip "Jev is not configured: API key missing.". The per-lens "Run again" (on hover) is disabled too. Earlier results stay visible.
- Video: **yes**.

**JC-03: New lens: "run now" is disabled; saving still works**
- Ticket/AC: 52-AC1. Type: AC. Priority: P1.
- Steps: with 2 links selected, create a new lens.
- Expected: the "Run on the 2 selected links now" checkbox is disabled and unchecked, with the reason below it. Saving creates the lens, and no batch appears in Activity.
- Video: **yes**.

**JC-04: The API refuses and nothing is written**
- Ticket/AC: 52-AC1, 52-AC2. Type: AC. Priority: **P0**.
- Steps: `POST /api/batches {"kind":"autotag","ids":[…]}` and `{"kind":"lens","lens":"<id>","ids":[…]}`.
- Expected:
  - 400 `{"error":"Jev is not configured: API key missing."}`.
  - Activity shows no new batch, and Usage no new row.
  - The log has `{"event":"jev_not_configured","kind":"autotag",…}`.
- Verify: Activity, `/api/usage` count before and after.
- Video: **yes** (terminal overlay).

**JC-05: Extraction still works without Jev**
- Ticket/AC: S2 test 2. Type: regression. Priority: P1.
- Steps: Extract context on U-OK. Expected: ready content.
- Video: no (covered by other chapters).

**JC-06: A key removed between enqueue and run fails before Usage**
- Ticket/AC: S2 defence in depth. Type: race. Priority: P2.
- Steps: can't be done by hand without restarting the server under a different profile in the middle of a job. Covered by `tests/jev-config.test.ts` test 3.
- Expected: the job fails with the reason; 0 usage rows; not in Needs attention.
- Video: no.

**JC-07: Browser view without Jev**
- Ticket/AC: 52-AC1 (S2 round 2). Type: AC. Priority: P1.
- Fixtures: the Chrome extension (`bun run extension:chrome`) connected to the NOKEY dev server, with a browser lens on.
- Expected:
  - No new evaluations start. Tabs without a result read "Not evaluated" (hover shows the reason). The lens bar shows the reason with no spinner. Earlier results stay.
  - Disabled with the reason: row menu "Re-evaluate <lens>", sidebar and lens bar "Re-evaluate this window", Retry, Use title, the Inspector Re-evaluate icon and the selection bar Autogroup.
  - Activity shows no new browser batches.
- Video: no (needs the extension and a live Chrome profile).

**JC-08: Browser evaluations API refusal and replay**
- Ticket/AC: S2 round 2. Type: edge case. Priority: P2.
- Expected: `POST /api/browser/evaluations` with a new request id returns 400 `code:"jev-unavailable"`. A request id accepted earlier (while configured) still replays 200.
- Video: no (covered by `tests/browser-routes.test.ts`).

**JC-09: Other unconfigured providers**
- Ticket/AC: S2 test 4. Type: edge case. Priority: P2.
- Steps: `JEV_PROVIDER=fixture` without `ALLOW_FIXTURE_JEV`.
- Expected: the tooltip and API say "Jev is not configured." (no "API key" wording).
- Video: no.

---

## 3. FAC-53: per-link job queue

ACs:
- **53-AC1**: ready links run now, extracting links run when their extraction ends, the rest are skipped.
- **53-AC2**: a failed extraction resolves its waiting Jev job as "content missing", without a provider call.
- **53-AC3**: no link ever has two active jobs.

Profile **FIX-SLOT1** (one browser slot makes "extracting" last long enough to observe). Have the tag "QA tag".

**PQ-01: A mixed selection: ready links tag now, extracting links wait and then tag**
- Ticket/AC: 53-AC1. Type: AC. Priority: **P0**.
- Fixtures: 2 ready links (pasted content `jev:yes ready A`, `jev:no ready B`); then save U-SLOW plus `example.com` (extracting or queued).
- Steps: select all 4 → Auto-tag → confirm.
- Expected:
  - No error. Activity → Auto-tag shows 2 jobs done right away and 2 with a clock icon and "Waiting for extraction".
  - When each extraction ends, its auto-tag job runs by itself. Tags appear on all 4.
  - While waiting, those links count as processing (a "Tagging…" or "Extracting…" badge).
- Verify: `/api/batches/<autotag>` returns `status:"waiting"` with `waiting_for:"extract"`; then done.
- Video: **yes**.

**PQ-02: Links without content are reported as skipped**
- Ticket/AC: 53-AC1. Type: AC. Priority: **P0**.
- Fixtures: the U-EMPTY link (content failed) plus one ready link.
- Steps: select both → Auto-tag. The dialog explains "Auto-tag reads the page content. Extract it first and those links are auto-tagged as soon as it's ready…". Click **Auto-tag 1 with content**.
- Expected: the toast reads "Skipped 1 link without content". Only the ready link is tagged.
- Video: **yes**.

**PQ-03: "Extract, then auto-tag" chains both explicitly**
- Ticket/AC: 53-AC1; §7 (Jev never triggers extraction by itself). Type: AC. Priority: **P0**.
- Fixtures: a neutral cancelled-import link of `example.org` (no content) plus one ready link.
- Steps: select both → Auto-tag → **Extract, then auto-tag**.
- Expected: Activity shows an Extract context batch plus an Auto-tag batch whose job for that link is "Waiting for extraction". After the extraction, it tags.
- Video: **yes**.

**PQ-04: The extraction fails, so the waiting auto-tag ends "Content missing" for free**
- Ticket/AC: 53-AC2. Type: AC. Priority: **P0**.
- Fixtures: a neutral cancelled link of U-EMPTY (fallback **off**).
- Steps: select it → Auto-tag → Extract, then auto-tag.
- Expected:
  - The extraction fails, and the link enters Needs attention for **content only**.
  - The auto-tag job ends failed with "Content missing. Extract it first.".
  - Usage has **no** Jev row for it. The auto-tag failure itself is not in Needs attention.
- Verify: `/api/usage`; `attention_kind:"content"`.
- Video: **yes**.

**PQ-05: Auto-tag, then Lens on the same link run one after the other**
- Ticket/AC: 53-AC3 (per-link FIFO). Type: AC. Priority: **P0**.
- Fixtures: a ready link with content `jev:slow=8000 jev:yes` and a lens "QA lens".
- Steps: Auto-tag, then immediately apply the Lens.
- Expected: the Lens job shows "Waiting for auto-tag" while the auto-tag runs, then runs and shows its verdict.
- Verify: the DB invariant query (§0.4) returns no rows at any time.
- Video: **yes**.

**PQ-06: Cancel an auto-tag batch that is waiting on an extraction**
- Ticket/AC: S6 QA 4. Type: AC. Priority: P1.
- Steps: during PQ-01's wait, Activity → Auto-tag batch → Cancel batch.
- Expected: the toast reads "Cancelled N queued jobs". The waiting jobs show "Cancelled". The extraction finishes normally, and nothing else runs.
- Video: **yes** (chapter 4).

**PQ-07: Cancelling an extract batch cancels the Jev work waiting on it**
- Ticket/AC: FAC-53 and FAC-55 cascade. Type: AC. Priority: **P0**.
- Fixtures: FIX-SLOT1. Slot held by U-SLOW; queue `example.net`; Auto-tag it via "Extract, then auto-tag".
- Steps: cancel the Extract context batch from its toast (or from Activity).
- Expected:
  - The toast reads "Cancelled 1 queued job, and 1 waiting for that extraction". Both jobs show "Cancelled".
  - Nothing runs later (check after one recovery tick). The link stays neutral.
  - An existing link's content would stay untouched.
- Video: **yes**.

**PQ-08: Lens with only no-content links is disabled**
- Ticket/AC: S6 QA 5. Type: AC. Priority: P1.
- Steps: select 2 neutral links → hover Lens.
- Expected: disabled, with the tooltip "2 of 2 links need context first". With 1 ready and 1 neutral: enabled, with the tooltip "1 of 2 links have no content and will be skipped".
- Video: **yes**.

**PQ-09: Large selection: chunks past a wholly skipped first 100**
- Ticket/AC: S6 round 2 item 2. Type: edge case. Priority: P2.
- Fixtures: 100 neutral links plus 1 ready (seed with `/api/import` and cancel, or by SQL).
- Expected: the eligible link is tagged, and the toast reports "Skipped 100 links without content".
- Video: no (setup volume; covered by `submitInChunks` tests).

**PQ-10: Waiting counts as busy for one-off edits**
- Ticket/AC: S6 round 2 item 3. Type: edge case. Priority: P1.
- Steps: while a job on the link is "Waiting for …", call PUT content, PATCH tags, `/retry` and `/use-preview`.
- Expected: each returns "Wait for the running job to finish.".
- Video: no (API only).

**PQ-11: Extraction or preview on a busy link is refused, not queued**
- Ticket/AC: FINAL finding 2 (README); S6 decision. Type: edge case. Priority: P1.
- Steps: while a link has an auto-tag running, row menu → Extract context (or `POST /api/batches` extract).
- Expected: an error toast; no waiting extract is created.
- Video: no.

**PQ-12: An orphaned waiting job is promoted by recovery**
- Ticket/AC: FAC-53 design 2. Type: race. Priority: P2.
- Steps: needs a waiting job with no active predecessor (kill the dev server during a promotion). Covered by `tests/job-queue.test.ts` "recover promotes an orphan once".
- Expected: promoted and run exactly once.
- Video: no.

---

## 4. FAC-54: Jev retries by phase and batch stop

ACs:
- **54-AC1**: a transient R2 error is retried once, without a duplicate provider call.
- **54-AC2**: a provider 5xx is not retried; Activity shows "may have been billed"; manual retry works.
- **54-AC3**: a balance or auth error on the first job stops the rest of the batch, with zero further calls.

**JP-01: An invalid key stops the batch after one call**
- Ticket/AC: 54-AC3. Type: AC. Priority: **P0**.
- Fixtures: profile **BADKEY**; 3 ready links (pasted content); the tag "QA tag".
- Steps: select the 3 → Auto-tag; open Activity.
- Expected:
  - One job: "Jev refused the request: check the API key or the account balance. It may have been billed.".
  - The other two: "Stopped before calling Jev (no cost): Jev refused an earlier request in this batch. Check the API key or the account balance.".
  - Usage has exactly **one** Jev row. No link enters Needs attention.
  - Log: `jev_step_failed` (`phase:"sent"`, `reason:"account"`, `http_status:401`) and `jev_batch_stopped`.
- Verify: UI, `/api/usage`, log.
- Video: **yes** (one real 401 request, no cost; document it in the manifest).

**JP-02: Batch Retry after fixing the configuration runs all 3**
- Ticket/AC: 54-AC3 (manual retry); FAC-54 QA 3. Type: AC. Priority: **P0**.
- Steps: stop dev; restart the **same** persist dir under **FIX** (stands in for "key fixed"; a real valid key would cost money); Activity → the failed batch → **Retry failed** icon.
- Expected: the toast reads "Retrying". A new Auto-tag batch runs all 3 to done. Usage gets 3 new rows.
- Video: **yes**.

**JP-03: A provider error is not retried; manual Retry works**
- Ticket/AC: 54-AC2. Type: AC. Priority: **P0**.
- Fixtures: FIX; a ready link with pasted content `jev:fail QA`.
- Steps:
  1. Apply the Lens.
  2. In Activity, read the job.
  3. Paste new content without the marker, then click the job's **Retry**.
- Expected:
  - "Jev returned an error (may have been billed)." after **one** attempt (no "Attempt 2 of 2"). One failed Jev Usage row. Not in Needs attention.
  - Retry creates a new batch that succeeds.
- Verify: `/api/batches/<id>` returns `attempt:1`; log `jev_step_failed` with `phase:"sent"` and `reason:"provider_error"`.
- Video: **yes**.

**JP-04: A double-clicked batch Retry enqueues once**
- Ticket/AC: CR finding 2. Type: race. Priority: P1.
- Fixtures: FIX; a lens batch of 3 links with `jev:fail` content, all failed. Change their content to plain text.
- Steps: click **Retry failed** twice quickly (or send two concurrent `POST /api/batches/<id>/retry` with curl `&`).
- Expected:
  - One new batch with 3 jobs. The second click gives the toast "These links were already retried.".
  - After success, Retry on the original batch again gives "These links were already retried." and no new Jev Usage rows.
- Video: **yes** (the UI double-click is deterministic enough; assert the batch count).

**JP-05: "Nothing to retry" for an all-cancelled batch**
- Ticket/AC: S8 test 9. Type: edge case. Priority: P2.
- Expected: a batch with only cancelled jobs shows no Retry icon. The API answers "Nothing to retry.".
- Video: no.

**JP-06: Pre-call failures write no Usage row and are retried once**
- Ticket/AC: 54-AC1. Type: AC. Priority: P1.
- Fixtures: transient R2 or D1 errors can't be injected in `wrangler dev`. Covered by `tests/jev-phases.test.ts` ("R2 transient read error → retried once, 1 provider call, 1 usage row"; "D1 conflict" shows "Attempt 2 of 2 · Waiting to retry" with "Previous attempt: Failed before calling Jev (no cost): saved data was briefly unavailable.").
- Manual proxy: PQ-04 ("Content missing", no Usage row).
- Video: no.

**JP-07: The stop applies to the same batch only**
- Ticket/AC: FAC-54 "Batch stop"; S7. Type: edge case. Priority: P1.
- Fixtures: BADKEY. Link L1 has an auto-tag running (batch A); a Lens batch B on L1 is waiting behind it.
- Expected: A's 401 stops A's remaining jobs. B is promoted and makes its own call (and stops itself).
- Verify: `/api/batches` for A and B; Usage has 2 rows.
- Video: no (API timing; covered by `tests/jev-phases.test.ts`).

**JP-08: Normal Jev runs record one Usage row per call**
- Ticket/AC: FAC-54 QA 5. Type: regression. Priority: **P0**.
- Steps: FIX, auto-tag 3 links. Expected: 3 done jobs and 3 Jev Usage rows. The batch toast reads "Auto-tagged 3 links".
- Video: no (covered inside JP-02).

**JP-09: Uncertain outcomes are never resent**
- Ticket/AC: S7 known limit. Type: race. Priority: P2.
- Expected: an engine interruption after sending gives "The Jev call was interrupted (may have been billed)." with no second call. This is test-only (`tests/jev-phases.test.ts` "engine timeout after send").
- Video: no.

**JP-10: Jev telemetry**
- Ticket/AC: S7. Type: AC. Priority: P1.
- Expected: `jev_step_failed` has `job_id, batch_id, link_id, kind, provider, attempt, max_attempts, final, phase, reason, retryable, http_status, detail`; `jev_batch_stopped` after JP-01.
- Video: no.

---

## 5. FAC-55: cancel one job from Activity

ACs:
- **55-AC1**: cancelling a running extraction stops the Workflow, keeps previous content, or stays neutral.
- **55-AC2**: its waiting Jev jobs are cancelled in the same action, and the UI says so.
- **55-AC3**: cancelled links never appear in Needs attention.

Profile **FIX** unless stated.

**CJ-01: Cancel a running extraction with two dependents**
- Ticket/AC: 55-AC1, 55-AC2, 55-AC3. Type: AC. Priority: **P0**.
- Fixtures: U-SLOW (`/delay/10`), so the preview step stays running for about 10 s.
- Steps:
  1. Save it.
  2. Immediately select it → Auto-tag → Extract, then auto-tag (or Auto-tag while it is extracting), then apply a Lens.
  3. In Activity, hover the ✕ of the running extract job (tooltip "Cancel (also cancels what waits for it)") and click it.
- Expected:
  - The toast reads "Cancelled, and 2 waiting for that extraction". The Extract, Auto-tag and Lens jobs show "Cancelled" (muted, no Retry).
  - The link is not processing and not in Needs attention. It shows "No preview yet" (the preview didn't finish).
  - Log: `job_cancelled` with `dependents: 2`.
  - After one recovery tick, nothing has been resurrected.
- Video: **yes**.

**CJ-02: Cancelling a running re-extract keeps the previous content**
- Ticket/AC: 55-AC1. Type: AC. Priority: **P0**.
- Fixtures: a link with pasted content "QA v1" (version 1) whose URL is U-SLOW.
- Steps: Re-extract context; while "Fetching preview" is running, ✕ it.
- Expected: the inspector still shows "QA v1". `content_version` is unchanged. The link is not in Needs attention.
- Video: **yes**.

**CJ-03: Cancel a queued or waiting Jev job; the next one is promoted**
- Ticket/AC: S8 QA 3. Type: AC. Priority: P1.
- Fixtures: a ready link with `jev:slow=8000`. Start Auto-tag, Auto-tag again, then a Lens.
- Steps: ✕ the second Auto-tag (waiting).
- Expected: only that one is "Cancelled"; the toast reads "Cancelled". After the first auto-tag ends, the Lens runs. Cancelling the queued one instead starts the next job right away.
- Video: **yes**.

**CJ-04: Cancel a Lens during its Jev call**
- Ticket/AC: 55-AC1 (paid call). Type: AC. Priority: **P0**.
- Fixtures: a ready link with content `jev:slow=30000 jev:yes`.
- Steps: apply the Lens; while Activity shows it running ("Evaluating with Jev"), ✕ it.
- Expected:
  - The job error reads "Cancelled after calling Jev (may have been billed).". A Jev Usage row exists (marked failed).
  - No lens result is stored, and nothing is resent after a recovery tick.
  - The batch shows `cancelled 1, failed 0`.
- Verify: `/api/usage`; `lens_results` empty for that link.
- Video: **yes**.

**CJ-05: Cancel a Jev job before its call**
- Ticket/AC: 55-AC1. Type: AC. Priority: P1.
- Steps: ✕ a Lens job while it is "Queued" or "Waiting for auto-tag".
- Expected: plain "Cancelled". No Usage row for it.
- Video: **yes** (combined with CJ-03).

**CJ-06: Cancelling a job that already finished**
- Ticket/AC: S8 QA 5. Type: edge case. Priority: P1.
- Steps: copy a job id while it runs; after it is done, `curl -XDELETE …/api/jobs/<id>`. In the UI, click ✕ just as the job finishes.
- Expected: 409 with `"error":"This job already finished."`; the UI toast reads "This job already finished.". An unknown id returns 404.
- Video: **yes** (API overlay; the UI timing is best effort).

**CJ-07: Cancel, then immediately re-extract the same link**
- Ticket/AC: FAC-48 QA 24; S10 fix. Type: race. Priority: **P0**.
- Fixtures: U-SLOW link.
- Steps: ✕ the running extract; right away, row menu → Extract context.
- Expected: the link shows "Extracting…" and stays processing until the **new** job ends. Lens and Auto-tag stay enabled for it. It ends ready. The old job stays "Cancelled".
- Verify: `/api/library` returns `content_state:"queued"` until the successor settles.
- Note: the held-status recovery race is test-only (`tests/cancel-job.test.ts:463`). Hosted check: HO-05.
- Video: **yes** (user-level flow).

**CJ-08: Late writes from a cancelled job are fenced**
- Ticket/AC: S8 round 2. Type: race. Priority: P1.
- Steps: cancel a fresh link's extract while it is at "Extracting content" (Browser Rendering in flight); wait 90 s.
- Expected: no content appears later. The link stays neutral, with no attention. The job stays "Cancelled".
- Video: no (long wait; the exact interleavings are covered by 7 harness tests).

**CJ-09: Cancelling a retry of a link already in Needs attention leaves it as it was**
- Ticket/AC: S8 test 2. Type: edge case. Priority: P1.
- Steps: as NA-29, but cancel the single job with ✕ instead of the batch.
- Expected: the row is identical: still in Needs attention, same reason. Cancel neither adds nor clears attention.
- Video: **yes** (chapter 6, together with NA-29).

**CJ-10: Batch counters and summaries**
- Ticket/AC: S8 (cancelled counted separately). Type: AC. Priority: P1.
- Expected: a batch with one cancelled job doesn't say "1 failed" and offers no Retry for it. A batch made only of cancelled jobs reads "Cancelled" (session toast "Cancelled"). Progress counts done + failed + cancelled.
- Video: **yes**.

**CJ-11: The terminate call fails on a live instance**
- Ticket/AC: S8 `stopWorkflow`. Type: edge case. Priority: P2.
- Expected: 400 "Could not stop this job. Try again."; the job is still running. Test-only.
- Video: no.

**CJ-12: Batch cancel from the toast and from Activity still works**
- Ticket/AC: FAC-55 QA 6. Type: regression. Priority: P1.
- Expected: "Cancelled N queued jobs", or "Nothing left to cancel" when nothing is left.
- Video: no (covered by NA-04 and PQ-07).

---

## 6. FAC-56: Settings and preview as content

ACs:
- **56-AC1**: with the setting on, a final content failure gets preview content automatically, can be auto-tagged, and isn't in Needs attention.
- **56-AC2**: with the setting off, the per-link action does the same on demand.
- **56-AC3**: "Retry getting content" replaces the fallback on success.

**PF-01: The Settings dialog is off by default and persists**
- Ticket/AC: FAC-56 (global setting). Type: AC. Priority: **P0**.
- Steps: sidebar footer → **Settings** (under Activity).
- Expected: title "Settings", "Applies to the whole library.", and the checkbox "If the content can't be extracted, use the preview for Jev", **unchecked**. Check it and reload: still checked. `/api/library` returns `settings.preview_fallback:true`.
- Video: **yes**.

**PF-02: Automatic fallback on a final content failure**
- Ticket/AC: 56-AC1. Type: AC. Priority: **P0**.
- Fixtures: FIX, setting **on**; U-EMPTY.
- Expected:
  - Never in Needs attention, while running or after. No "Context failed" badge.
  - Inspector header: "… · Content extracted from preview · Partial".
  - Content tab box "Content extracted from preview" with the text "Only the title and description are saved, because the page content couldn't be extracted: The page returned no content. You can paste it manually." and **Retry getting content**. The body is the title (and description).
  - Activity: the job is failed with that reason, and below it "Used the preview as content instead.".
- Verify: `content_source:"preview", content_state:"partial", attention_kind:null, content_reason:"empty"`.
- Video: **yes**.

**PF-03: The fallback link can be auto-tagged, and Jev sees only title and description**
- Ticket/AC: 56-AC1. Type: AC. Priority: **P0**.
- Steps: auto-tag the PF-02 link.
- Expected: it gets a score. `GET /api/links/<id>/content` returns only the title and description, with no "from preview" label.
- Video: **yes**.

**PF-04: Retry getting content fails and keeps the fallback**
- Ticket/AC: 56-AC3 (failure path). Type: AC. Priority: P1.
- Steps: click **Retry getting content** (U-EMPTY fails again).
- Expected: during the run, "Updating extraction… showing saved content"; the button is disabled. Afterwards the preview content stays, there is no attention, and the box remains.
- Video: **yes**.

**PF-05: Retry getting content success replaces the fallback**
- Ticket/AC: 56-AC3. Type: AC. Priority: P1.
- Fixtures: a URL that fails and later works isn't available deterministically. Covered by `tests/preview-fallback.test.ts:127`. Hosted or manual option: a flaky real site.
- Expected: `web`/`ready` content; the box disappears; the error is cleared.
- Video: no.

**PF-06: With the setting off, Use preview works on demand**
- Ticket/AC: 56-AC2. Type: AC. Priority: **P0**.
- Fixtures: setting **off**; U-EMPTY.
- Expected: the row reads "Couldn't get the content: The page returned no content. You can paste it manually." with **Retry**, **Use preview** (tooltip "Save the title and description as the content, so Jev can use it") and **Dismiss**. The menu also has "Use preview as content". Clicking Use preview removes the link from the list and decrements the counter; the inspector shows the preview box.
- Video: **yes**.

**PF-07: No fallback when the preview also failed**
- Ticket/AC: FAC-56 "If the preview also failed there's nothing to use". Type: AC. Priority: **P0**.
- Fixtures: setting **on**; U-DNS.
- Expected: it enters Needs attention as usual (content). No Use preview button or menu item. `POST /use-preview` answers "There is no preview to use.".
- Video: **yes**.

**PF-08: Never while running**
- Ticket/AC: FAC-56 "never while queued/running/waiting". Type: AC. Priority: P1.
- Steps: with a content retry queued or running (FIX-SLOT1), check the row and call `POST /use-preview`.
- Expected: Use preview is hidden; the API answers "Wait for the running job to finish.". With the setting on, a transient failure still being retried shows no fallback until the final failure.
- Video: no (API; NA-26 shows the UI guard).

**PF-09: Previous content wins over the fallback**
- Ticket/AC: FAC-56; §7. Type: AC. Priority: P1.
- Steps: setting on; repeat NA-27 (a link with pasted content, then a failed re-extract).
- Expected: the pasted content is kept, not replaced by the preview. "Last extraction failed, showing the previous version: …".
- Video: **yes**.

**PF-10: Use preview only after a final content failure**
- Ticket/AC: S5 round 2. Type: edge case. Priority: P1.
- Steps: import, cancel, then Fetch preview (preview ready, content never tried).
- Expected: no Use preview. The API answers "The content hasn't failed; extract it first.". A content failure that you Dismiss still accepts `POST /use-preview` (200).
- Video: no (API).

**PF-11: Paste over the fallback**
- Ticket/AC: S5. Type: edge case. Priority: P2.
- Expected: pasting into a fallback link gives `manual`/`ready` (not Partial), and the box disappears.
- Video: no.

**PF-12: Turning the setting on doesn't backfill existing failures** (accepted limit)
- Ticket/AC: FAC-56 known limits. Type: edge case. Priority: P2.
- Expected: links already in Needs attention stay there after the setting is turned on. Use the per-link action for them.
- Video: no.

**PF-13: The stored preview object is removed when the settlement doesn't use it**
- Ticket/AC: CR finding 6. Type: race. Priority: P2.
- Expected: test-only (`tests/preview-fallback.test.ts` "turning the setting off while the failure settles…"). Locally, R2 has no `links/<id>/<job>-preview.md` after a refused fallback.
- Video: no.

**PF-14: A cancelled "Retry getting content" restores Partial**
- Ticket/AC: S5. Type: edge case. Priority: P2.
- Steps: FIX-SLOT1; queue Retry getting content behind U-SLOW; cancel it.
- Expected: it is back to preview content, "Partial", with no attention.
- Video: no.

---

## 7. FAC-57: login walls and block pages

ACs:
- **57-AC1**: each wall pattern is detected and discarded; a long article mentioning sign-in is not.
- **57-AC2**: the behaviour with and without previous content follows the rules.
- **57-AC3**: detection events appear in Workers Logs (hosted part: HO-03).

All these cases call Browser Rendering once per extraction.

**LW-01: A wall with no previous content enters Needs attention; the text is discarded**
- Ticket/AC: 57-AC1, 57-AC2. Type: AC. Priority: **P0**.
- Fixtures: setting off; U-WALL-JAM.
- Expected:
  - The row keeps the title "QA wall" and reads "Couldn't get the content: Got a login page instead of the content." with Retry, Use preview and Dismiss.
  - Activity: the job failed after **one** attempt.
  - No content is stored (`content_key` null).
  - Log: `login_wall_detected` (`domain:"httpbin.org"`, `pattern`, `text_length`) and `link_step_failed` with `reason:"login_wall"`, `retryable:false`, `final:true`. No full URL in any log line.
- Video: **yes**.

**LW-02: Sign-in form wall**
- Ticket/AC: 57-AC1. Type: AC. Priority: P1.
- Fixtures: U-WALL-SIGNIN. Expected: as LW-01.
- Video: no (same UI as LW-01; check the log only).

**LW-03: Other patterns**
- Ticket/AC: 57-AC1. Type: AC. Priority: P1.
- Fixtures: the U-WALL-* pages (Access denied, CAPTCHA instruction, Google unusual traffic, "You have been blocked").
- Expected: each gives `login_wall` with its own `pattern` label in the log.
- Video: no (four Browser Rendering calls; unit tests cover all 12+ fixtures).

**LW-04: A wall on a link with previous content keeps that content**
- Ticket/AC: 57-AC2. Type: AC. Priority: **P0**.
- Fixtures: U-WALL-JAM imported and cancelled; paste "QA good content"; then Extract context.
- Expected: the inspector shows "QA good content" with "Last extraction failed, showing the previous version: Got a login page instead of the content.". Not in Needs attention. Activity shows the failed job. `content_version` is unchanged.
- Video: **yes**.

**LW-05: Wall plus preview fallback**
- Ticket/AC: 57-AC2 + 56-AC1. Type: AC. Priority: **P0**.
- Fixtures: setting **on**; a new U-WALL-JAM variant (change the `<title>`, so the link is new).
- Expected:
  - Preview content ("Content extracted from preview · Partial"), not in Needs attention.
  - Activity shows "Got a login page instead of the content." plus "Used the preview as content instead.".
  - The stored text has none of the wall text.
- Video: **yes**.

**LW-06: A long article with a "Sign in" header link is kept**
- Ticket/AC: 57-AC1 (negative). Type: AC. Priority: **P0**.
- Fixtures: U-LONG-SIGNIN (or a real news article).
- Expected: ready content; no `login_wall_detected` event.
- Video: **yes**.

**LW-07: Short legitimate pages mentioning the words in prose are kept**
- Ticket/AC: S9 round 2. Type: edge case. Priority: P1.
- Fixtures: U-PROSE.
- Expected: ready content, no event.
- Video: no.

**LW-08: Known limits are not bugs**
- Ticket/AC: FAC-57 known limits. Type: edge case. Priority: P2.
- Cases: an X-style username-only first step; wall text over 1,500 characters; a 404 or 503 error body returned as content (e.g. U-503's content).
- Expected: saved as content. Record any of these observed in real use as telemetry input, not as defects.
- Video: no.

**LW-09: Real-world walls**
- Ticket/AC: FAC-57 QA 1. Type: edge case. Priority: P2.
- Fixtures: `https://www.instagram.com/accounts/edit/`, a LinkedIn feed URL, a Cloudflare-challenged site.
- Expected: as LW-01 when the site serves a wall. Results depend on the site (non-deterministic).
- Video: no.

---

## 8. Cross-feature interactions

**X-01: A wall with fallback, then a waiting auto-tag runs on the preview text**
- Ticket/AC: FAC-53 + FAC-56 + FAC-57. Type: AC. Priority: P1.
- Fixtures: FIX; setting on; a new U-WALL-JAM variant saved and **immediately** auto-tagged ("Extract, then auto-tag").
- Expected: the auto-tag waits for the extraction, then runs on the fallback content (preview text counts as content). The link is not in Needs attention. One Jev Usage row.
- Video: **yes**.

**X-02: A wall without fallback, then a waiting auto-tag fails for free, then Use preview, then auto-tag**
- Ticket/AC: FAC-53 AC2 + FAC-56 AC2 + FAC-57. Type: AC. Priority: P1.
- Expected:
  - The auto-tag ends "Content missing. Extract it first." with no Usage row. The link is in Needs attention (content, login_wall).
  - Use preview removes it from the list. A new auto-tag succeeds.
- Video: **yes**.

**X-03: Auto-tag and lens failures never enter Needs attention**
- Ticket/AC: FAC-48 decision §7; FAC-54. Type: AC. Priority: **P0**.
- Steps: after JP-01, JP-03, PQ-04 and CJ-04, check the Needs attention list.
- Expected: only extraction or preview failures are listed. Jev jobs labelled "Failed" or "Cancelled" add nothing.
- Video: no (asserted inside chapters 4 and 5).

**X-04: Cancelling an extraction of a link already in Needs attention, with dependents**
- Ticket/AC: FAC-55 + FAC-48. Type: edge case. Priority: P1.
- Expected: the dependents are cancelled; attention is untouched (same reason). `content_state` returns to `failed`.
- Video: no.

**X-05: Dismiss, then Use preview**
- Ticket/AC: FAC-56 round 2 decision. Type: edge case. Priority: P2.
- Expected: a dismissed content failure still accepts Use preview from the row menu (the menu shows "Use preview as content", since `content_state` is still `failed`).
- Video: no.

**X-06: A preview job and Jev on the same link**
- Ticket/AC: FAC-53 + scope 3. Type: edge case. Priority: P2.
- Steps: with an auto-tag running on a link whose preview failed, use the row menu.
- Expected: Retry preview is hidden (`processing`). `POST /retry` returns "Wait for the running job to finish.". No preview job is queued behind Jev.
- Video: no.

**X-07: Combined lifecycle (FINAL review "Lifecycle combinations")**
- Ticket/AC: all. Type: AC. Priority: P1.
- Expected: covered by the FINAL review's supplemental runs and `bun test`. Manual: run chapters 1–6 back to back on one persist dir, then reload and compare `/api/library` with the expected end state (counter, reasons, sources).
- Video: no (the chapters already cover it).

**X-08: Deleting a link with waiting or queued jobs**
- Ticket/AC: S6 (delete counts as a one-off edit). Type: edge case. Priority: P2.
- Expected: deleting is refused while jobs are active ("Wait for the running job to finish."), or succeeds with no orphan jobs left; record the actual behaviour.
- Video: no.

---

## 9. Regressions of pre-existing features

**RG-01: Automated suite**
- Type: regression. Priority: **P0**.
- `bun test`, repro, typecheck and build (§0.5). Video: no.

**RG-02: Add link, duplicate, paste many**
- Type: regression. Priority: **P0**.
- Expected: Add Link → "Link saved". The same URL again → "Already in your library". Pasting 3 URLs → "3 links saved". Invalid text → "Paste http or https links, separated by spaces or new lines.".
- Video: **yes** (opening of chapter 1).

**RG-03: Import**
- Type: regression. Priority: P1.
- Expected: `/api/import` (import dialog) saves the links, starts the Extract context batch and shows the toast progress "Extracting context for N links…" with "x of N done".
- Video: no (covered in NA-04).

**RG-04: Tags**
- Type: regression. Priority: P1.
- Expected: create a tag, Edit tags on a row, tag filter (AND semantics), delete a tag ("Tag deleted").
- Video: no.

**RG-05: Auto-tag happy path**
- Type: regression. Priority: **P0**.
- Expected (FIX): the "Auto-tag replaces existing tags" confirmation, then "Auto-tagged N links" with a cost/tokens description. Scores in the inspector.
- Video: no (inside JP-02 and PQ-01).

**RG-06: Lenses**
- Type: regression. Priority: **P0**.
- Expected: create a lens, apply it ("Lens applied to N links"), verdict on the row and in the inspector, Run again, delete ("Lens deleted").
- Video: no (inside PQ-05).

**RG-07: Usage panel**
- Type: regression. Priority: P1.
- Expected: Browser Rendering rows per extraction attempt, one Jev row per sent call, OCR rows for social. Totals match.
- Video: no.

**RG-08: Manual content**
- Type: regression. Priority: P1.
- Expected: paste or upload content, Markdown view, edit. `content_source:"manual"`.
- Video: no.

**RG-09: Social and YouTube adapters**
- Type: regression. Priority: P2.
- Expected: a YouTube link extracts a transcript (track menu "Choose original automatically"); an X or Instagram post extracts with media. Adapter errors show allowlisted plain messages only.
- Video: no (remote, non-deterministic).

**RG-10: Browser view and extension**
- Type: regression. Priority: P1.
- Expected: `bun run extension:chrome`; connect; tabs are captured; browser lens evaluations run (FIX); Autogroup; Save from Browser creates a link that goes through the normal extract (and no Needs attention while queued).
- Video: no (needs the extension).

**RG-11: Search, filters and domain filter**
- Type: regression. Priority: P2.
- Expected: the domain filter from a row ("Filter by domain"); context filters; the Needs attention filter combined with other filters.
- Video: no.

**RG-12: Delete link, tag and lens**
- Type: regression. Priority: P2.
- Expected: toasts "Link deleted", "Tag deleted", "Lens deleted"; R2 objects are removed with the link.
- Video: no.

**RG-13: Narrow or touch layout**
- Type: regression. Priority: P2.
- Expected: at 390 px width the row's Retry, Use preview and Dismiss stay reachable (actions visible with `hover:none`). The Activity ✕ is tappable.
- Video: no.

**RG-14: `bun run test:browser` (existing browser tests)**
- Type: regression. Priority: P1.
- Expected: pass. Video: no.

---

## 10. Hosted-only checks (after deploy)

Run these only after the owner deploys, and **apply remote migrations only after the local run of §1.4 passed**. Read-only observation of production; don't create bulk data.

**HO-01: Remote migrations**
- Ticket/AC: CR QA 2; FAC-48 "Before you start". Type: hosted-only. Priority: **P0**.
- Steps: `wrangler d1 migrations apply linklog --remote` applies 0012–0018 in order, then `EXPLAIN QUERY PLAN …` (MG-05).
- Expected: success; `USING INDEX jobs_link_status`.

**HO-02: Real library upgrade**
- Ticket/AC: FAC-48 QA 12. Type: hosted-only, migration. Priority: **P0**.
- Steps: before deploying, export the list of links showing "No preview" or "Context failed". After deploying, compare with the Needs attention list.
- Expected: the MG-02 rules hold. Any surprises are classified against the accepted ambiguous-legacy limits.

**HO-03: FAC-57 events in Workers Logs** (the 21st AC)
- Ticket/AC: 57-AC3. Type: hosted-only. Priority: **P0**.
- Steps: save U-WALL-JAM in production.
- Expected: Workers Logs show `login_wall_detected` with `domain`, `pattern` and `text_length`, and `link_step_failed` with `reason:"login_wall"`.

**HO-04: Other events**
- Ticket/AC: FAC-48 QA 27. Type: hosted-only. Priority: P1.
- Expected: `link_step_failed` (from U-503 or U-FILE), `job_cancelled` (from a cancel), and `jev_step_failed` / `jev_batch_stopped` if a Jev failure happens naturally. Fields as in NA-17 and JP-10. Only the domain is logged.

**HO-05: Real Workflow termination, then re-extract**
- Ticket/AC: FAC-55 AC1; S10. Type: hosted-only, race. Priority: **P0**.
- Steps: cancel a running extraction of a slow page; re-extract immediately.
- Expected: the old Workflow is terminated (Cloudflare dashboard shows the instance as terminated). The link stays processing until the successor settles, and ends ready.

**HO-06: Real backoff and timing**
- Ticket/AC: FAC-48 QA 28. Type: hosted-only. Priority: P1.
- Steps: save U-503.
- Expected: attempts spaced about 5 s, then about 10 s. Activity shows "Waiting to retry" between them. The Markdown retry, if it occurs, shows "Attempt 2 of 2".

**HO-07: Queue redelivery and cron recovery**
- Ticket/AC: FAC-48 QA 28. Type: hosted-only. Priority: P1.
- Expected: after a deploy restart in the middle of a job, the 5-minute cron `recover()` resends or recovers it. An interrupted job is neutral, not in Needs attention.

**HO-08: Queue wait under real Browser Rendering latency**
- Ticket/AC: FAC-48 QA 1 (the reported case). Type: hosted-only. Priority: **P0**.
- Steps: paste 8–10 real article URLs in production.
- Expected: no link enters Needs attention while waiting. All finish clean, apart from genuine failures with reasons.

**HO-09: Live sites and the Workers egress**
- Ticket/AC: FAC-48 QA 29. Type: hosted-only. Priority: P1.
- Expected: `medium.com` and the arxiv PDF classify as `blocked` and `not_html` with the agreed copy. Real walls are detected (LW-09). Watch the 403/429 rates.

**HO-10: Paid provider copy**
- Ticket/AC: FAC-48 QA 29; FAC-54. Type: hosted-only. Priority: P1.
- Expected: a real Jev call with a valid key records one Usage row with cost. The billing and authorization responses (if any occur naturally) match the JP-01 and JP-03 copy. Don't force a failure on the paid account.

---

## 11. Summary table

| ID | Title | Ticket | Type | Prio | Video |
|---|---|---|---|---|---|
| NA-01 | Queue wait > 30 s never enters Needs attention | FAC-48 | AC | P0 | yes |
| NA-02 | Reload during wait: still processing | FAC-48 | AC | P0 | yes |
| NA-03 | Activity says "Queued" | FAC-48 (S10) | regression | P2 | yes |
| NA-04 | Cancelled import is neutral | FAC-48 | AC | P0 | yes |
| NA-05 | Fetch preview is a queued job | FAC-48 | AC | P1 | yes |
| NA-06 | Busy-with-Jev pending link wording | FAC-48 (S1) | edge | P2 | no |
| NA-07 | Transient preview retry visible, enters only at the end | FAC-48 | AC | P0 | yes |
| NA-08 | 429 retried 3 times | FAC-48 | edge | P1 | no |
| NA-09 | DNS: both axes fail, content first | FAC-48 | edge | P1 | yes |
| NA-10 | File link fails fast with a reason | FAC-48 | AC | P0 | yes |
| NA-11 | 404/410 fail fast | FAC-48 | AC | P1 | no |
| NA-12 | 403 fails fast | FAC-48 | AC | P1 | no |
| NA-13 | Transient then success never shows attention | FAC-48 | AC | P0 | no |
| NA-14 | Markdown retry visible and metered | FAC-48 | AC | P1 | no |
| NA-15 | Timing line survives reload | FAC-48 | AC | P2 | no |
| NA-16 | Content failure, working preview | FAC-48 | AC | P0 | yes |
| NA-17 | Telemetry fields | FAC-48 | AC | P1 | no |
| NA-18 | Page reader unavailable copy | FAC-48 (CR1) | edge | P2 | no |
| NA-19 | Preview Retry keeps the row, no flicker | FAC-48 | AC | P0 | yes |
| NA-20 | Content-only Retry; paste resolves | FAC-48 | AC | P0 | yes |
| NA-21 | Both failed: preview takes over after paste | FAC-48 | edge | P1 | yes |
| NA-22 | Retry success clears the warning | FAC-48 | AC | P0 | no |
| NA-23 | Dismiss | FAC-48 | AC | P0 | yes |
| NA-24 | Same failure after Dismiss comes back | FAC-48 | AC | P1 | yes |
| NA-25 | Dismiss during a running retry | FAC-48 | race | P2 | no |
| NA-26 | Guard while a job is active | FAC-48 | AC | P0 | yes |
| NA-27 | Failed re-extract keeps previous content | FAC-48 | AC | P0 | yes |
| NA-28 | Failed re-extract keeps old preview | FAC-48 | edge | P1 | no |
| NA-29 | Cancelled retry restores the failure | FAC-48 | AC | P1 | yes |
| NA-30 | Reload/reprocess identical | FAC-48 | AC | P0 | yes |
| NA-31 | Interrupted job is neutral | FAC-48 | race | P1 | no |
| NA-32 | Deleting a link updates the counter | FAC-48 | edge | P2 | no |
| MG-01 | Fresh DB applies 0001–0018 | FAC-48/53/54 | migration | P0 | no |
| MG-02 | Upgrade backfill from settled history | FAC-48 | migration | P0 | no |
| MG-03 | Accepted ambiguous legacy cases | FAC-48 | migration | P2 | no |
| MG-04 | Upgrade with work in flight | FAC-48 | migration | P1 | no |
| MG-05 | 0018 index used | FAC-53 (CR3) | migration | P2 | no |
| MG-06 | Reset stale pre-consolidation 0014 | FAC-48 | migration | P2 | no |
| JC-01 | Selection bar disabled with reason | FAC-52 | AC | P0 | yes |
| JC-02 | Inspector Re-evaluate / Run again disabled | FAC-52 | AC | P1 | yes |
| JC-03 | New lens run-now disabled | FAC-52 | AC | P1 | yes |
| JC-04 | API 400, nothing written | FAC-52 | AC | P0 | yes |
| JC-05 | Extraction works without Jev | FAC-52 | regression | P1 | no |
| JC-06 | Key removed mid-run fails before Usage | FAC-52 | race | P2 | no |
| JC-07 | Browser view without Jev | FAC-52 | AC | P1 | no |
| JC-08 | Browser evaluations refusal/replay | FAC-52 | edge | P2 | no |
| JC-09 | Other unconfigured providers | FAC-52 | edge | P2 | no |
| PQ-01 | Mixed selection: ready now, extracting waits | FAC-53 | AC | P0 | yes |
| PQ-02 | No-content links skipped | FAC-53 | AC | P0 | yes |
| PQ-03 | Extract, then auto-tag | FAC-53 | AC | P0 | yes |
| PQ-04 | Failed extraction → Content missing, free | FAC-53 | AC | P0 | yes |
| PQ-05 | Auto-tag then Lens FIFO | FAC-53 | AC | P0 | yes |
| PQ-06 | Cancel waiting auto-tag batch | FAC-53 | AC | P1 | yes |
| PQ-07 | Cancel extract batch cascades | FAC-53/55 | AC | P0 | yes |
| PQ-08 | Lens disabled for no-content selection | FAC-53 | AC | P1 | yes |
| PQ-09 | >100 links past skipped chunks | FAC-53 | edge | P2 | no |
| PQ-10 | Waiting counts as busy | FAC-53 | edge | P1 | no |
| PQ-11 | Busy link refuses extraction | FAC-53 | edge | P1 | no |
| PQ-12 | Orphan waiting promoted by recovery | FAC-53 | race | P2 | no |
| JP-01 | Invalid key stops the batch | FAC-54 | AC | P0 | yes |
| JP-02 | Batch Retry after fix runs all | FAC-54 | AC | P0 | yes |
| JP-03 | Provider error not retried; manual Retry | FAC-54 | AC | P0 | yes |
| JP-04 | Double batch Retry enqueues once | FAC-54 (CR2) | race | P1 | yes |
| JP-05 | Nothing to retry | FAC-54 | edge | P2 | no |
| JP-06 | Pre-call retry once, no Usage | FAC-54 | AC | P1 | no |
| JP-07 | Stop applies to same batch only | FAC-54 | edge | P1 | no |
| JP-08 | One Usage row per call | FAC-54 | regression | P0 | no |
| JP-09 | Uncertain outcome never resent | FAC-54 | race | P2 | no |
| JP-10 | Jev telemetry | FAC-54 | AC | P1 | no |
| CJ-01 | Cancel running extract with 2 dependents | FAC-55 | AC | P0 | yes |
| CJ-02 | Cancel re-extract keeps content | FAC-55 | AC | P0 | yes |
| CJ-03 | Cancel queued/waiting Jev; next promoted | FAC-55 | AC | P1 | yes |
| CJ-04 | Cancel Lens mid-call: may have been billed | FAC-55 | AC | P0 | yes |
| CJ-05 | Cancel Jev before call | FAC-55 | AC | P1 | yes |
| CJ-06 | Cancel a finished job | FAC-55 | edge | P1 | yes |
| CJ-07 | Cancel then re-extract stays processing | FAC-55 (S10) | race | P0 | yes |
| CJ-08 | Late writes fenced | FAC-55 | race | P1 | no |
| CJ-09 | Cancel retry of attention link: unchanged | FAC-55 | edge | P1 | yes |
| CJ-10 | Batch counters with cancelled | FAC-55 | AC | P1 | yes |
| CJ-11 | Terminate failure | FAC-55 | edge | P2 | no |
| CJ-12 | Batch cancel regression | FAC-55 | regression | P1 | no |
| PF-01 | Settings default off, persists | FAC-56 | AC | P0 | yes |
| PF-02 | Automatic fallback | FAC-56 | AC | P0 | yes |
| PF-03 | Fallback auto-taggable, title+description only | FAC-56 | AC | P0 | yes |
| PF-04 | Retry getting content fails, keeps fallback | FAC-56 | AC | P1 | yes |
| PF-05 | Retry getting content success replaces | FAC-56 | AC | P1 | no |
| PF-06 | Setting off: Use preview | FAC-56 | AC | P0 | yes |
| PF-07 | No fallback when preview failed | FAC-56 | AC | P0 | yes |
| PF-08 | Never while running | FAC-56 | AC | P1 | no |
| PF-09 | Previous content wins | FAC-56 | AC | P1 | yes |
| PF-10 | Use preview only after a final failure | FAC-56 | edge | P1 | no |
| PF-11 | Paste over fallback | FAC-56 | edge | P2 | no |
| PF-12 | No backfill on enable | FAC-56 | edge | P2 | no |
| PF-13 | Unused preview object removed | FAC-56 (CR6) | race | P2 | no |
| PF-14 | Cancelled content retry restores Partial | FAC-56 | edge | P2 | no |
| LW-01 | Wall without previous content | FAC-57 | AC | P0 | yes |
| LW-02 | Sign-in form wall | FAC-57 | AC | P1 | no |
| LW-03 | Other patterns | FAC-57 | AC | P1 | no |
| LW-04 | Wall with previous content | FAC-57 | AC | P0 | yes |
| LW-05 | Wall + preview fallback | FAC-57/56 | AC | P0 | yes |
| LW-06 | Long article with Sign in kept | FAC-57 | AC | P0 | yes |
| LW-07 | Short prose pages kept | FAC-57 | edge | P1 | no |
| LW-08 | Known limits | FAC-57 | edge | P2 | no |
| LW-09 | Real-world walls | FAC-57 | edge | P2 | no |
| X-01 | Wall + fallback + waiting auto-tag | 53/56/57 | AC | P1 | yes |
| X-02 | Wall, free Content missing, Use preview, auto-tag | 53/56/57 | AC | P1 | yes |
| X-03 | Jev failures never in Needs attention | FAC-48/54 | AC | P0 | no |
| X-04 | Cancel extract on attention link with dependents | 48/55 | edge | P1 | no |
| X-05 | Dismiss, then Use preview | 48/56 | edge | P2 | no |
| X-06 | Preview job vs Jev on same link | 48/53 | edge | P2 | no |
| X-07 | Combined lifecycle | all | AC | P1 | no |
| X-08 | Delete link with active jobs | 53 | edge | P2 | no |
| RG-01 | Automated suite | all | regression | P0 | no |
| RG-02 | Add/duplicate/paste many | — | regression | P0 | yes |
| RG-03 | Import | — | regression | P1 | no |
| RG-04 | Tags | — | regression | P1 | no |
| RG-05 | Auto-tag happy path | — | regression | P0 | no |
| RG-06 | Lenses | — | regression | P0 | no |
| RG-07 | Usage panel | — | regression | P1 | no |
| RG-08 | Manual content | — | regression | P1 | no |
| RG-09 | Social/YouTube adapters | — | regression | P2 | no |
| RG-10 | Browser view and extension | — | regression | P1 | no |
| RG-11 | Search and filters | — | regression | P2 | no |
| RG-12 | Delete link/tag/lens | — | regression | P2 | no |
| RG-13 | Narrow/touch layout | — | regression | P2 | no |
| RG-14 | `test:browser` | — | regression | P1 | no |
| HO-01 | Remote migrations | 48/53 | hosted-only | P0 | no |
| HO-02 | Real library upgrade | FAC-48 | hosted-only | P0 | no |
| HO-03 | `login_wall_detected` in Workers Logs | FAC-57 | hosted-only | P0 | no |
| HO-04 | Other events in Workers Logs | all | hosted-only | P1 | no |
| HO-05 | Real termination + re-extract | FAC-55 | hosted-only | P0 | no |
| HO-06 | Real backoff timing | FAC-48 | hosted-only | P1 | no |
| HO-07 | Queue redelivery / cron recovery | FAC-48 | hosted-only | P1 | no |
| HO-08 | Queue wait under real latency | FAC-48 | hosted-only | P0 | no |
| HO-09 | Live sites / Workers egress | FAC-48/57 | hosted-only | P1 | no |
| HO-10 | Paid provider copy | FAC-54 | hosted-only | P1 | no |

Totals: **136 cases**. Priorities: 51 P0, 55 P1, 30 P2. Video: 57 yes, 79 no. By type: 65 AC, 28 edge, 9 race, 6 migration, 18 regression, 10 hosted-only (HO-02 is also a migration check).

---

## 12. Video chapters (proposed order)

Each chapter is one short QA story on **one** isolated persist dir and profile. It can be recorded independently, and is restarted only where noted. Every caption must be backed by an assertion (UI text and/or API field) per QA rules. Browser Rendering calls per chapter are listed so the cost is known up front.

### Chapter 1: "Waiting is not failing" (FAC-48 core, part 1). Profile FIX-SLOT1. About 7 Browser Rendering calls.
1. **RG-02**: Add link, "Link saved", duplicate "Already in your library". Fixtures: `example.com`.
2. **NA-01**: paste 6 URLs (U-SLOW ×2 + U-OK ×4); assert no Needs attention item for 60 s and `processing:true`. Hook: `BROWSER_CONCURRENCY=1`.
3. **NA-03**: Activity shows "Queued". Hook: none.
4. **NA-02**: reload at about 40 s; still "Fetching title and preview…". Hook: page reload.
5. **NA-04**: import 4 more URLs with U-SLOW first, Cancel from the toast; "No preview yet", "Not fetched yet · Fetch", "No context yet"; reload after 60 s. Hook: cancel before dispatch.
6. **NA-05**: Fetch preview on one cancelled link; "Fetch preview" batch, preview fills, no content.

### Chapter 2: "Failures that explain themselves" (FAC-48 core, part 2). Profile FIX, fallback off. About 6 calls.
1. **NA-07**: U-503; Activity "Attempt 2 of 3 · Waiting to retry" + "Previous attempt: The site had a problem."; not listed until done; then "Couldn't get the preview: The site had a problem.". Hooks: Activity open; `/api/batches` assert during backoff.
2. **NA-10**: U-FILE (robots.txt or arxiv PDF); one attempt; "This link is a file (like a PDF), not a web page.".
3. **NA-19**: Retry on the file row; "Fetch preview" batch, row stays listed, counter unchanged, same reason after the retry.
4. **NA-16**: U-EMPTY; "Couldn't get the content: The page returned no content. You can paste it manually." with Retry / Use preview / Dismiss.
5. **NA-20**: content-only Retry starts at "Extracting content"; then Paste text removes it from the list.
6. **NA-09 → NA-21**: U-DNS (both axes); paste; the preview reason takes over.
7. **NA-23 → NA-24**: Dismiss via button and via the menu; counter 2 → 1 → 0; re-extract brings one back.
8. **NA-26**: guard (needs a held job: restart under FIX-SLOT1 on the same persist dir, or record this beat in chapter 6); API 400 overlay.
9. **NA-30**: reload; identical list and counter (diff of the `/api/library` attention fields).

### Chapter 3: "Keep what you had, use what you have" (FAC-56 + FAC-57 + previous content). Profile FIX. About 7 calls.
1. **PF-01**: Settings default off → on → reload persists.
2. **PF-02**: U-EMPTY with fallback on; "Content extracted from preview · Partial", box with the reason, Activity "Used the preview as content instead.".
3. **PF-03**: auto-tag it; score appears; content endpoint returns only title and description.
4. **PF-04**: Retry getting content fails, fallback kept.
5. **PF-07**: U-DNS with fallback on; still in Needs attention, no Use preview.
6. Toggle the setting **off**. **PF-06**: new U-EMPTY variant (`/status/200?v=2`); Use preview removes it from the list.
7. **NA-27 + PF-09**: pasted content, then a failed re-extract; "Last extraction failed, showing the previous version: …", not listed.
8. **LW-01**: U-WALL-JAM; "Couldn't get the content: Got a login page instead of the content."; log `login_wall_detected` (caption from the log assert).
9. **LW-04**: wall on a link with pasted content; content kept.
10. Setting on again. **LW-05**: new wall variant gets the preview fallback.
11. **LW-06**: U-LONG-SIGNIN saved as content; no event.

### Chapter 4: "Jev waits its turn" (FAC-53). Profile FIX-SLOT1, fallback off (on only for X-01). About 6 calls.
1. **PQ-01**: 2 pasted-ready links plus 2 new (U-SLOW, `example.com`); Auto-tag all; "Waiting for extraction" → tagged. Hooks: pasted `jev:yes`/`jev:no` content; one browser slot.
2. **PQ-05**: `jev:slow=8000` link; Auto-tag then Lens; "Waiting for auto-tag". Assert the DB invariant (no two active jobs).
3. **PQ-08**: Lens tooltip "2 of 2 links need context first" on neutral links.
4. **PQ-02**: U-EMPTY failed + ready; "Auto-tag 1 with content" → "Skipped 1 link without content".
5. **PQ-03**: neutral `example.org` + ready; "Extract, then auto-tag".
6. **PQ-04**: neutral U-EMPTY; Extract, then auto-tag → "Content missing. Extract it first.", no Usage row, link listed for content only.
7. **PQ-06**: cancel a waiting auto-tag batch; the extraction finishes.
8. **PQ-07**: cancel an extract batch with a waiting auto-tag → "Cancelled 1 queued job, and 1 waiting for that extraction".
9. **X-02**: wall link (fallback off) with Extract, then auto-tag → free Content missing → Use preview → auto-tag succeeds.
10. **X-01** (setting on): new wall variant with Extract, then auto-tag → runs on the preview text.

### Chapter 5: "Jev failures cost what they cost" (FAC-52 + FAC-54). Three server restarts on the same persist dir: NOKEY → BADKEY → FIX. 0 Browser Rendering calls (all content pasted); 1 real request to `api.typesafe.ai` (401, free).
1. Under **FIX**: create the tag "QA tag", the lens "QA lens", and 3 links with pasted content; run the lens once on link 1 (for JC-02).
2. Restart under **NOKEY**. **JC-01**: Auto-tag and Lens disabled, tooltip "Jev is not configured: API key missing.". **JC-02**: Inspector Re-evaluate and Run again disabled. **JC-03**: new lens with run-now disabled; the lens is saved. **JC-04**: API 400 overlay; Activity and Usage unchanged.
3. Restart under **BADKEY**. **JP-01**: auto-tag the 3; one "Jev refused the request…", two "Stopped before calling Jev (no cost)…"; exactly one Usage row; no Needs attention (**X-03** assert).
4. Restart under **FIX**. **JP-02**: Retry failed → new batch tags all 3.
5. **JP-03**: link with `jev:fail` → "Jev returned an error (may have been billed).", one attempt; paste clean content, then Retry → done.
6. **JP-04**: a 3-link `jev:fail` lens batch; fix the contents; double-click Retry failed → one new batch + "These links were already retried.".

### Chapter 6: "Cancel means nothing happened" (FAC-55 + cancel paths of FAC-48). Profile FIX-SLOT1. About 5 calls.
1. **CJ-01**: U-SLOW; Auto-tag + Lens wait; ✕ the running extract (tooltip "Cancel (also cancels what waits for it)") → "Cancelled, and 2 waiting for that extraction"; 3× "Cancelled"; "No preview yet"; log `job_cancelled` `dependents:2`.
2. **CJ-07**: re-extract right after the cancel; stays processing until done; ends ready.
3. **CJ-02**: link with pasted "QA v1" at U-SLOW; re-extract, ✕ while running; "QA v1" and its version unchanged.
4. **CJ-03 + CJ-05**: `jev:slow=8000` link; Auto-tag ×2 + Lens; ✕ the waiting one → only it goes; the Lens runs after.
5. **CJ-04**: `jev:slow=30000` lens; ✕ during the call → "Cancelled after calling Jev (may have been billed)."; Usage row present; nothing resent after a recovery tick.
6. **CJ-10**: the batch summary shows Cancelled, with no "failed" count and no Retry.
7. **CJ-06**: `DELETE /api/jobs/<finished id>` → "This job already finished.".
8. **NA-29 + CJ-09**: U-EMPTY content-failed link; Retry queued behind U-SLOW; cancel the batch, then (second run) ✕ the job → back to "Context failed", still listed with the same reason.
9. **NA-26**: during step 8's held retry: no inline Retry or Dismiss; `POST /retry` → "Wait for the running job to finish.".

### Test hooks and fixtures the video harness needs (summary)

| Need | How |
|---|---|
| Deterministic Jev | `JEV_PROVIDER=fixture`, `ALLOW_FIXTURE_JEV=1`; content markers `jev:yes/no/fail/slow=<ms>` via `PUT /api/links/:id/content` |
| Held queue / slow jobs | `BROWSER_CONCURRENCY=1`; `https://httpbin.org/delay/10` first in line |
| Unconfigured / invalid Jev | `JEV_PROVIDER=typesafe` with no key / `TYPESAFE_API_KEY=x`; restart `bun run dev` on the same `LINKLOG_PERSIST_TO` |
| Preview failures | httpbin `/status/503`, `/status/429`, `/status/404`, `/status/403`, `/robots.txt`, `.invalid` host |
| Content failure with a working preview | `https://httpbin.org/status/200` (add `?v=N` for distinct links) |
| Login walls | `https://httpbin.org/base64/<b64 html>` per pattern (vary `<title>` for new links) |
| Content without Browser Rendering | import, cancel from the toast, then paste |
| Recovery tick | `LINKLOG_RECOVERY_MS` (default 30000) or `curl localhost:$API/cdn-cgi/local/scheduled` |
| Log asserts | `tee` the dev stdout to `qa/out/dev-<chapter>.log`; `grep` for the `"event"` JSON |
| API asserts | §0.4 calls; DB invariant via `wrangler d1 execute --local --persist-to` |
