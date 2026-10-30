# FAC-45 bulk actions: prototype comparison

Status: research and throwaway prototype. The owner chose a hybrid of A and B, prototyped as **variant D** below, and it is **awaiting owner confirmation** before any production work. Nothing here is production code, and no variant has been folded into the app.

Question: how should the library's selection surface fit today's four actions (Auto-tag, Lens, Extract context, Copy) plus FAC-46 bulk delete, FAC-47 bulk open and later tag/organize actions, while keeping the selection count, per-action availability, progress and partial failures visible?

Inputs:

- [fac-45-current-inventory.md](fac-45-current-inventory.md) covers what the app does today, with file:line citations.
- [fac-45-bulk-actions-primary-sources.md](fac-45-bulk-actions-primary-sources.md) covers Spectrum, Polaris, Carbon, Primer, Linear, Apple HIG and MDN. Each source is labelled documented or observed.

## Run it

```sh
bun run prototype:bulk
```

This starts an isolated verify-linklog instance with fixture sites only, so it makes no real network calls and costs nothing. It seeds Demo A with 12 links of mixed states, 3 tags and 1 lens, then prints:

- http://127.0.0.1:3400/?variant=D (the owner's hybrid)
- http://127.0.0.1:3400/?variant=A
- http://127.0.0.1:3400/?variant=B
- http://127.0.0.1:3400/?variant=C

The port is the first free pair from 3400. Sign in as `demo-a@linklog.test` / `linklog-demo-a-password`. Select links with the checkboxes, shift-click or ⌘A. Switch variants with the magenta bar or ←/→. Stop the instance with `bun .agents/skills/verify-linklog/scripts/verify.ts down`.

Every action is a stub. Nothing is written, deleted or opened, except that Copy really writes to the clipboard. Stub runs tick through the eligible links. Links that failed to fetch fail Extract, and `nowhere.*` fails Open, so partial failure is visible. Delete waits through a 5 s undo window and then pretends to run.

The prototype is mounted only when the host is loopback and `?variant=` is present. Without the param, today's `SelectionBar` renders unchanged. The gate is the hostname, not `NODE_ENV`, because the verify instance bundles without dev mode.

Files (throwaway):

- `src/components/BulkActions.prototype.tsx` holds the variants, the switcher and the stub runner.
- `src/App.tsx` has a 14-line mount next to `SelectionBar`.
- `scripts/prototype-bulk.ts` and the `prototype:bulk` script in `package.json` start and seed the instance.

## Variants

| | A. Promoted bar + More | B. Command palette | C. Selection panel |
|---|---|---|---|
| Structure | Today's floating pill. The count is a menu, three actions are promoted (Auto-tag, Lens, Open N), and the rest sit in a grouped More menu | A minimal chip ("7 selected · Actions ⌘K"). Every action lives in a selection-scoped palette with letter shortcuts | A docked right panel lists the selected links, every action as a row grouped Process/Organize/Share/Danger, and a results log |
| Count | Pill, plus a menu for select-all-visible and clear | Chip, plus "Acting on 7 selected" in the palette | Panel header, plus the selected links themselves (removable) |
| Availability | "4/7" badge on the button. Reason in the tooltip | "4 of 7" plus the reason line inline on every item | "4/7" plus the reason line on every row |
| Progress | A run card stacks above the pill with a bar | A spinner and "3/7" in the chip. Details in a popover | Results section at the bottom of the panel |
| Partial failure | The card lists failed links with reasons. "Select failed" reselects them | Chip shows "3 failed". The popover lists them and has Select failed | Same list in the panel log |
| Delete | In More, under Danger. Confirm, then a 5 s undo | Palette item (⌫). Confirm, then undo in the chip | Separated danger zone. Confirm, then undo in the log |
| Room for more actions | A More menu entry each. The promoted set stays fixed | Unbounded, with no layout change | Unbounded, but the panel gets tall |
| Cost to the page | Covers about 50 px of list bottom, same as today | Covers almost nothing | Covers 360 px on the right, including row Retry/Dismiss and the inspector |

