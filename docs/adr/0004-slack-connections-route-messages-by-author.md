---
status: proposed (pending owner review, FAC-170)
---

# A Slack message lands only in its author's library, through a Slack connection Linklog owns

Any Linklog user can add the Linklog Slack app to a workspace with Slack OAuth v2, started from Settings. The install creates a **Slack connection**: one Slack identity (workspace id and Slack user id) linked to one Linklog user. Each connection keeps the workspace's bot token, encrypted with Better Auth's `symmetricEncrypt`, and the channels whose messages count.

A message from Slack's Events API lands only in the library of the connection found by (`team_id`, `event.user`), its author, and only if its channel is on that connection's list. A channel alone never decides, and no request field names a Linklog user. The Links are a new batch source, `slack`, shown as `Extract context · Slack · <workspace>`.

Connections live in a Linklog table, `slack_connections`, not in Better Auth's `account` table. Better Auth's Slack support is Sign in with Slack (identity only). Its `genericOAuth` plugin can carry a bot install, but that turns an install into a sign-in identity: global email-linking rules have to be loosened and several auth routes must stay guarded forever. Proposed in the FAC-170 grilling arenas (2026-11-25), replacing the first arena's personal, API-key-based design.

## Considered Options

- **A personal app that posts with the owner's API key** (first arena). The owner rejected it: the app must be installable by any user.
- **Better Auth `genericOAuth` linking the install as an `account` row.** It worked in a prototype (43 of 43 scenarios), but it needs `allowDifferentEmails`, a scope-pinning hook on `/link-social`, `/unlink-account` disabled for good (enabled, it let a user delete their own password account), an index migration and raw SQL on Better Auth's schema.
- **The channel decides the library (a "channel owner").** Other members' posts would land in the wrong library.
- **Inviting the bot is the opt-in, with no channel list.** In a shared workspace it saves every linked member's posts from every channel the bot is in.
- **Hidden API keys for attribution.** Keys nobody can use, with revoke and delete meanings that don't apply.

## Consequences

- Rotating `BETTER_AUTH_SECRET` makes stored bot tokens unreadable. The user must add the app again, and the picker answers `slack-reconnect`.
- Linklog receives, and discards, messages by unlinked members in channels the bot is in.
- Disconnecting a workspace's last connection uninstalls the app from that workspace.
- The app starts with unlisted distribution. Some workspaces only allow Marketplace apps, and backfill is slow for new non-Marketplace installs (1 request per minute, 15 messages each).
