# Settings and API keys

A signed-in user opens Settings from the user menu at the bottom of the sidebar. The page lives at `/settings` and shows an Account section (email, sign out) and an API keys section. There the user creates a named API key, sees its full `lk_` secret once, lists their keys (name, visible prefix, creation date, last use, status) and revokes one. A Revoked API key stays listed and no longer authenticates.

## Sub-features

- `settings-open` the user menu's `Settings` item opens `/settings`; reloading `/settings` stays there; `Back to library` returns to `/`.
- `settings-account` shows the email and a `Sign out` button.
- `key-create` a name creates a key; the secret is shown once with `Copy` and `Done`, and is gone after `Done` or a reload.
- `key-list` each row shows the name, an `Active`/`Revoked` badge, `lk_…` prefix, `Created <date>` and `Last used <relative>` or `Never used`.
- `key-revoke` `Revoke` asks for confirmation; the row then shows `Revoked` and loses its `Revoke` button.
- `key-regenerate` `Regenerate` on an active row asks for confirmation, then shows a new secret once (same name) and the old row reads `Revoked`. Revoked rows have no `Regenerate`.
- `key-regenerate-unconfirmed` when the old key's revoke cannot be confirmed, the new secret is still shown, plus the alert `The old key (lk_abc…) may still work. Revoke it now.` (the old key's prefix). The old row stays `Active` and gains a `Revoke pending` badge that outlives the alert (`Done`) until the key is revoked; the list is refetched so no stale row stays Active. API: `oldKey.status` is `unconfirmed` instead of `revoked`.
- `key-cap` at 10 active keys `Create key` shows the alert `You have 10 active API keys. Revoke one to create another.`; revoking one allows creating again. Regenerating at 10 still works (it replaces a key).
- `usage` the `Usage` region (between Account and API keys) lists `Links` and `Jobs` as `<used> / <max> this hour` with `resets in N minutes`, then `New Links in <Month Year>` (UTC calendar month) with a `Web` row and one `API key: <name>` row per key that added Links, Revoked API keys included. Duplicates never count. Each API key row also reads `N links this month` (`0 links` for a key that added none). API: `GET /api/usage/summary` -> `{ quotas: { links, jobs }, month: { start, links, web, apiKeys: [{ id, name, links }] } }`. Reference: `journeys/usage-settings.ts` (seeds with real Bearer secrets and uses deltas, so it can be rerun on one instance).
- `key-isolation` Demo B never sees Demo A's keys; revoking or regenerating a foreign key answers 404.

## How to get to it (user POV)

- Sidebar footer: the button named with the account email opens a menu with `Settings` and `Sign out`.
- Directly at `/settings`.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`. Keys persist across journeys on one instance: use a unique key name per run.

- **Open.** `page.getByRole("button", { name: "demo-a@linklog.test" }).click()`, then `getByRole("menuitem", { name: "Settings" })`. The heading `Settings` is visible and the URL ends in `/settings`.
- **Sections.** `getByRole("region", { name: "Account" })` and `getByRole("region", { name: "API keys" })`.
- **Create.** In the API keys region, fill `getByLabel("Name")` and click `Create key`. The secret is the text of `getByLabel("New API key")`. Read back with `api.get("/api-keys")`: the list holds `{ id, name, prefix, createdAt, lastUsedAt, status }` and never the secret.
- **Revoke.** `getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Revoke" })`, then the `alertdialog`'s `Revoke` button.
- **Isolation.** `apiAs(1).get("/api-keys")` and `apiAs(1).send("POST", "/api-keys/<id>/revoke", {})` (rejects with `→ 404`).
- **Regenerate.** The row's `Regenerate` button, then the `alertdialog`'s `Regenerate` button. API: `POST /api-keys/<id>/regenerate` → 201 `{ apiKey, secret, oldKey: { id, status } }`, where `oldKey.status` is `revoked` once confirmed and `unconfirmed` when both revoke attempts lost their answer (the old key may still work; revoke it by hand). A 409 `api_key_revoked` means the key was already revoked.
- **Unconfirmed regenerate.** Fault injection: a SQLite trigger in the instance's local D1 (`.cache/verify-linklog/current` → `state/qa-video/v3/d1/miniflare-D1DatabaseObject/*.sqlite`) that aborts `UPDATE OF enabled` for one key id; drop it before revoking by hand.
- **Cap.** Create fillers with `api.send("POST", "/api-keys", { name })`; the 11th answers 409 `{ error, code: "api_key_limit" }`. A journey that fills the account to 10 leaves later journeys unable to create keys: `V down` and `V up` before running another.
- Reference: `journeys/api-keys-settings.ts`, `journeys/api-keys-regenerate.ts`, `journeys/api-keys-regenerate-unconfirmed.ts`.

## Gotchas

- `Last used` only changes when a key is verified; until the public API exists nothing in the UI uses a key, so every row reads `Never used`.
- `Copy` uses the Clipboard API, which headless Chromium may refuse; the toast then says it could not copy. Assert the secret text, not the clipboard.
