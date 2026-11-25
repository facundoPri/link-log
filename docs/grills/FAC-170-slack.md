# FAC-170: Slack channel → Linklog (grilling decisions)

**Status: pending owner review.** Nothing here is in Linear yet. Arena run on 2026-11-25; the process is in [FAC-170-slack-process.md](FAC-170-slack-process.md).

Owner's words (2026-11-25): "uso mucho mandar a Slack links que me interesan. Tengo un canal en Slack en mi servidor privado que se llama Read Later... idealmente todos estos links deberían caer en la aplicación... ya tenemos la API lista... no debería ser tan complicado armar un bot de Slack que se conecte a esto... no debería comprometer ninguno de los otros tickets que están avanzando."

Criteria: (1) the domain model stays simple, (2) respect the module system, (3) don't grow the scope, (4) works and fits, proven by running it.

## The design in one picture

```text
Slack (#read-later) ──signed POST──▶ /api/slack/events           (new route module, ~55 lines)
   verify signature (5 min window)            ── bad ─▶ 401
   url_verification                           ──────▶ {challenge}
   human message? (no subtype | thread_broadcast | file_share, no bot_id)  ── no ─▶ 200
   decode Slack mrkdwn → scanUrls             ── no URL ─▶ 200
   apiKeyPrincipal(SLACK_LINKLOG_API_KEY)     ── invalid/revoked ─▶ 200 + warn
                                              ── lookup failed ─▶ 503 (Slack retries)
   charge 1 write (same quota as every API path) ── spent ─▶ 429 (Slack retries)
   addLinks(source: "api", key id + name)     ── links quota spent ─▶ 200 + warn
                                              ── D1/queue error ─▶ 5xx (Slack retries)
   ──▶ 200
```

Activity shows `Extract context · API · Slack`, and Settings > Usage counts the Links under the key "Slack". No new source, table, migration, UI or glossary term.

## Decisions

Each line: decision, then why against the criteria. "Suggested" was the ticket's recommendation.

**Q1 Shape: a personal Slack app, not an installable OAuth integration.** It matches the suggestion. There is one owner and one workspace. OAuth would add install state, a token table and a Settings screen nobody needs (1, 3). The endpoint is not hard-wired to a user: the user comes from the key (Q1b).

**Q1b Mapping and credentials: the Linklog user is the owner of an `lk_` API key, stored as the Worker secret `SLACK_LINKLOG_API_KEY`. The second secret is `SLACK_SIGNING_SECRET`, and there is no bot token.** An API key is already "a user-owned secret that only submits URLs" (GLOSSARY). It is revocable in Settings, and it brings Activity and Usage attribution with it (ground truth GT3). No table and no migration (1, 3). Cost: the key lives in two places (Settings and the Worker secret), so rotating it needs a `wrangler secret put`. The route answers 404 when either secret is unset (run in round 3).

**Q2 Channel: `#read-later` directly, chosen in Slack by inviting the app. No `SLACK_CHANNEL_ID` guard.** This rejects the suggested "new channel". The ticket wanted a new channel to avoid touching Hermes, but nothing in Linklog can collide with Hermes. Linklog dedupes, and bot posts are ignored. Slack only sends `message.channels` events for channels the app is a member of, so the invite already selects the channel. A Worker-side guard would be a third config value that drops messages silently when it disagrees with Slack (1). This is not a product question: the owner's own words name #read-later. Caveat (M4, checked): if Hermes posts **with a user token** (no `bot_id`), its replies are saved too. The owner checks this by hand (see Manual steps).

**Q3 Messages: human messages with no subtype, `thread_broadcast` and `file_share` count, thread replies included. Ignore `bot_id`, edits (`message_changed`), deletes, joins and every other subtype. There is no owner-user filter.** This partly rejects the suggestion "only the owner's Slack user". The workspace is private, and the invited channel is the boundary. A user filter is a third secret for a case that doesn't exist, and adding one later is one line (1, 3). `thread_broadcast` counts so that a reply saves the same with or without "Also send to channel". `file_share` (a link pasted with a screenshot) counts because the owner said "todos estos links". Each costs one string in the allowlist.

**Q3b Decoding (found by running, not in the ticket):** Slack sends `text` as mrkdwn: `<url|label>`, and `&amp; &lt; &gt;`. Fed raw to `/api/v1/links`, `<https://…/a?x=1&amp;y=2|…/a?x=1&amp;y=2>` was **saved as a wrong Link**, `https://…/a?x=1&amp;y=2|…` (GT1, 202 created). The route decodes first: `<url|label>` becomes the url, then `&lt; &gt;` are unescaped, with `&amp;` last. That is why a pure relay (Slack Workflow Builder or a webhook straight into `/api/v1/links`) is not enough, and why a small route is needed (4).

**Q4 Feedback in Slack: none in v1. No reactions and no threaded reply.** This rejects the suggested reactions. Reactions need a bot token (a third secret), the `reactions:write` scope, and an outbound call with its own failure policy (3). Activity already shows every Slack batch. The cost is that failures are silent in Slack (a revoked key, the links quota, a message with more than 100 URLs). They show only as warnings in Workers Logs. If the owner wants a ✅, it is a follow-up and does not block this.

