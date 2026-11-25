# FAC-170: Slack channel → Linklog (grilling decisions)

**Status: accepted by the owner (2026-11-25).** The implementation tickets are in Linear: FAC-321 (server), FAC-322 (Settings › Slack, blocked by FAC-321) and FAC-323 (backfill, blocked by both). Two arenas ran on 2026-11-25. Arena A designed a personal app. After the owner's feedback on PR #50, arena B reopened the design as an app any Linklog user can install. This document records arena B's decisions, plus the parts of arena A that still hold. The process is in [FAC-170-slack-process.md](FAC-170-slack-process.md). The prototypes are in [FAC-170-prototype/](FAC-170-prototype/) (`arena-b/` is current).

## Owner's words

The original request (2026-11-25): "uso mucho mandar a Slack links que me interesan. Tengo un canal en Slack en mi servidor privado que se llama Read Later... idealmente todos estos links deberían caer en la aplicación... ya tenemos la API lista... no debería comprometer ninguno de los otros tickets que están avanzando."

The feedback on PR #50 (2026-11-25), which overrides the original Q1: "no tiene que ser algo solo personal mío... lo que más me gustaría es que sea una app de Slack que cualquier persona que sea cliente o tenga una cuenta acá pueda agregar a su servidor, y que cuando la agrega de forma muy sencilla ya pueda empezar a usarla. Capaz tenga un proceso de configuración, o que por lo menos tengas que decir cuáles son los canales que vas a permitir... habría que ver qué tan viable es y también el tema de seguridad... Capaz [Better Auth] ya tiene alguna cosa con Slack que puede estar interesante." He also wants backfill, in a separate PR, later.

Criteria: (1) the domain model stays simple, (2) respect the module system, (3) don't grow the scope, (4) works and fits, proven by running it.

## The design in one picture

```text
Linklog Settings › Slack  [Add to Slack]
  GET /api/slack/install    (signed-in) → signed cookie {userId.nonce}, redirect to slack.com/oauth/v2/authorize
                              bot scopes: channels:history groups:history channels:read groups:read
  Slack consent page        [Allow]
  GET /api/slack/callback   state == cookie nonce AND session user == cookie user, else ?slack=invalid
                              oauth.v2.access → team.id, authed_user.id, bot token, bot_user_id
                              enterprise install → refused
                              upsert slack_connections(team_id, slack_user_id → user_id, token sealed)
                              a Slack identity already linked to another Linklog user → ?slack=taken
  Settings › Slack          pick channels: users.conversations(user) ∩ channels the bot is in
                              (in Slack: /invite @Linklog to the channel)

Slack ──signed POST──▶ /api/slack/events
  signature (v0 HMAC, 5 min) ─ bad ─▶ 401           url_verification ─▶ {challenge}
  app_uninstalled | tokens_revoked(bot) ─▶ delete every connection of team_id ─▶ 200
  message: counted kind? (none | thread_broadcast | file_share, no bot_id) ─ no ─▶ 200
  connection = (team_id, event.user) ─ none ─▶ 200, dropped, nothing stored
  event.channel in connection.channels? ─ no ─▶ 200, dropped
  decode mrkdwn → scanUrls → charge 1 write to connection.user_id → addLinks(source: slack)
```

Activity shows `Extract context · Slack · <workspace>`. Settings › Usage gets a Slack row per workspace.

## Decisions

Each item gives the decision, then the reason against the criteria. "Suggested" means the ticket's recommendation. "Arena A" means it was decided in the first arena and still holds.

### Shape and install

**Q1 Shape: an installable Slack app for any Linklog user, using Slack OAuth v2 "Add to Slack" started from Linklog Settings.** The owner decided this on PR #50. The owner's own #read-later goes through the same install. Arena A's personal Worker-secret path is dropped, because keeping two paths to the same thing breaks criterion 1.

**B1 Install flow: two clicks, then choose channels.**
1. In Settings › Slack, click **Add to Slack**.
2. Click **Allow** on Slack's consent page. This lands back on Settings with `?slack=connected`.
3. Tick the channels whose messages count. If a channel is missing, run `/invite @Linklog` in it.

The install only works when it starts from Linklog: a callback without its cookie is refused, which was tested.

