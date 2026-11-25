# FAC-170 arena: process log

Grilling arena for FAC-170 (Slack → Linklog), run 2026-11-25, following Orky's `grilling-arena` skill, adapted to link-log. "Run the CLI" became: run against a local Worker (verify-linklog instances), with signed Slack requests.

Moderator: Opus (medium). Debaters: Opus and Sonnet subagents, each in its own worktree with its own verify-linklog instance (ports 3470/9170 and 3480/9180). Fable: not called. No GPT review or browser use.

## Ground truth before round 1

The moderator started verify-linklog (3460/9160), created an API key "Slack" and sent Slack-formatted text to `/api/v1/links`:

- **GT1:** `<https://article.qa.example/gt/a?x=1&amp;y=2|article.qa.example/gt/a?x=1&amp;y=2>` was saved as the Link `https://article.qa.example/gt/a?x=1&amp;y=2|article.qa.example/gt/a?x=1&amp;y=2` (202 created). Script: `FAC-170-prototype/ground-truth-scan.ts.txt`.
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