Screenshots (1280×820 unless noted, in `assets/fac-45/`):

- A: [selected](assets/fac-45/A-1-selected.png), [More menu](assets/fac-45/A-2-more-menu.png), [running](assets/fac-45/A-3-running.png), [partial failure](assets/fac-45/A-4-partial-failure.png), [after Select failed](assets/fac-45/A-5-select-failed.png).
- B: [chip](assets/fac-45/B-1-selected-chip.png), [palette](assets/fac-45/B-2-palette.png), [lens sub-page, opened with `L`](assets/fac-45/B-3-lens-subpage.png), [chip progress](assets/fac-45/B-4-chip-progress.png), [failure popover](assets/fac-45/B-5-results-popover.png) (1218 px wide).
- C: [panel](assets/fac-45/C-1-panel.png), [delete undo window](assets/fac-45/C-2-delete-undo.png), [Open with 1 failure](assets/fac-45/C-3-results.png).

## Variant D: the owner's hybrid

Owner feedback on A/B/C: A on desktop, B on narrow screens, a bottom drawer on mobile, a palette without scrolling, and direct shortcuts on every layout. D implements exactly that on the same route and data.

| Width | Surface |
|---|---|
| ≥1100 px (desktop) | A's bar: count menu, Auto-tag `T`, Lens `L`, Open N `O`, More `⌘K`. Every promoted button shows its key. More and ⌘K open the compact palette |
| 768 to 1099 px (narrow) | B's chip ("7 selected · Actions ⌘K") and the same compact palette |
| <768 px (mobile) | A full-width chip with a large Actions button. It opens a bottom drawer with a 4-column tile grid (count badge when only some links are eligible), one line explaining the counts, and a separate full-width "Delete 7 links" button. Lens and tag pickers replace the tiles inside the drawer |

The breakpoints match App's existing `narrow` (1099 px) and `mobile` (767 px) media queries.

Direct shortcuts work whenever links are selected and focus is not in a text field. `T` Auto-tag, `L` Lens (opens the picker), `E` Extract, `G` Add tag (opens the picker), `O` Open in tabs, `C` Copy URLs, `⇧C` Copy URLs + titles, `⌫` Delete (confirm, then 5 s undo), `⌘K` palette. The same keys run the action from inside the palette while its filter is empty.

The palette is now one line per action. The skip reason trails the label, groups sit in a left gutter, and each row shows the count and key. Observed at 1280×820, all eight actions fit with no scrollbar (`scrollHeight` 288 equals `clientHeight`, overflow visible). The mobile drawer is 347 px tall at 390×844, also without scrolling.

D also fixes the Escape bug for its own overlays. Escape that closes the palette, a menu or the drawer no longer clears the selection (observed). The fix records whether an overlay was open in the window capture phase and stops the event at `document` before App's window handler sees it. The production fix can be the same.

Screenshots:

- Desktop: [bar](assets/fac-45/D-1-desktop-bar.png), [palette](assets/fac-45/D-2-desktop-palette.png), [after pressing E](assets/fac-45/D-3-desktop-shortcut-run.png).
- Narrow, 900 px: [chip](assets/fac-45/D-4-narrow-chip.png), [palette](assets/fac-45/D-5-narrow-palette.png).
- Mobile, 390 px: [chip](assets/fac-45/D-6-mobile-chip.png), [drawer](assets/fac-45/D-7-mobile-drawer.png), [lens picker](assets/fac-45/D-8-mobile-lens-picker.png), [run in progress](assets/fac-45/D-9-mobile-result.png).

Known rough edges, left for the production rewrite:

- The 7 non-danger tiles leave one empty cell in the 4-column grid.
- The mobile chip shows "2/4" without naming the running action.
- Mobile was checked with Chromium device emulation, not on a phone.

## What the prototype showed

These are observed in Ego Lite against the isolated instance, not inferred.