**B2 Linking: a Slack connection is one Slack identity (`team_id`, Slack user id) linked to one Linklog user.** It is created by the install itself: `authed_user.id` and `team.id` from `oauth.v2.access` are linked to the signed-in user.
- One Linklog user can link several workspaces.
- Several Linklog users can share a workspace. Each one clicks **Add to Slack**; Slack re-authorizes and returns the same bot token.
- A Slack identity belongs to at most one Linklog user. A second Linklog user claiming it gets `?slack=taken` (tested).
- There is no separate "Sign in with Slack" step.

**B6 Better Auth: Better Auth is not used to install the bot.** Its Slack support is Sign in with Slack (`openid/connect/authorize`, scopes `openid profile email`), which gives an identity token, not a workspace bot install. That applies both to `@better-auth/core`'s social provider and to the `slack()` helper of `genericOAuth` in 1.7.7.

The `genericOAuth` plugin *can* carry the install as a linked account. Opus built it, and 43 of 43 scenarios passed. Arena B rejected it anyway, as a values call decided by the moderator after the debaters swapped positions. The reason is that it makes Better Auth treat a workspace install as a sign-in identity, which needs:
- global `accountLinking.allowDifferentEmails` and `trustedProviders`, because Slack returns no email;
- `/link-social` turned on, with a hook that pins the scopes, because the client can otherwise ask for its own scopes (tested);
- `/unlink-account` and `/sign-in/social` disabled for good. With unlink turned on, a user deleted their own password account (tested).
- raw SQL against Better Auth's camelCase schema;
- an index migration anyway, because `account(accountId)` is unindexed and a per-message lookup ran as `SCAN` (tested);
- an `auth.test` call to get the workspace name.

One table of our own is simpler (criterion 1). Better Auth keeps owning sign-in and Linklog owns its integrations (criterion 2).

What we do take from Better Auth: `symmetricEncrypt`/`symmetricDecrypt` from `better-auth/crypto`, keyed by `BETTER_AUTH_SECRET`. This is the same function Better Auth uses to encrypt its own OAuth tokens, so Linklog writes no crypto of its own.

### Channels and ownership

**B3 Allowed channels: opt-in per connection, chosen in Linklog Settings › Slack, and stored as a JSON column on the connection row.**
- The picker lists `users.conversations?user=<slack user>` intersected with the channels the bot is in. A user never sees the name of a private channel they aren't in. Opus's `conversations.list` would have shown them, as Sonnet's run demonstrated.
- The bot must be invited to a channel for that channel to deliver messages. That is Slack's rule: message events only arrive for conversations the bot is a member of.
- **Rejected: "inviting the bot is the opt-in", with no picker.** In a shared workspace, it would save every linked member's posts from every channel the bot sits in, and the owner asked to say which channels count.

**B4 Ownership: a message lands only in the library of the author's connection, looked up by (`team_id`, `event.user`), and only if `event.channel` is in that connection's channels.** This rule makes it impossible for a message to land in the wrong account. A channel alone never decides. These cases were all tested:
- A message by B in A's channel saves nothing for A.
- After B allows that channel, B's message lands only in B's library.
- A's Slack id arriving from another team is dropped.
- Messages from unlinked users and from bots are dropped and never stored.

**Q3 Messages that count (arena A):** no subtype, `thread_broadcast` and `file_share`, with thread replies included. Messages with `bot_id`, edits, deletes and joins are ignored. There is no separate user filter: authorship is now the filter.

**Q3b Decoding (arena A, refined in review):** Slack sends mrkdwn. A URL inside Slack's link markup, `<url>` or `<url|label>`, is already delimited by Slack: it is unescaped (`&lt;`, `&gt;`, then `&amp;` last) and passed whole to `normalizeUrl`, without the trailing-punctuation trim that `scanUrls` applies to prose. So `<https://example.com/article_|label>` keeps its final `_`. Only text outside the markup goes through `scanUrls`. Without decoding, a URL like `https://…/a?x=1&amp;y=2|label` was saved as a broken Link (GT1).

### Security

**B5a Request signature (arena A):** v0 HMAC-SHA256 over `v0:{ts}:{raw body}` with the app's signing secret, a 5-minute window, constant-time compare. Bad, missing and stale signatures get 401.

