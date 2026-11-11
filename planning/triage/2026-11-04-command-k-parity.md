# ⌘K, selection actions and URL entry differ between Library and Browser (FAC-184)

## Symptom

The owner reported it on 2026-11-04 from the deployed web app in Chrome. In Library, `⌘K` opens the actions palette while links are selected and the **Add link** dialog otherwise. In Browser, `⌘K` always opens the same **Add link** dialog, which saves to the Library, even with tabs selected. Browser has its own selection bar, with no palette, no keys and a different phone layout. Pasting a URL in Browser saves it to the Library instead of opening it.

Measurable restatement: for each view (Library, Browser) and each selection size (0, 1, 2), which UI one `⌘K` opens, whether letter keys run selection actions, and what pasting a URL outside a field persists.

## Evidence

- Live build: `bunx wrangler deployments list --env production` shows version `4c5f2dd4` tagged `c0f56af` (2026-11-04T15:01Z), the commit this worktree was tested at. No production data was read; the behavior is entirely client-side, so the backend holds no trace of it.
- Library and Browser without the extension, `verify-linklog` at `c0f56af`, journey `.cache/fac184/before-library.ts` (10/10 checks):
  - Library, 0 selected: `⌘K` opens **Add link**. 1 and 2 selected: `⌘K` opens **Bulk actions**. Phone, 2 selected: `⌘K` opens the drawer.
  - Browser: `⌘K` opens the Library **Add link** dialog.
  - Browser: pasting a fixture URL outside a field created a Library link (6 → 7 links).
- Browser with real tabs: Chrome for Testing 153.0.8010.12, extension built from this worktree, isolated profile and ports (`.cache/fac184/before-native.ts`):
  - `⌘K` with 0, 1 and 2 tabs selected opened **Add link** every time.
  - `S` and `C` with 2 tabs selected did nothing (links 0 → 0, no dialog).
  - Pasting a URL: tabs in the window 7 → 7, Library links 0 → 1.
  - At 900 px and 390 px the Browser bar wraps into a grid of its own, unlike the Library chip and drawer.

## Cause

Certain, from the code at `c0f56af`:

1. One `keydown` listener in `src/App.tsx:474-556` owns `⌘K` for every view. Its branch is `hasPicked && view !== "browser" ? palette : setDialog("add")`. `hasPicked` is the Library selection, so in Browser the branch always falls to the Library **Add link** dialog.
2. The selection actions registry (`src/bulkActions.ts`) is typed to Library `Link`s and its keys only run in App's Library branch (`if (view === "browser" && e.key !== "\\") return`). Browser renders a separate `BrowserSelectionBar` (`src/components/browser/BrowserSelectionBar.tsx`) with hard-coded buttons and its own `max-[700px]` layout. The Library surfaces (`BulkDock`, `BulkChip`, `BulkMobileBar`, `BulkPalette`, `BulkDrawer`) are rendered only when `view !== "browser"`.
3. The window `paste` and the root `drop` handlers call `capture()` (`POST /api/import`) regardless of view, so Browser persists pasted URLs to the Library.
4. In Library with no selection the same key means a different, unrelated command (Add link), which is the overload the owner calls confusing. The README documents that rule.

## Suggested fix

Implemented on this branch, per the authorization in FAC-184:

- One selection surface (bar, chip, palette, phone drawer and keys) shared by both views. Each view supplies its own action registry: Library links or Browser tabs.
- `⌘K` always opens the command palette. With a selection it lists the selection's actions. It always lists the view's URL-entry command: **Add links…** saves to the Library, **Open links…** opens tabs in this Chrome window, optionally into a group.
- In Browser, paste and drop open **Open links** prefilled and never save.
- `openTabs` accepts an optional group target, gated by a new `open-group` capability.

Proof: the same journeys, rerun after the change, must show the palette for every case, letter keys acting on tabs, and paste leaving the Library unchanged.

## Observability gaps

- **Client interactions are invisible.** Production has no front-end telemetry, so which command a key press ran can't be measured from Cloudflare; this triage relied on reproduction. Fix: none proposed; local reproduction is cheaper than collecting UI events.