1. **Per-link availability changes the copy everywhere.** With 7 links selected (3 without content), Auto-tag and Lens are "4 of 7" and the reason "3 of 7 will be skipped: No content yet" fits on one line in B and C. In A it only fits in a tooltip, so the badge carries the signal and the reason is hidden until hover.
2. **⌘K is already Add link.** B has to take ⌘K over while a selection exists. Without a selection, ⌘K still opens Add link. This matches Linear's model (documented), but it is a behaviour change the owner should accept explicitly.
3. **Escape is overloaded.** Pressing Escape to close a menu also clears the whole selection, because App's window-level Escape handler clears `picked` (`src/App.tsx:440` on this branch, 438 on main). Observed in prototype A and in today's unmodified `SelectionBar` (open Copy, press Escape, the bar disappears) on the isolated instance. This is an existing bug worth its own ticket, whichever variant wins.
4. **"Select failed" is the partial-failure affordance that works in all three.** After a run, reselecting only the failed links lets the user retry, open or delete them with the same surface. It needs no new screen.
5. **C hides row-level Retry/Dismiss** and would fight the inspector for the right edge. It is the clearest for long runs and the weakest for a 3-link job.
6. **Selection survives filter changes** (inventory, App.tsx). None of the variants fix this, but A's count menu and C's list make hidden selected links visible. B does not.

## Recommendation

**A as the default surface, with B's palette as the keyboard and long-tail layer.** Both read from the same action registry and share one results surface. The C panel is not recommended.

Why:

- A keeps today's mental model and today's footprint. It is the smallest change for users and for `SelectionBar.tsx`. Polaris (documented) argues for exactly this "small, stable promoted set + one menu".
- B scales to tag/untag/move without touching the bar, and shows reasons inline, which A cannot. The cost is a ⌘K behaviour change and weaker discoverability on touch, which A's visible buttons cover.
- C is the only one that gives failures a full home, but the A run card with "Select failed" covered the same need in the prototype at a fraction of the page cost.

Open choices for the owner:

- Which three actions are promoted in A. The prototype uses Auto-tag, Lens, Open N. Research suggests Auto-tag and Extract.
- Whether ⌘K becomes selection-scoped while links are selected.
- Delete confirmation: confirm + undo (prototype), undo only (needs a soft delete in FAC-46), or confirm only (hard delete).

## Interface for FAC-46 and FAC-47

A bulk action should register one entry. The surface owns the count, availability display, progress and the results card:

```ts
type BulkAction = {
  id: string;
  label: string;
  group: "Process" | "Organize" | "Share" | "Danger";
  shortcut?: string;
  picker?: "lens" | "tag";
  // Per-link split, so every surface can say "4 of 7" and why the rest are skipped.
  availability: (links: Link[], ctx) => { eligible: Link[]; skipped: { link: Link; reason: string }[]; blocked: string | null };
  // Per-link outcome, so partial failure and "Select failed" work the same for every action.
  run: (eligible: Link[], detail?: string) => AsyncIterable<{ id: string; ok: true } | { id: string; ok: false; reason: string }>;
  confirm?: (eligible: Link[]) => string; // destructive copy, e.g. "Delete 7 links"
  undoWindowMs?: number;
};
```

- **FAC-46 delete.** Skip links with an active job ("Wait for the running job to finish", matching `DELETE /links/:id`), and yield per-link results. The undo window needs either a client-side delay or a soft delete. That is the owner decision above.
- **FAC-47 open.** `window.open` needs a user gesture per call and returns `null` when blocked (MDN, documented). Open synchronously inside the click and report blocked tabs as failed links with a reason. The extension bridge has no open-from-URL command today (inventory), so "blocked" reporting comes from `window.open` unless FAC-47 adds one.
- Existing batch actions (Auto-tag, Lens, Extract) already have job state from `/batches`. Their `run` would adapt batch job progress into the same per-link stream.

## Capture

The variants live on branch `fac-45-bulk-ui-prototype` only, which is not for merge. After the owner picks, the real build follows the Feature playbook and rewrites the winner properly inside `SelectionBar`. The prototype files and the App mount stay off main.