**Q5 Attribution: reuse `source: "api"` with the key's name. No new `slack` source.** This rejects the suggestion. Run on both prototypes, the result was Activity `Extract context · API · Slack` and Usage `apiKeys: [{ name: "Slack", links: 3 }]`, with zero code changed in `BatchSource`, `ActivitySheet.label()` or `usage-summary.ts`. A new source would touch all three, plus the docs, only to change a label (1, 2). Readers of the reused shape (`source === "api"`, `BatchSource`, `apiKeyName`) are `ActivitySheet.tsx`, `worker/links.ts`, `usage-summary.ts`, `public-api.ts` and two tests. All of them read it unchanged.

**Q6 Retries and idempotency: process inline, before answering.** Slack redelivers only when it does not get a 2xx within 3 s. Inline processing took 6–215 ms locally, so a transient failure becomes a 5xx through the existing `onError`, and Slack's own retries (immediately, after 1 min, after 5 min) are the retry mechanism. A redelivery is a Duplicate: no new batch and no charge (GT2; 5 parallel identical deliveries produced exactly 1 Link). This rejects "ack first, work in `waitUntil`": a failure after the 200 is lost for good, because Slack never redelivers after a 2xx. There is no event-id store (1). The key lookup goes through a helper extracted from `requireApiKey` (`apiKeyPrincipal`), so a D1 outage is a retryable 503, not "key revoked". Without the helper, both prototypes would have dropped the message.

**Q6b Quotas.** Each Slack message with a URL charges **1 write** to the account's shared budget of 120 writes per minute, like every API path (2). When that budget is spent the route answers 429. Slack's immediate retry lands in the same window, but its 1-minute retry gets through (run: 429 `Retry-After: 44`, then 200 and saved 61 s later). **The 500 links per hour quota answers 200 and logs a warning.** Slack's retries (5 minutes at most) cannot outlast an hour window, and repeated non-2xx answers count toward Slack disabling the subscription. A message with **more than 100 URLs** saves the first 100 and logs a warning; the public API refuses the same input with a 400, but Slack can't show an error.

**Q6c Known edge: a Link deleted within 5 minutes can come back.** If the first delivery timed out after saving and the owner deletes the Link before Slack's retry, the retry creates it again and charges it again (run in round 3). This is documented, not coded around. A deliberate repost also re-adds it, which is expected.

**Q7 Backfill: only new messages in the main PR. Importing history is the one product question for the owner.** "Todos estos links" could mean history. If yes, it is a separate, optional small PR: a local one-off script (`scripts/slack-backfill.ts`). It reads `conversations.history` with a bot token from the shell environment, oldest first. It decodes with the same function and posts to `/api/v1/links` with the same key in chunks of at most 100 URLs, honouring 429 and `Retry-After` (500 links per hour). The script adds no Worker code. Free Slack plans only expose the last 90 days.

**Q8 Manual steps for the owner:** see the section below.

**Size: 1 PR** for the feature: a route of about 55 lines, `apiKeyPrincipal` extracted (+25/−14 in `middleware.ts`), 3 lines in `app.ts`, 2 optional `Env` fields, one Worker test file and `docs/slack.md`. A second PR only if the owner wants backfill. No migration, no extension or `browser-protocol` change (so no extension version bump), and no UI change, so it doesn't collide with in-flight tickets.

## Alternatives rejected

- **Slack Workflow Builder or a webhook relay straight into `/api/v1/links`, with zero code.** It saves wrong URLs (GT1). Its web-request step is also paid-plan only (not verified against live Slack).
- **An installable OAuth integration for any user.** Adds install state, a token table and Settings UI. No user other than the owner exists.
- **A new `slack` batch source.** It changes a label at the cost of touching `BatchSource`, Activity, Usage and the docs.
- **Ack first, then `waitUntil`.** It loses failures after the 200.
- **An event-id dedupe table.** `addLinks` is already idempotent per URL.
- **A `SLACK_CHANNEL_ID` guard and a Slack user-id filter.** Config that duplicates what the Slack invite already decides.
- **Reactions or a threaded reply.** Needs a bot token, a scope and an outbound failure policy; this is a follow-up if wanted.

## Questions for the owner (exceptions)

1. **Backfill:** do you want the existing #read-later history in Linklog, or only what you post from now on? Recommendation: only new messages, plus the optional script PR if you want history (free Slack: last 90 days).

Questions the moderator answered for you, which you can overturn: no ✅ reaction in Slack (Q4); `file_share` counts (Q3); a message from someone else in #read-later is saved too (Q3); and when the links-per-hour quota is spent, the message is dropped with only a log line (Q6b).

## Manual steps in Slack (owner)

