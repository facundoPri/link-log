# Bulk delete

A user selects saved links and deletes them, with everything they own: extracted content and previews in R2, tag assignments, tag evaluations, lens results, media. A confirmation names the count and says it can't be undone. Tags and lenses stay (ADR 0003). Jobs still on a deleted link, running ones included, are cancelled: Activity keeps them under the link's title with "Cancelled: link deleted" while their batch runs; once it finishes, the cron (every 5 minutes) forgets the title and the job reads "Deleted link" (FAC-264). The Inspector's single delete does the same. The action is the `Delete` entry of `src/bulkActions.ts`, in the `Danger` group: a row in the `⌘K` palette and a full-width button in the mobile drawer. It has no single-key shortcut and no desktop toolbar button.

## Sub-features

- `delete-confirm` the confirmation reads "Delete N links?" with a `Cancel` and a destructive `Delete N links` button. `Cancel` keeps the links and the selection.
- `delete-cleanup` the links, their content (`GET /links/:id/content` answers 404) and their tag assignments go. A tag left with no links stays in the sidebar with 0.
- `delete-running-cancel` a link with a running job is deleted too. The toast reads "Deleted N links" with "Cancelled M jobs still processing them", and the selection empties. In Activity the job's batch reads `Cancelled`, and the job keeps the link's title with "Cancelled: link deleted".
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
- **Running cancel.** Save a `slow-ok` fixture (its Browser Markdown takes 24 s). Wait until `GET /batches/:id` lists its job as `running` and its preview title arrived, then select it with an idle link and delete both. Both go, the bar disappears, and the toast says "Cancelled 1 job still processing them". `GET /batches/:id` still lists the job with `link_id: null`, `step: "Cancelled"` and `error: "Cancelled: link deleted"`, and the batch counts it in `cancelled`, not `failed`. Its batch has no other job, so it's finished: within one cron tick (30 s in this harness) the job's `title` turns `"Deleted link"` and `link_title` null, with the same `error`; poll for that rather than for the link's title, which the cron may already have cleared. Open Activity (`getByRole("button", { name: /^(Activity|Extracting)/ })`) and expand the newest `Extract context`: the job reads "Deleted link" and "Cancelled: link deleted". The title kept while a batch still runs is covered by `tests/bulk-delete.test.ts`.
- **Isolation.** `apiAs(1).send("POST", "/links/delete", { ids: [demoAId] })` answers `deleted: []` and `cancelled: 0`, and Demo A's link stays.
- **Mobile.** `page.setViewportSize({ width: 390, height: 844 })`, select a row, `Actions`, then `getByRole("button", { name: "Delete 1 link" })` in the drawer.

## Gotchas

- Select a `slow-ok` link by its title only after its preview arrived (about 4 s). Before that its row is titled by host and the list re-renders under the click, which lands on the wrong row.
- R2 cleanup runs after the response (`waitUntil`). This harness can't list R2, so `delete-cleanup` reads content back through the API; `tests/bulk-delete.test.ts` checks the objects themselves, including content a cancelled workflow stores late.