**B5b OAuth state:** `GET /api/slack/install` sets a signed, HttpOnly, Lax cookie holding `${userId}.${nonce}` (Hono `setSignedCookie`, 10 minutes, path `/api/slack`), and sends the nonce as `state`. The callback requires the nonce to match and the signed-in user to equal the cookie's user, and it clears the cookie.

Round 3 refuted the moderator's first version, a bare nonce: it couldn't tell that the callback arrived on another user's session. With the user in the cookie, these were all refused (tested):
- a callback on another user's session
- a state from another start
- a tampered cookie
- a replayed `code`

**B5c Token storage: the bot token is sealed in D1** (`slack_connections.bot_token`, `symmetricEncrypt`). It can't be a Worker secret, because each workspace has its own token.
- The events path never reads the token. The picker, Disconnect and backfill do.
- If `BETTER_AUTH_SECRET` rotates, stored tokens can't be decrypted. The picker then answers `409 {code: "slack-reconnect"}` and the UI asks the user to **Add to Slack** again. Before round 3, this case was an unhandled 500.

**B5d Minimal scopes (bot, no user scopes):**

| Scope | Why |
| --- | --- |
| `channels:history`, `groups:history` | message events from public and private channels |
| `channels:read`, `groups:read` | the picker |

All four are requested at install, because adding a scope later forces every workspace to reinstall, and backfill needs `*:history`. Events to subscribe to: `message.channels`, `message.groups`, `app_uninstalled`, `tokens_revoked` (the last two need no scope).

**B5e Revocation and uninstall:**
- `app_uninstalled`, or `tokens_revoked` with `bot[]`, deletes the connections of that team whose `installed_at` is **at or before the event's `event_time`**. `installed_at` is Unix seconds from the Worker clock, set on every callback, so the comparison uses the same unit as Slack's whole-second `event_time`. A delayed event from an old installation cannot delete a newer one. The comparison is inclusive, so a stale row never survives: an install that finished in the same second as the uninstall is deleted too, and that user adds the app again. A re-authorization while the app is still installed updates the row in place and keeps its channels. Both handlers are idempotent, because Slack doesn't guarantee their order (tested, both orders).
- **Disconnect** in Settings deletes that connection. When it is the workspace's last connection, it first calls `apps.uninstall`:
  - success, or an already-revoked token (`invalid_auth`, `token_revoked`, `account_inactive`), counts as uninstalled, and the row is deleted;
  - any other failure keeps the row and answers an error, so the user can try Disconnect again. There is no hidden "uninstall pending" state.

  Linklog should not keep receiving message text from a workspace where nobody is linked. This was a swap in round 2, decided by the owner's word "seguridad" (tested: called exactly once, and late events afterward are harmless).
- The last-connection check is atomic. Disconnect first runs one conditional statement: `DELETE … WHERE team_id=? AND slack_user_id=? AND (SELECT count(*) FROM slack_connections WHERE team_id=?) > 1`. If it deletes the row, others remain and nothing else happens. If it deletes nothing, Linklog checks whether the row still exists. If it doesn't (another request already disconnected it), the answer is "already disconnected" and nothing is uninstalled. If it does, this is the last connection: Linklog calls `apps.uninstall`, then deletes the row. Two concurrent disconnects of the same last row both uninstall, which is harmless, because the second call gets an already-revoked token, which counts as success. D1 runs one statement at a time, so when two users disconnect the last two connections at once, exactly one of them sees itself as the last and uninstalls.
- Known edge: if someone in the same workspace finishes an install at the very moment the last connection is disconnected, the uninstall revokes the new token too, and Slack's `app_uninstalled` then removes that connection. That user sees the connection disappear and adds the app again. It is rare and visible, so there is no lock.
- Deleting a Linklog user cascades to their connections. Linklog has no self-service account deletion today (`/delete-user` is disabled). Whatever deletion path ships later must first run the same last-connection uninstall for each of the user's workspaces. If Slack fails there, the deletion still proceeds and logs a warning, because an account deletion can't be blocked by Slack; messages from a workspace with no connection are dropped and never stored.

**B5f Multi-tenant invariant:** the only route from a Slack event to a library is the connection row found by (`team_id`, `event.user`), plus its channel list. No code path takes a user id from the request.

