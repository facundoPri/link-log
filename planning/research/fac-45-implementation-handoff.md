# FAC-45 implementation handoff

Decided on 2026-10-29: the owner chose **variant D** of the throwaway prototype. Build it properly in production. Do not merge or copy the prototype code.

- Ticket: https://linear.app/facundopri/issue/FAC-45/redesign-the-existing-bulk-action-ui-to-support-more-actions
- Prototype branch (reference only, never merge): https://github.com/facundoPri/link-log/tree/fac-45-bulk-ui-prototype
- What D is and why it won: [fac-45-bulk-actions-prototype.md](fac-45-bulk-actions-prototype.md), section "Variant D", plus screenshots `assets/fac-45/D-*.png`.
- Today's selection code with file:line citations: [fac-45-current-inventory.md](fac-45-current-inventory.md).
- Research behind the choices: [fac-45-bulk-actions-primary-sources.md](fac-45-bulk-actions-primary-sources.md).

## See it before building

```sh
git switch fac-45-bulk-ui-prototype
bun run prototype:bulk     # isolated verify-linklog instance, seeded, stubs only
# open http://127.0.0.1:3400/?variant=D as demo-a@linklog.test
bun .agents/skills/verify-linklog/scripts/verify.ts down
```

The reference implementation is `src/components/BulkActions.prototype.tsx` (`VariantD`, `DesktopBar`, `MobileBar`, `CompactPalette`, `ActionDrawer`). It was written with no tests and stubbed runs, so treat it as a picture of the behaviour, not as code to keep.

Start the production branch from `main`, not from the prototype branch.

## Target behaviour

The selection surface depends on width. The breakpoints are App's existing `narrow` (≤1099 px) and `mobile` (≤767 px) queries:

| Width | Surface |
|---|---|
| Desktop | Floating bar. Count button with a menu (Select all N visible, Clear). Auto-tag `T`, Lens `L`, Open N `O`, each showing its key and an "eligible/total" badge when only some links qualify, with the skip reason in a tooltip. Then More `⌘K` and Clear. Job progress and results stack above the bar |
| Narrow | Chip "N selected · Actions ⌘K · ×". Progress shows in the chip with a results popover |
| Mobile | Bar with clear on the left, then "N selected" over "Select all N" (or "All N selected · Deselect all", or the running job), then a large "Actions ⌃" button. It opens a bottom drawer with 4-column tiles, a line explaining the counts, a separate "Delete N links", and lens/tag pickers in place. Once the selection clears, the bar stays to report the last run, with "Details" |

The palette (desktop More / ⌘K, and narrow) has one row per action: icon, label, skip reason, `eligible/total`, key. Groups go in a left gutter (Process, Organize, Share, Danger). It has no scrollbar at today's action count. The palette has a free-text filter. With the filter empty, pressing an action's key runs it. Lens and tag open a sub-page in the palette.

Shortcuts work on every layout while links are selected and focus is not in a text field or an open overlay:

| Key | Action |
|---|---|
| `T` | Auto-tag |
| `L` | Lens (opens the picker) |
| `E` | Extract context |
| `G` | Add tag (opens the picker) |
| `O` | Open in tabs (FAC-47) |
| `C` / `⇧C` | Copy URLs / with titles |
| `⌫` / `Delete` | Delete (FAC-46) |
| `⌘K` | Palette. Only while links are selected; otherwise it stays Add link |

## Must keep from today

- Every current confirm path: the no-content dialog for Auto-tag (`confirmNoContent`), replacing manual tags (`confirmAutoTag`), Extract confirmation (`confirmExtract`), and Lens "New lens…" in the lens picker.
- `runBatch` and the chunked `POST /api/batches` (`src/batches.ts`), the batch toasts, Activity, and the `running` and `jevReason` gating. The inventory, section 2, lists their exact behaviour.
- Browser view keeps its own `BrowserSelectionBar`. Do not touch it.
- Copy writes to the clipboard and toasts the count.

## Changes to make

