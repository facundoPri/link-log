---
status: proposed (pending owner review, FAC-170)
---

# Slack posts links as an API key client, not as a new source

Links posted in the owner's Slack channel reach Linklog through a signed Slack Events route that resolves a stored API key (Worker secret `SLACK_LINKLOG_API_KEY`) and calls `addLinks` with the existing `source: "api"` and that key's name. Slack is not a new batch source, has no install table and needs no OAuth: Activity shows `Extract context · API · Slack` and Usage counts the Links under the key, with no change to either. The route works inline and lets Slack's own redelivery be its retry: a transient failure answers 5xx, a redelivery is a Duplicate, and failures Slack's retries cannot fix (a revoked key, the hourly links quota) answer 200 and are only logged. Proposed in the FAC-170 grilling arena (2026-11-25).

## Considered Options

- **A `slack` batch source.** Changes only a label, at the cost of touching `BatchSource`, Activity, Usage and the docs.
- **An installable OAuth integration.** Install state and a token table for users that don't exist.
- **Ack first, save in `waitUntil`.** Slack never redelivers after a 2xx, so a failed save would be lost.

## Consequences

- The key lives in Settings and in a Worker secret: rotating it needs `wrangler secret put`.
- Nothing is shown in Slack; failures are visible only in Workers Logs.
- A Link deleted within Slack's 5-minute retry window can come back if its first delivery timed out after saving.