**B5g Rate limits:**
- Each counted message charges 1 write to its author's Linklog account, as every API path does (arena A).
- The `links` quota (500 per hour) answers 200 and logs a warning; the `writes` budget answers 429 and Slack retries (arena A).
- Slack sends at most 30,000 events per workspace per app per hour.
- Installs are limited per user through the existing `app_rate_limits` table (20 per hour in the prototype).

**B5h Enterprise Grid org installs (`is_enterprise_install`) are refused in v1 (tested).**

### Attribution, retries and distribution

**Q5 / B7 Attribution: a new batch source, `{ source: "slack", teamId, teamName }`.** This reverses arena A, which reused `api` with the owner's key, because there is no longer a user-made API key to name. Auto-creating hidden API keys was rejected: they would be keys nobody can use, in Better Auth's `apikey` table, with revoke and delete meanings that don't apply.
- Activity shows `Extract context · Slack · <workspace>`.
- Usage gets a Slack row per workspace. Without the SQL change, Slack Links would be counted as Web.

In round 3's run with existing data, Usage went from `{web:2, apiKeys:["Slack:2"], slack:[]}` to `{web:2, apiKeys:["Slack:2"], slack:["Acme:1"]}`. A URL already saved on the web and posted again in Slack stays under Web.

**Q6 Retries and idempotency (arena A):** processing happens inline. A transient failure answers 5xx, and Slack retries immediately, after 1 minute and after 5 minutes. A redelivery is a Duplicate: no new Link, batch or links-quota charge. It still spends 1 write of the per-minute budget, because the write is charged before `addLinks` knows the URL is a Duplicate. Known edge: a Link deleted within the 5-minute retry window can come back.

**Q4 Feedback in Slack (arena A):** none in v1.

