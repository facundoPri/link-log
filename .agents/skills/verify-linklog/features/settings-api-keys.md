# Settings and API keys

A signed-in user opens Settings from the user menu at the bottom of the sidebar. The page lives at `/settings` and shows an Account section (email, sign out) and an API keys section. There the user creates a named API key, sees its full `lk_` secret once, lists their keys (name, visible prefix, creation date, last use, status), revokes, enables and deletes them. A Revoked API key no longer authenticates and moves to a closed `Revoked keys (N)` section, where it can be enabled again or deleted. The page talks to Better Auth's API key plugin routes (`/api/auth/api-key/*`) through its client; there is no custom key route.

## Sub-features

- `settings-open` the user menu's `Settings` item opens `/settings`; reloading `/settings` stays there; `Back to library` returns to `/`.
- `settings-account` shows the email and a `Sign out` button.
- `key-create` a name creates a key; the secret is shown once with `Copy` and `Done`, and is gone after `Done` or a reload.
- `key-list` each row shows the name, an `Active`/`Revoked` badge, `lk_…` prefix, `Created <date>` and `Last used <relative>` or `Never used`.
- `key-revoke` `Revoke` asks for confirmation; the row then leaves the active list for the `Revoked keys (N)` section.
- `key-revoked-section` `Revoked keys (N)` is a native disclosure, closed by default, only present when something is revoked; opened it lists the revoked keys in a scrollable list (bounded height), each with `Enable` and `Delete` and no `Revoke`. `Enable` returns the key to the active list and it authenticates again.
- `key-delete` `Delete` (active or revoked rows) asks for confirmation naming the key; `Cancel` keeps it, `Delete` removes it for good (its secret answers 401). Names may repeat and there is no limit on keys.
- `usage` the `Usage` region (between Account and API keys) opens with `Links saved this hour` as `<used> / 500 · resets in N min` (the only cap; there is no Jobs row), then `This month (<Month Year>)` (UTC calendar month): `Links saved` with a `Web` row and one `API key: <name>` row per key that added Links, under the name stored with those Links (a Revoked API key shows a `Revoked` badge, a deleted one `Deleted`; Duplicates never count), then a `Usage by feature` table (Extract, Content, Lenses, Autotag, OCR, Autogroup, plus `Other` only when a call belongs to none) of runs, units (tokens / browser time, from `sm` up; under the name on a phone) and estimated cost, with a Total. A cost cell reads `N unpriced` for calls without a known price and `—` when nothing was billed. Each API key row also reads `N links this month` (`0 links` for a key that added none). API: `GET /api/usage/summary` -> `{ quotas: { links }, month: { start, links, web, apiKeys: [{ id, name, links, status }], features: [{ key, label, runs, inputTokens, outputTokens, browserMs, usd, unknownCostCalls }], total: { usd, unknownCostCalls } } }`. Browser Rendering is priced at $0.09 per browser hour (list price); the fixture Jev provider has no price, so its calls count as unpriced. Reference: `journeys/usage-settings.ts` (seeds with real Bearer secrets and uses deltas, so it can be rerun on one instance).
- `key-isolation` Demo B never sees Demo A's keys; getting, updating or deleting a foreign key answers 404.
- `invalid-json` a body that is not valid JSON answers 400 `Body is not valid JSON.` (with the parser's position when it gives one); JSON that is not an object answers 400 `Send a JSON object as the body.`.

## How to get to it (user POV)

- Sidebar footer: the button named with the account email opens a menu with `Settings` and `Sign out`.
- Directly at `/settings`.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.

- **Open.** `page.getByRole("button", { name: "demo-a@linklog.test" }).click()`, then `getByRole("menuitem", { name: "Settings" })`. The heading `Settings` is visible and the URL ends in `/settings`.
- **Sections.** `getByRole("region", { name: "Account" })` and `getByRole("region", { name: "API keys" })`.
- **Create.** In the API keys region, fill `getByLabel("Name")` and click `Create key`. The secret is the text of `getByLabel("New API key")`. Read back with `api.get("/auth/api-key/list")`: the list holds `{ id, name, start, enabled, createdAt, lastRequest, ... }` and never the secret. `api.send("POST", "/auth/api-key/create", { name })` answers `{ id, name, key, ... }`, where `key` is the secret.
- **Revoke.** `getByRole("list", { name: "API keys" }).getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Revoke" })`, then the `alertdialog`'s `Revoke` button. API: `POST /auth/api-key/update { keyId, enabled: false }`.
- **Revoked section.** `keys.locator("details")`; its `summary` reads `Revoked keys (N)`; click it to open. Rows are in `getByRole("list", { name: "Revoked API keys" })` and the list is `overflow-y: auto` with a max height. `Enable` is `POST /auth/api-key/update { keyId, enabled: true }`.
- **Delete.** The row's `Delete` button, then the `alertdialog`'s `Delete` button (or `Cancel`). API: `POST /auth/api-key/delete { keyId }`.
- **Isolation.** `apiAs(1).get("/auth/api-key/list")` and `apiAs(1).send("POST", "/auth/api-key/update", { keyId, enabled: true })` (rejects with `→ 404`).
- **Names and count.** Keys persist across journeys on one instance: use a unique key name per run and read the `Revoked keys (N)` count as a delta.
- Reference: `journeys/api-keys-settings.ts` (create, revoke, isolation), `journeys/api-keys-revoked-section.ts` (revoked section, enable, delete, deleted key in Usage, invalid JSON), `journeys/usage-settings.ts`.

## Gotchas

- `Last used` only changes when a key is verified; until the public API exists nothing in the UI uses a key, so every row reads `Never used`.
- `Copy` uses the Clipboard API, which headless Chromium may refuse; the toast then says it could not copy. Assert the secret text, not the clipboard.
