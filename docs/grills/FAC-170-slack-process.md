# FAC-170 arena: process log

Grilling arena for FAC-170 (Slack → Linklog), run 2026-11-25, following Orky's `grilling-arena` skill, adapted to link-log. "Run the CLI" became: run against a local Worker (verify-linklog instances), with signed Slack requests.

Moderator: Opus (medium). Debaters: Opus and Sonnet subagents, each in its own worktree with its own verify-linklog instance (ports 3470/9170 and 3480/9180). Fable: not called. No GPT review or browser use.

## Ground truth before round 1

The moderator started verify-linklog (3460/9160), created an API key "Slack" and sent Slack-formatted text to `/api/v1/links`:

- **GT1:** `<https://article.qa.example/gt/a?x=1&amp;y=2|article.qa.example/gt/a?x=1&amp;y=2>` was saved as the Link `https://article.qa.example/gt/a?x=1&amp;y=2|article.qa.example/gt/a?x=1&amp;y=2` (202 created). Reproduce it on a verify-linklog instance with an API key: `curl -s -X POST $UI/api/v1/links -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"urls":["mirá <https://article.qa.example/gt/a?x=1&amp;y=2|article.qa.example/gt/a?x=1&amp;y=2> y <https://article.qa.example/gt/b>"]}'`, then read the Link back in the 202's `results[].url`. `FAC-170-prototype/ground-truth-scan.ts.txt` shows the same thing at the `scanUrls` level, without a request.
- **GT2:** sending the same URL again gave `duplicate`, no batch and no charge.
- **GT3:** a key named "Slack" already made Usage show `apiKeys:[{name:"Slack",links:2}]`, and the Activity label reads `Extract context · API · <key name>`.

GT1 killed the "pure relay, zero code" option before anyone argued for it. GT3 turned Q5 into a claim to refute instead of an open question.