1. **Escape bug (existing, ship it first, on its own).** Escape that closes a menu, popover or dialog currently also clears the selection, because App's window `keydown` handler clears `picked` (`src/App.tsx`, `if (e.key === "Escape" && !dialog)`). It is observed on today's bar. The prototype fix records in the window capture phase whether an overlay was open, then stops the event at `document` before App's handler sees it. A simpler production fix may be for the handler to ignore Escape when `e.defaultPrevented` is set or when an overlay is open. Test it in the browser either way.
2. **Action registry.** One typed list of bulk actions that every layout reads. This is the shape FAC-46 and FAC-47 plug into:

   ```ts
   type BulkAction = {
     id: string;
     label: string;
     group: "Process" | "Organize" | "Share" | "Danger";
     shortcut?: string;
     picker?: "lens" | "tag";
     availability: (links: Link[], ctx: { tags: Tag[]; jevReason: string | null }) => {
       eligible: Link[];
       skipped: { link: Link; reason: string }[];
       blocked: string | null;
     };
     run: (eligible: Link[], detail?: string) => Promise<void>; // reports per-link results to the results surface
   };
   ```

   Auto-tag and Lens skip links without content (`!content_key && content_state !== "queued"`, the predicate App already uses). Delete skips links with an active job, because `DELETE /links/:id` refuses them. Keep this list as the only place that knows availability rules, so the three layouts cannot drift.
3. **Results surface with per-link failures and "Select failed".** Today the batch toast says "F failed — see Activity", and the per-link reason only shows in Activity. Feed the results card, chip popover and mobile "Details" from the same batch/job state `ActivitySheet` already reads. "Select failed" sets `picked` to the failed link ids. The data for this exists in `/batches`. Confirm the per-job fields before designing the adapter.
4. **Desktop bar, narrow chip and palette, mobile bar and drawer.** Rebuild `SelectionBar.tsx` around the registry. Use the existing shadcn pieces (`CommandDialog`, `Sheet side="bottom"`, `DropdownMenu`, `Tooltip`, `Kbd`). The prototype's `useLayout` duplicates App's `useMedia`. Pass App's `narrow`/`mobile` down instead.
5. **Shortcuts and ⌘K scoping** in App's existing keydown handler, next to the ⌘A and Escape cases. Do not add a second window listener.
6. **README.** Update the selection-bar section (`README.md:28`, which also omits Copy today) to list the layouts and keys. The ticket acceptance asks for the pattern to be documented.

## Decisions

- Decided: variant D; promoted desktop actions Auto-tag, Lens, Open; ⌘K is the palette while links are selected.
- **Still open, ask the owner before FAC-46 lands:** Delete protection. The options are confirm plus a 5 s undo (the prototype's choice), undo only (needs soft delete in FAC-46), or confirm only. Until FAC-46 exists, the Delete row can stay out of the registry.

## Coordination

- Another session is implementing **FAC-47 (bulk open)** on the current `SelectionBar`, in the `fac-47-bulk-open` worktree. Agree on who rebases. The low-conflict path is for FAC-47 to land first, then FAC-45 moves its action into the registry as `open`. FAC-47 must call `window.open` synchronously inside the click or keypress, and report `null` returns as failed links (MDN, see research).
- **FAC-46 (bulk delete)** registers `delete` with the shortcut `⌫` and the Danger group. It needs per-link results for partial failures.

## Verify

- Unit tests on behaviour a user would notice: the availability split (counts and reasons for mixed selections), and that shortcuts are ignored while typing in search. Do not test the prototype.
- Browser proof with `verify-linklog`. Write a journey that covers:
  - desktop 1280 px: bar, palette with no scroll, one shortcut run;
  - narrow 900 px: chip and palette;
  - mobile 390 px: bar, Select all, drawer, lens picker;
  - Escape on an open menu keeping the selection;
  - ⌘K still opening Add link with nothing selected.

  Use fixture links that fail extraction (`gone`, `nowhere`, `pdf`) so "Select failed" can be shown.
- Then `bun run typecheck` and `bun test`.

## Suggested skills

- `poteto-mode`, Feature playbook: name the data shape first (the registry above).
- `tdd`: for the availability rules and the Escape fix.
- `verify-linklog`: the browser proof above.
- `no-comments`, then `pr`: before review and for the PR body.

## Cleanup

When the production version merges, add a link to that PR on the FAC-45 ticket. Leave the prototype branch as the record. Its App mount and `prototype:bulk` script never reach `main`.
