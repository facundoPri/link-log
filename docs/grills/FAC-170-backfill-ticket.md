# Drafted ticket: import a Slack channel's history (backfill)

**Status: accepted by the owner (2026-11-25); created in Linear as FAC-323.** It comes after the two Slack PRs in [FAC-170-slack.md](FAC-170-slack.md). The owner asked for it, in a separate PR, after those two (2026-11-25).

**Labels:** `Feature`. **Project:** Linklog. **Related:** FAC-170. **Blocked by:** FAC-321 (server) and FAC-322 (Settings › Slack).

## Goal

When a user allows a channel, they can also import the links they posted there before connecting. The imported Links land exactly as new messages would: same decoding, same rules for which messages count, `source: "slack"`, and Duplicates are not charged.

## What Slack allows (official docs, read 2026-11-25)

- `conversations.history` needs the `channels:history` or `groups:history` scope, which the install already requests, and the stored bot token, which is already kept sealed. No reinstall is needed.
- Since 2025-05-29, **new installs of non-Marketplace distributed apps** can call `conversations.history` and `conversations.replies` **once per minute, with at most 15 messages per call**. That is about 900 messages per hour per workspace. Marketplace apps and internal apps keep 50+ calls per minute with 1,000 messages each. *Unverified:* whether the app's own associated workspace, the owner's, counts as internal once public distribution is on.
- Free Slack plans only expose the last 90 days of history.

So the import is a background job that runs for minutes to hours, not a click that finishes. It must survive restarts and resume where it stopped.

## Design sketch (to settle when the ticket starts)

- **Trigger.** In Settings › Slack, an **Import past messages** action per allowed channel.
- **Job.** A Cloudflare Workflow per channel import. It fits the pattern that Extraction already uses Workflows for durable steps; see ADR 0002 for the split.
  - One `conversations.history` page per step, with `step.sleep` for the rate limit and Slack's `Retry-After` on 429.
  - Slack returns history newest first, so the job runs in two phases.
    - **Read**, newest to oldest. Each page is read with `latest=<checkpoint>`, where the checkpoint is the `ts` of the oldest message read so far. The messages that count, and that hold links (their `ts` and decoded URLs only), are kept as that Workflow step's durable result. After a restart, or on `invalid_cursor`, the next page starts again from the checkpoint; Slack's cursor is only used within a short pause. The phase ends when Slack reports no more history.
    - **Add**, oldest to newest. It goes through the kept messages in `ts` order, with one `addLinks` call per message. Its checkpoint is the `ts` of the last message added.
  - Thread replies are not in `conversations.history`, which only returns parents with a `reply_count`. Importing them needs one `conversations.replies` call per parent with replies (paged), at 1 call per minute. Without that, a link posted only in a reply is not imported, unlike live messages (Q3). Whether to pay that cost is an open question below.
- **Filter.** Only messages whose `user` is the connection's Slack user, using the same counted message kinds and the same mrkdwn decoding. Each message gets its own `addLinks` call, oldest message first (`addLinks` stamps every URL of one call with the same time, and the library breaks ties by id, so a chunk across messages would scramble their order). A URL already in the library is a Duplicate: its recency is refreshed at its turn, so it also lands in Slack's order. A message with more than 100 URLs saves the first 100, as live events do.
- **Quotas.** The 500 Links per hour quota applies. On `links` 429 the job waits until the window resets, instead of dropping messages (unlike live events). Each `addLinks` call is preceded by an explicit charge of 1 write, as live events do (`addLinks` only charges the links quota). On a `writes` 429 the job waits for the next minute. Reading never charges.
- **Visibility.** Each call that queues Extraction is a normal extract batch, `Extract context · Slack · <workspace>`. The Settings row shows the import's progress (pages read, Links found) and a Cancel action.
- **Revocation.** If the connection is deleted, by Disconnect or uninstall, the Workflow stops at its next step.

## Acceptance criteria (draft)

1. Importing a channel saves the URLs of the connected user's own past messages in that channel, decoded, oldest first. Other members' messages and bot messages are never saved.
2. The job respects 1 call per minute and Slack's `Retry-After`, survives a Worker restart, and resumes from its checkpoints (read: the oldest `ts` read; add: the last `ts` added), including after an expired cursor or `invalid_cursor`. The fake history returns pages newest first, as Slack does.
3. A spent links quota pauses the job until the window resets. Nothing is dropped.
4. Re-running an import creates no new Links: they are Duplicates, not charged.
5. Disconnect or uninstall stops a running import.
6. The test is a `verify-linklog` run with a fake `conversations.history` that pages 15 at a time and answers 429 with `Retry-After`.

## Open questions for when it starts

- Thread replies: import them (1 extra call per thread) or not?
- Should the import be offered automatically right after a channel is allowed, or only on demand?