The brief listed seven refutable claims (C1–C7: no new source, a relay isn't enough, the key as the mapping, #read-later directly, ack plus `waitUntil`, backfill without Worker code, 1 PR).

## Round 1 (parallel, each ran a prototype)

Both built a route, sent signed requests (`url_verification`, `&amp;` with `|label`, a bot message, `message_changed`, a thread reply, a bad signature, a stale timestamp, a retry) and read back Library, Usage and Activity.

- **Converged without talking:**
  - a personal app with an `lk_` key as a Worker secret
  - no new source
  - #read-later
  - no reactions
  - no backfill in the feature
  - 1 PR
- **Both rejected these suggestions:**
  - the new channel (Q2)
  - reactions (Q4)
  - the `slack` source (Q5)
  - the owner-only user filter (Q3, Opus; Sonnet replaced it with a channel guard)
- **Diverged on:**
  - inline (Sonnet) vs `waitUntil` (Opus)
  - a `SLACK_CHANNEL_ID` guard (Sonnet)
  - charging writes (Sonnet yes, Opus no)
  - the subtypes Opus flagged (`file_share`, `thread_broadcast`)
- **C5 was half refuted by Sonnet:** `waitUntil` loses failures, because Slack never redelivers after a 2xx. Sonnet also measured a 5-way delivery race: exactly 1 Link.

## Round 2 (cross-critique, fixed self-critique slot)

- **Opus changed three positions** using Sonnet's argument against itself:
  - inline, not `waitUntil` ("my design was guarding a 3 s budget that a 12 ms operation never comes near")
  - charge writes (it found `writes` is a 60 s window, so a 429 *is* retryable, which corrected Sonnet's own claim)
  - the shared key helper
  
  It also found that both prototypes treated a D1 outage as a revoked key and dropped the message.
- **Sonnet changed two positions:**
  - dropped the channel guard ("the invite is the boundary")
  - took the subtype allowlist
- **The swap:** Opus dropped `file_share` as unproven while Sonnet adopted it. It was a values call; the moderator decided it with the owner's words ("todos estos links"), M1.
- **The dividing question** Sonnet named (recoverable or silently lost) was settled by Opus's concession.

## Fable

Not called. The skill's condition was not met: the design wasn't awkward (no special cases, no flag with two uses) and the debaters weren't stuck. Round 2 ended with one minor tie.

## Round 3 (Opus attacks the moderator)

The moderator's departures were:
- M1: `file_share` counts
- M2: a spent links quota answers 200 and logs
- M3: backfill as an optional PR plus an owner question
- M4: a Hermes post with a user token would be saved
- M5: 1 PR, about 80 lines, glossary unchanged

Round 3 ran on an instance that already had data written the normal way.

- **M1–M5 hold.** M4 was confirmed by execution: a Hermes-like reply with no `bot_id` saved 3 Links.
- **Promises refuted or incomplete:**
  - **"A redelivery is a Duplicate":** false when the owner deletes the Link within Slack's 5-minute retry window. It is re-created and charged. Now documented (Q6c).
  - **More than 100 URLs:** not decided in the draft. It is now "save 100, warn".
  - **"429 → Slack retries":** only the 1-minute retry gets through; the immediate one lands in the same window.
  - **The `slack_links_limited` log:** invisible in the QA harness (`console.log` isn't captured). The ticket now asks for `console.warn`.
- **Readers of reused shapes:** grepped and none changed.

## Cost and value per step

| Step | Value |
| --- | --- |
| Ground truth (moderator, ~10 min) | Highest per minute: GT1 made decoding a requirement, GT3 settled Q5 before debate |
| Round 1 (2 × ~4 min, ~100k tokens each) | Proved the whole design end to end twice; surfaced the inline vs `waitUntil` split |
| Round 2 (short) | 5 position changes; found the D1-outage-as-revoked bug shared by both prototypes |
| Round 3 (~7 min, ~30k tokens) | 2 real edges (delete then redelivery, more than 100 URLs) and 1 log-level fix |

## What to change next time

- For an integration ticket, put **the external system's wire format** in the ground truth (here, Slack mrkdwn). It was the one fact that changed the shape of the design.
- Give each debater **a fixed key secret through `--var` before `up`**, for example with a QA hook to seed a key. Both debaters spent time re-hashing a key row to match a Worker var fixed at launch.
- When the debaters converge in round 1 on almost everything, round 2 can be limited to the divergences, as it was here, which kept it cheap.

---

# Arena B: an installable app for any Linklog user (2026-11-25)

The owner's feedback on PR #50 changed Q1: the app must be installable by any Linklog user, with a channel configuration, attention to security, and a look at Better Auth. Backfill should come in a separate PR. Arena B reopened everything that depended on the app being personal, and kept arena A's decoding, idempotency and counted messages. It used the same models. Fable was not called. The prototypes are in `FAC-170-prototype/arena-a/` and `arena-b/`.

## Ground truth before round 1

The moderator read the code and the official Slack docs; the docs were fetched into the scratchpad.

- **GT-A:** Better Auth 1.7.7's Slack support is only Sign in with Slack. Both the core social provider and the `genericOAuth` `slack()` helper use `openid/connect/authorize` with scopes `openid profile email`. The generic plugin does accept custom URLs, `getToken`, `getUserInfo` and `encryptOAuthTokens`, which is what made the plugin a candidate to test rather than a fact.
- **GT-B to GT-E:** what `oauth.v2.access` returns, the Events API (one Request URL per app, retries, events limits), `app_uninstalled` and `tokens_revoked`, and the distribution rules: unlisted needs no review; the Marketplace needs at least 10 active workspaces and up to 10 weeks of review.
- **GT-F:** since 2025-05-29, new non-Marketplace installs can call `conversations.history` once per minute, 15 messages at a time. This shaped the backfill ticket before anyone argued about it.

There were eight refutable claims, K1 to K8: the token isn't needed in v1; ownership by author; linking through the install; genericOAuth without a table; the channel picker; a `slack` source; unlisted; 2 PRs.

## Round 1 (parallel, different carriers on purpose)

- **Opus** built the install on Better Auth `genericOAuth` (link-social). It passed 43 of 43 scenarios with a fake slack.com, and a Playwright journey showed `Extract context · Slack · Acme`. It found that enabling `/unlink-account` let a user delete their own password account. It refuted K4's "channels need a table", since `user_settings` was enough.
- **Sonnet** built its own routes and a `slack_connections` table. It passed 46 scenarios. It refuted K4 (genericOAuth needs global linking changes, an invented email or `allowDifferentEmails`, and leaves the team name and bot user id unstored). It also refuted K8 (3 PRs, not 2). Its picker used `users.conversations?user=` so a user never sees private channels they aren't in.
- **They agreed without talking on:**
  - ownership by author, with an opt-in channel list (K2, K5)
  - a `slack` source (K6)
  - unlisted distribution (K7)
  - requesting every scope at install
  - backfill as a slow, resumable job

## Round 2 (cross-critique): a full swap

- **Sonnet adopted genericOAuth.** Its reasons: Better Auth already owns state, linking and encryption, and the repo reserves accounts for Better Auth. It also moved channel storage to `user_settings` and dropped `apps.uninstall`.
- **Opus adopted the own table.** It ran a scope-pinning hook (`scopes` and `user_scope` both gave 400), confirmed with `EXPLAIN` that `account` lookups `SCAN` (so "0 migrations" was false), and conceded the picker leak, which its fake couldn't show because it had no private channels. It added `apps.uninstall` on the last Disconnect, and proposed `better-auth/crypto` `symmetricEncrypt` instead of hand-written AES-GCM.
- **Swapped and decided by the moderator:** the carrier, channel storage, and `apps.uninstall`. Following the skill, the moderator decided them with the owner's words: "seguridad", and Better Auth as "una cosa que puede estar interesante", not as a mandate. The criteria also weighed in: a workspace install is not a sign-in identity (1), and Better Auth owns sign-in while Linklog owns integrations (2).
- **What survived the swap:**
  - Better Auth's crypto
  - Opus's scope-pinning finding, used as an argument against loosening auth
  - Sonnet's picker

## Fable

Not called. After the swap the design wasn't awkward, and the debaters weren't stuck: each had a working prototype of both sides, so the choice was between two working designs, not a search for one.

## Round 3 (Sonnet attacks the moderator, on an instance with existing data)

Round 3 adapted the final prototype to the moderator's choices and ran it after writing web Links and an API key "Slack" with submissions.

- **M-B4 refuted.** The moderator's "bare nonce in a signed cookie" couldn't check that the callback arrived on the same user's session. The fix puts `${userId}.${nonce}` in the cookie. With it, these were all refused: a callback on another session, a state from another start, and a tampered cookie.
- **New bug found by running.** A token sealed under another secret (`BETTER_AUTH_SECRET` rotated) made the picker answer 500. It now answers `409 slack-reconnect`, and it is in the design.
- **Promise refuted.** "One glossary term" didn't hold: round 3 counted 2 or 3 user-visible terms. The moderator kept one entry, "Slack connection", and put allowed channels inside its definition. This departure is **unreviewed**, so the owner should check it.
- **Held:**
  - M-B1 (crypto code shrank from 37 to about 5 lines)
  - M-B2 (an indexed `SEARCH`)
  - M-B3 (`apps.uninstall` called exactly once; late events harmless)
  - M-B5 (the API key row and Web counts unchanged; a Slack row on its own)
  - Enterprise installs refused
- **Readers of changed shapes, listed:**
  - `BatchSource`
  - `ActivitySheet.label()` and its `BatchConfig`
  - the `usage-summary` SQL
  - the `Usage` type and the Settings Usage UI
  - `docs/upload-api.md` line 127
  - ADR 0004, renamed to `0004-slack-connections-route-messages-by-author.md`

## Cost and value

| Step | Value |
| --- | --- |
| Ground truth from the official docs (moderator) | Settled distribution and backfill limits before debate; made Better Auth a testable claim instead of an opinion |
| Round 1, carriers assigned on purpose (2 × ~13 min, ~200k tokens each) | Both carriers proven working, so round 2 compared real costs rather than guesses; found the unlink hazard and the picker leak |
| Round 2 | A full swap: each adopted the other's carrier with new evidence (hook and `EXPLAIN` runs) |
| Round 3 (~13 min) | Refuted the moderator's state design, found the reconnect 500, and counted the glossary promise |

## What to change next time

- **When a ticket has two plausible carriers, assign one to each debater in round 1.** Debating two working prototypes is far cheaper than debating one prototype against a hypothesis. Here it produced a clean swap that the criteria could decide.
- **A fake external service needs the cases the decision turns on:** private channels, a second user, another team. Opus's fake had no private channel, so it could not see its own picker leak.
- **Any claim about security code** ("less owned code", "same guarantees") **gets an attacker scenario in round 3.** The bare-nonce claim read fine and failed on the first cross-session test.