**B8 Distribution: start with unlisted distribution** ("Activate Public Distribution" in the app's settings). It needs no review, and anyone with the **Add to Slack** link can install the app in a workspace that allows it.
- Some workspaces only allow admin-approved or Marketplace apps. There, a user's click becomes a request to the admin.
- The Marketplace requires at least 10 active workspaces before an app can apply, then a preliminary review (about 10 business days) and a functional review (up to 10 weeks), plus a demo video. After that, the app's configuration is locked.
- Slack's 2025 terms say commercial distribution belongs on the Marketplace, and that unlisted apps are for development, testing and pilots.

The Marketplace is the owner's question below.

### Size

**B9 Size: 3 PRs.**
1. **Server.** Migration `slack_connections` plus rollback; install, callback and disconnect; the events route with revocation; the channels API; the `slack` source in Activity and Usage; the QA fake of slack.com; Worker tests; `docs/slack.md`. About 190 lines of new server code, +53/−9 in existing files, and more with tests and docs. The owner can use it right away by setting channels from the browser.
2. **Settings › Slack UI.** Add to Slack, connections, the channel picker, the Usage row and the reconnect state. Must ship before anyone else is invited.
3. **Backfill**, later. See the separate drafted ticket: [FAC-170-backfill-ticket.md](FAC-170-backfill-ticket.md).

None of the three touches the extension or `packages/browser-protocol`, so there is no version bump and no collision with tickets in progress. PR1 adds one migration.

## Alternatives rejected (arena B)

- **Better Auth `genericOAuth` as the install carrier.** It works, but it turns an install into a sign-in identity, loosens global linking and needs permanent route guards (B6).
- **Sign in with Slack.** Gives identity only, no bot and no events.
- **No channel picker ("invite = opt-in").** Unsafe in shared workspaces (B3).
- **`conversations.list` for the picker.** Leaks the names of private channels (B3).
- **Ownership by channel ("channel owner").** Needs a new concept and misroutes other members' posts (B4).
- **Hidden auto-created API keys for attribution** (B7).
- **Requesting scopes later, when backfill ships.** Every workspace would have to reinstall.
- **Arena A's personal Worker-secret app.** Superseded by Q1.

## Owner decisions (2026-11-25)

1. **Marketplace:** the app starts unlisted. Linklog applies to the Marketplace only once 10 active workspaces have it installed.
2. **Privacy:** accepted. Linklog receives and discards the text of messages by members who have no Slack connection, in channels the bot is in. The privacy policy gets a line about it, proposed on FAC-307.
3. **Design and tickets:** approved, together with the merge of PR #50 and the three tickets below.

Answers the moderator gave for the owner, accepted with the design: no reaction in Slack (Q4); `file_share` counts (Q3); Disconnect of the last connection uninstalls the app from the workspace (B5e); Enterprise Grid isn't supported in v1 (B5h).

## Manual steps for the owner in Slack

These are one-time steps, for the Linklog app itself:
1. Create the app at api.slack.com/apps, **From scratch**, in your workspace, named "Linklog". Using a manifest is fine.
2. Under **OAuth & Permissions**:
   - Add the Redirect URL `https://linklog.facundopri.com/api/slack/callback`.
   - Add the bot scopes `channels:history`, `groups:history`, `channels:read` and `groups:read`.
3. Under **Basic Information**, copy the Client ID, Client Secret and Signing Secret. Then run `wrangler secret put SLACK_CLIENT_SECRET --env production` and `wrangler secret put SLACK_SIGNING_SECRET --env production`. `SLACK_CLIENT_ID` is a plain var.
4. After PR1 is deployed, open **Event Subscriptions**:
   - Enable it with the Request URL `https://linklog.facundopri.com/api/slack/events`. It should show "Verified".
   - Subscribe to the bot events `message.channels`, `message.groups`, `app_uninstalled` and `tokens_revoked`.
5. Under **Manage Distribution**, complete the checklist and click **Activate Public Distribution**. This is unlisted: there is no review.
6. Optional: under **App Home** / **Basic Information**, add an icon and a description, which Slack shows on its consent page.

Then, as a user, like anyone else:

7. Signed in to Linklog, click **Add to Slack** in **Settings › Slack**, then **Allow**. Before FAC-322 ships, open `https://linklog.facundopri.com/api/slack/install` directly instead.
8. In #read-later, run `/invite @Linklog`, then tick #read-later in **Settings › Slack**. Before FAC-322 ships, use the channels API call documented in `docs/slack.md` (FAC-321 adds it): list the channels with `GET`, then `PUT` the chosen ids, from the browser console while signed in.
9. Hermes: arena A's note still holds. A Hermes that posts *as you* (no APP badge) has its links saved too; one that posts as a bot is ignored.

## Implementation tickets (created in Linear as FAC-321, FAC-322, FAC-323)

### Ticket 1 (FAC-321): Slack app, server (install, connections, events)

**Labels:** `Feature`. **Project:** Linklog. **Related:** FAC-170.

**Goal.** Any Linklog user can add the Linklog Slack app to their workspace. Messages they post in the channels they choose land in their library, attributed to `Slack · <workspace>`.

**Design.** Decisions B1–B9 above. The prototype is in `docs/grills/FAC-170-prototype/arena-b/`: a migration, routes, helpers, a diff of existing files, and scenarios. It is a prototype: rewrite it test-first, don't copy it. Read `docs/agents/d1-migrations.md` before writing the migration.

**Acceptance criteria.**
1. `GET /api/slack/install`:
   - Signed out, it gives 401.
   - Signed in, it sets the signed `{userId.nonce}` cookie and redirects to `oauth/v2/authorize` with exactly the four bot scopes and `state=nonce`.
   - Without the Slack config, the Slack routes answer 404.
2. Callback:
   - A valid callback creates or updates a `slack_connections` row (`team_id`, `slack_user_id` → user, `team_name`, `bot_user_id`, sealed token). The token never appears in plaintext in D1.
   - Refused with `?slack=invalid` and no row: a forged or foreign state, a missing or tampered cookie, a session user different from the cookie's user.
   - A replayed `code` gives `?slack=failed`, and so does `is_enterprise_install`.
   - An identity already linked to another user gives `?slack=taken`.
3. Several Linklog users in one team, and one user in two teams, each get their own row (tested).
4. Events:
   - Signature and `url_verification` work as in arena A.
   - A counted message by a linked author, in an allowed channel, saves its decoded URLs to that author's library with `source: "slack"`.
   - Each of these saves nothing and answers 200: an unlinked author, a non-allowed channel, a bot, an edit or a delete, a mismatched team.
   - URLs inside `<url>` / `<url|label>` are saved exactly as Slack sent them (no trailing-punctuation trim).
   - A redelivery (the same envelope and `event_id`, with `X-Slack-Retry-Num`) creates no Link, batch or links charge. It spends 1 write.
5. `app_uninstalled` and `tokens_revoked{bot}` delete the team's rows with `installed_at` (Unix seconds, Worker clock, set on every callback) at or before the event's `event_time`, in either order, idempotently. A delayed event leaves a newer installation in place. A re-authorization keeps the row's channels.
6. Channels API:
   - It lists `users.conversations(user)` intersected with the channels the bot is in, following `response_metadata.next_cursor` on every page.
   - A Slack `ok: false` answers a recoverable error, never an empty list.
   - It stores only ids from that list.
   - An undecryptable token answers `409 {code: "slack-reconnect"}`.
7. `DELETE` connection:
   - Only the owner can delete it.
   - The last-connection check and the delete are atomic: one conditional `DELETE` that only succeeds while other connections remain. If it deletes nothing and the row no longer exists, it answers "already disconnected" without uninstalling. If the row still exists, this is the last connection, and it calls `apps.uninstall` first. Success or an already-revoked token deletes the row. Any other failure keeps the row and answers an error, so the user can retry.
8. Activity shows `Extract context · Slack · <workspace>`. `GET /api/usage/summary` returns `month.slack[]` per workspace, and the Web count and API key rows are unchanged (tested with existing data).
9. Quotas and limits as in arena A: 1 write per message, links-quota 429 gives 200 plus `console.warn`, more than 100 URLs saves the first 100 plus a warning. Installs are rate-limited per user.
10. A QA fake of `slack.com` in `qa/video/worker-entry.ts` covers `oauth.v2.access` (single-use codes), `users.conversations`, `conversations.list` and `apps.uninstall`. `docs/slack.md` covers setup, behaviour and the known edges, including the owner's setup before FAC-322 (open `/api/slack/install` directly; the channels `GET`/`PUT` calls from the browser console). `docs/upload-api.md`'s Usage paragraph mentions Slack workspaces. GLOSSARY gains "Slack connection".

**Verification.** Worker tests for criteria 1–9. The `verify-linklog` scenarios script (prototype: `arena-b/scenarios-r3.ts.txt`) runs on an instance with existing web and API key data. Then a manual install in the owner's real workspace after deploy (manual steps 1–8).

+++ Agent notes
- The table also needs `installed_at`, set on every callback (criterion 5). The prototype only has `created_at`.
- The prototype's migration comment still says "AES-GCM derived from BETTER_AUTH_SECRET". The decision is `symmetricEncrypt` from `better-auth/crypto`.
- Readers of changed shapes: `BatchSource` (`worker/links.ts`, `public-api.ts`), `ActivitySheet.label()` and its `BatchConfig`, the `usage-summary.ts` SQL, the `Usage` type in `src/types.ts` and the Settings Usage UI. The `apiKeys` tests and journeys are unchanged and pass in the prototype.
- Not verified against real Slack: comma-joined scopes, a second non-admin user re-authorizing, `authed_user.id` on a bot-only install (taken from the docs' sample), admin-approval workspaces, `users.conversations` on private channels.
+++

### Ticket 2 (FAC-322): Settings › Slack UI

**Goal.** Users connect, choose channels and disconnect without the console.

**Acceptance.**
- An **Add to Slack** button.
- A list of connections, each showing its workspace.
- A channel picker with checkboxes and a hint: "Missing a channel? `/invite @Linklog` in Slack".
- **Disconnect** with confirmation.
- The `?slack=connected|invalid|taken|failed` outcomes shown as toasts.
- The reconnect state on 409.
- A Slack row in the Usage section.
- Verified with a `verify-linklog` journey and the `react-doctor` skill.

### Ticket 3 (FAC-323): backfill

See [FAC-170-backfill-ticket.md](FAC-170-backfill-ticket.md).

## Arena A decisions superseded by arena B

| Arena A | Arena B |
| --- | --- |
| Q1 personal app with Worker secrets | installable app (owner) |
| Q1b user = owner of an `lk_` key in `SLACK_LINKLOG_API_KEY` | a Slack connection per identity |
| Q2 the channel is whatever the bot was invited to | opt-in channel list per connection |
| Q3 no user filter | the author's connection decides |
| Q5 reuse `source: "api"` | new `slack` source |
| Q7 backfill as a local script | resumable job, separate ticket |
