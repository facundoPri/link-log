# Bulk delete

A user selects saved links and deletes them, with everything they own: extracted content and previews in R2, tag assignments, tag evaluations, lens results, media and pending jobs. A confirmation names the count and says it can't be undone. Tags and lenses stay (ADR 0003). A link whose job is already running is skipped, reported in the toast and left selected. The action is the `Delete` entry of `src/bulkActions.ts`, in the `Danger` group: a row in the `⌘K` palette and a full-width button in the mobile drawer. It has no single-key shortcut and no desktop toolbar button.

## Sub-features

- `delete-confirm` the confirmation reads "Delete N links?" with a `Cancel` and a destructive `Delete N links` button. `Cancel` keeps the links and the selection.
- `delete-cleanup` the links, their content (`GET /links/:id/content` answers 404) and their tag assignments go. A tag left with no links stays in the sidebar with 0.
- `delete-running-skip` a link with a running job stays. The toast reads "Deleted N links" with "M still processing, skipped", and only the skipped links stay selected.
- `delete-chunks` the UI sends 100 ids per `POST /api/links/delete`. A failed request stops the run, the toast reads "Deleted X of N links", and the links not deleted stay selected.
- `delete-isolation` another account's ids are ignored, like missing ones: the reply lists nothing deleted.

## How to get to it (user POV)

- Desktop: select rows with their `Select <title>` checkbox, press `⌘K` (or `More` in the `Selected link actions` toolbar) and pick `Delete` under `Danger`.
- Phones: select rows, tap `Actions`, then the full-width `Delete N links` button at the bottom of the drawer.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`. `journeys/bulk-delete.ts` is the reference: it drives `⌘K` and `More` on desktop and the drawer on mobile, and covers every sub-feature except `delete-chunks`, which `tests/delete-chunks.test.ts` covers.

- **Confirm and cancel.** Select two links, `ControlOrMeta+k`, click the `Delete` option. `getByRole("alertdialog", { name: "Delete 2 links?" })` opens. Click `Cancel`: both links stay (`api.link(url)`), the bar still reads "2 selected".
- **Delete.** Confirm with `Delete 2 links`. Check the API first (`api.link(url)` is null, `GET /links/:id/content` throws with `→ 404`, `api.library().tags` still lists the tag), then the rows, the "Deleted 2 links" toast and the bar disappearing. No `GET /api/library` follows: the list updates from the returned library.
- **Running skip.** Save a `slow-ok` fixture (its Browser Markdown takes 24 s). Wait until `GET /batches/:id` lists its job as `running` and its preview title arrived, then select it with an idle link and delete both. The idle link goes, the running one stays selected, and the toast says "1 still processing, skipped".
- **Isolation.** `apiAs(1).send("POST", "/links/delete", { ids: [demoAId] })` answers `deleted: []`, and Demo A's link stays.
- **Mobile.** `page.setViewportSize({ width: 390, height: 844 })`, select a row, `Actions`, then `getByRole("button", { name: "Delete 1 link" })` in the drawer.

## Gotchas

- Select a `slow-ok` link by its title only after its preview arrived (about 4 s). Before that its row is titled by host and the list re-renders under the click, which lands on the wrong row.
- R2 cleanup runs after the response (`waitUntil`). This harness can't list R2, so `delete-cleanup` reads content back through the API; `tests/bulk-delete.test.ts` checks the objects themselves.
