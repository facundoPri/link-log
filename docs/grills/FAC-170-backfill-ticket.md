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
  - The cursor is kept between steps, so the import is resumable.
  - Threads (`conversations.replies`) cost one call each at 1 per minute. Leave them out at first, unless the owner wants them.
- **Filter.** Only messages whose `user` is the connection's Slack user, using the same counted message kinds and the same mrkdwn decoding. URLs are added through `addLinks` in chunks of at most 100. Batches go oldest first, so recency ends up matching the order in Slack.
- **Quotas.** The 500 Links per hour quota applies. On `links` 429 the job waits until the window resets, instead of dropping messages (unlike live events). Each chunk charges 1 write.
- **Visibility.** Each chunk is a normal extract batch, `Extract context · Slack · <workspace>`. The Settings row shows the import's progress (pages read, Links found) and a Cancel action.
- **Revocation.** If the connection is deleted, by Disconnect or uninstall, the Workflow stops at its next step.

## Acceptance criteria (draft)

1. Importing a channel saves the URLs of the connected user's own past messages in that channel, decoded, oldest first. Other members' messages and bot messages are never saved.
2. The job respects 1 call per minute and Slack's `Retry-After`, survives a Worker restart, and resumes from its cursor.
3. A spent links quota pauses the job until the window resets. Nothing is dropped.
4. Re-running an import creates no new Links: they are Duplicates, not charged.
5. Disconnect or uninstall stops a running import.
6. The test is a `verify-linklog` run with a fake `conversations.history` that pages 15 at a time and answers 429 with `Retry-After`.

## Open questions for when it starts

- Thread replies: import them (1 extra call per thread) or not?
- Should the import be offered automatically right after a channel is allowed, or only on demand?