1. Create an app at api.slack.com/apps, "From scratch", in your workspace. Name it, for example, "Linklog".
2. Under **OAuth & Permissions**, add the bot token scope `channels:history`. If #read-later is a private channel, add `groups:history` instead.
3. Wait to enable events until the PR is deployed and the secrets are set (step 6): Slack checks the URL right away.
4. In Linklog, go to **Settings → API keys** and create a key named `Slack`. Copy the secret.
5. In Slack's **Basic Information**, copy the **Signing Secret**.
6. Run `wrangler secret put SLACK_SIGNING_SECRET --env production` and `wrangler secret put SLACK_LINKLOG_API_KEY --env production`.
7. Under **Event Subscriptions**, turn events on with the Request URL `https://linklog.facundopri.com/api/slack/events` (it should show "Verified"). Subscribe to the bot event `message.channels`, or `message.groups` for a private channel. Save.
8. **Install to Workspace**, then in #read-later run `/invite @Linklog`.
9. Check Hermes: open one of its posts in #read-later. If it shows an **APP** badge, it is a bot and is ignored. If it posts as you, its replies with links will be saved too; turn Hermes off or tell us.
10. Post a link in #read-later. It should appear in Linklog, and in Activity as `Extract context · API · Slack`.

## Drafted implementation ticket (not created in Linear)

**Title:** Save links posted to a Slack channel into Linklog
**Labels:** `Feature`. **Project:** Linklog. **Related:** FAC-170.

### Goal
Links the owner posts to `#read-later` in their Slack workspace land in their Linklog library, attributed to an API key named "Slack", with no LLM in between.

### Design
See `docs/grills/FAC-170-slack.md`, decisions Q1–Q8. The prototype is in `docs/grills/FAC-170-prototype/` (`slack.ts.txt`, `app-middleware.diff.txt`). It is a prototype: rewrite it test-first, don't copy it.
- `worker/routes/slack.ts`: `POST /api/slack/events`, mounted in `worker/http/app.ts` outside `/api/v1`. Answers 404 when `SLACK_SIGNING_SECRET` or `SLACK_LINKLOG_API_KEY` is unset.
- `apiKeyPrincipal(c, key)` extracted from `requireApiKey` (`worker/http/middleware.ts`). `requireApiKey` uses it, with identical behaviour.
- Body read with `readBounded`. Signature: HMAC-SHA256 of `v0:{ts}:{raw body}`, `v0=` hex, timestamp within 300 s, constant-time compare (`crypto.subtle.verify`).
- An exported decode function: `<url|label>` becomes the url, other `<…>` tokens become their inside, then `&lt; &gt;` are unescaped, `&amp;` last.
- Counted messages: `event.type === "message"`, no `bot_id`, and a subtype that is none, `thread_broadcast` or `file_share`.
- Charges 1 write per message with a URL. `addLinks(…, { source: { source: "api", apiKeyId, apiKeyName } })` runs inline.
- Logs use `console.warn` (the QA harness doesn't capture `console.log`): `slack_key_rejected`, `slack_links_limited`, `slack_truncated`.

### Acceptance criteria
1. A signed `url_verification` answers `{ challenge }`.
2. A signed message in the channel containing `<https://h/a?x=1&amp;y=2|label>` saves `https://h/a?x=1&y=2`. Activity shows `Extract context · API · Slack`, and Usage counts it under the key "Slack".
3. A thread reply, a `thread_broadcast` and a `file_share` save. A bot message (with `bot_id` or `subtype: bot_message`), `message_changed` and `message_deleted` save nothing and answer 200.
4. A bad signature, a missing header or a timestamp older than 5 minutes answers 401 and saves nothing.
5. Redelivering the same message (`X-Slack-Retry-Num: 1`) creates no Link, batch or charge.
6. A revoked "Slack" key answers 200, saves nothing and logs `slack_key_rejected`. A failed key lookup answers 503.
7. A spent `writes` budget answers 429 with `Retry-After`. A spent `links` quota answers 200 and logs `slack_links_limited`. More than 100 URLs saves the first 100 and logs `slack_truncated`.
8. Without the two secrets, the route answers 404.
9. `tests/api-keys.test.ts` and `tests/public-api.test.ts` pass unchanged.
10. `docs/slack.md` documents setup (the manual steps above), behaviour, and the known edges (silent failures, Hermes posting with a user token, a Link deleted within 5 minutes can come back). `docs/upload-api.md` links to it.

### Verification
- A Worker test file covering criteria 1–9 with signed requests.
- `verify-linklog`: a journey or script that signs Slack requests against the instance (see `docs/grills/FAC-170-prototype/scenarios.ts.txt`). It checks the Link, the Activity label in the UI and Usage. Pass the secrets with `up --var`, and create the key with a known secret.
- After deploy, the owner's step 10 in Slack.

+++ Agent notes
- Worker vars are fixed at `up`. The prototype created the key through `/api/auth/api-key/create` and then pointed its hash at the `--var` value in local D1. A journey can do the same, or create the key first and restart.
- Changes neither `apps/extension/` nor `packages/browser-protocol/`: no version bump.
- Opus round 3: the inline time measured 19–215 ms locally.
+++
