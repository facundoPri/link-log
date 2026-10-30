# FAC-45 bulk actions: primary-source research

Access date for every URL: 2026-10-29. "Documented" means taken from prose or source on the page. "Observed" means I loaded the live demo in a separate ego-browser task space and watched it behave. Quotes marked (WebFetch) came through a summarising fetch tool and are quoted as it returned them. Pages I could not read are listed at the end.

Linklog today: a floating bottom-centre pill, `N selected | Auto-tag | Lens | Extract context | Copy | x` (`src/components/SelectionBar.tsx`). Planned additions: bulk delete (FAC-46), bulk open in tabs (FAC-47), probably tag/untag, archive, move.

## 1. Per-source findings

### 1.1 Adobe React Spectrum ActionBar (v3 docs and S2 docs)
URLs: https://react-spectrum.adobe.com/react-spectrum/ActionBar.html (v3), https://react-spectrum.adobe.com/ActionBar.html (S2, live demo).

Documented:
- Anatomy is an action group, a clear button and a selected-item count. "It consists of an ActionGroup, a clear button, and a count of selected items." (v3)
- `selectedItemCount` accepts `number | 'all'`, and "If 0, the ActionBar is hidden." Visibility is derived from selection, there is no separate open state. (v3, S2)
- Overflow is label collapse first, then menu. `buttonLabelBehavior` defaults to `'collapse'`: "the text is visible if space is available, and hidden when space is limited. The text is always visible when the item is collapsed into a menu." Items that no longer fit go into a menu, where labels return. (v3)
- Per-action availability is `disabledKeys`, which disables individual actions while the bar stays visible. (v3)
- `isEmphasized` is for a bar "floating in a TableView"; omit it when the bar should blend in. (v3)
- The component announces a localized count and a clear-button `aria-label` automatically. (v3)
- The bar is a companion to the collection, not a modal. `onClearSelection` and `onAction(key)` are the only events, so the bar has no concept of progress or results. Those live in the app. (v3)

Observed (S2 demo, desktop viewport):
- The bar renders as `toolbar "Actions"` with icon-only buttons named by `aria-label` (Edit, Copy, Delete), then a "Clear selection" button, then the text "1 selected".
- Clicking another row replaced the selection (count stayed "1 selected"), and pressing Escape with a row focused cleared the selection and removed the whole bar from the accessibility tree.
- I did not observe the menu overflow at narrow widths. That part is documented only.

### 1.2 Shopify Polaris (bulk actions, as migrated to web components)
URLs: https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/unstable-bulk-actions, https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/select-all-actions, https://shopify.dev/docs/apps/build/app-home/migrate-from-polaris-react/index-table.
The classic `polaris-react.shopify.com/components/tables/index-table` page would not load (socket closed), so legacy `promotedBulkActions` behaviour is known only through these migration guides. All of this is documented, none observed.

- Structure is "a visible selection count, a promoted action, and a menu of secondary actions. The toolbar replaces the table filters only while resources are selected." (unstable-bulk-actions)
- "Render the highest-value bulk action as a visible `s-button`. Put additional actions in `s-menu`." (unstable-bulk-actions)
- Polaris deliberately dropped auto-overflow: "Map `promotedActions` to visible buttons, but don't reproduce the old measurement logic that moved them into overflow. Choose a small, stable promoted set." (unstable-bulk-actions) Stable positions beat adaptive layouts.
- Pending state: "Set the initiating button to pending and prevent repeat submissions. On success, clear selection, refresh results, and show confirmation. On failure, preserve selection and show retryable feedback." (select-all-actions) The migration also says to keep `loading` on the action whose mutation is pending.
- Destructive: "For destructive actions, confirm the operation before sending selected IDs. Keep selection if the mutation fails so the merchant can retry; clear it only after success or an explicit cancel." (unstable-bulk-actions)
- Scope in the label: "Show the total scope in destructive confirmations and action results. **Delete 2,430 products** is safer than **Delete selected products**." (unstable-bulk-actions)
- Eligibility: `disabled` resources are excluded from select-all and from counts ("Verify disabled resources aren't selected or included in counts."). (select-all-actions)
- The app owns the selection model: "Don't read selected IDs from checkbox elements when an action runs. The app-owned selection model must be the source for the count, control state, backend payload, and cleanup." (select-all-actions)
- The example feedback is a toast with a count on success (`3 products archived`) and an error toast on failure. There is no per-item failure UI. (select-all-actions)

### 1.3 IBM Carbon DataTable batch actions
URLs: https://carbondesignsystem.com/components/data-table/usage/ (WebFetch), https://raw.githubusercontent.com/carbon-design-system/carbon/main/packages/react/src/components/DataTable/TableBatchActions.tsx (source).

Documented:
- A batch action bar replaces the table toolbar once a row is selected: "Once an item from the table is selected, the batch action bar appears at the top of the table." Height matches the row height. (usage)
- Exit by the cancel button at the far right or by deselecting everything. (usage)
- While batch mode is active, "single action icons and overflow menus on the row should be disabled." Row-level and bulk actions do not compete. (usage)
- Usage doc defines no count text, destructive handling or batch overflow. The default toolbar rule is "up to five actions" with overflow, which the page ties to the toolbar rather than the batch bar. (usage, WebFetch)
- Source: count string is `"{n} item selected"` / `"{n} items selected"`, with a `Select all ({totalCount})` button and a `Cancel` button. When hidden, the bar uses `aria-hidden` and `tabIndex=-1` on its buttons, so hidden actions are not tabbable. (TableBatchActions.tsx)
- The component takes `totalSelected` and `totalCount`, which makes the "N of M" scope part of the API.

### 1.4 GitHub Primer ActionBar and GitHub's issue list
URLs: https://primer.style/components/action-bar (docs), https://primer.style/product/components/action-bar/guidelines/ (WebFetch), https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users.

Documented:
- Primer ActionBar is for toolbars, not selection: "When there is not enough space, buttons that don't fit will be added to an overflow menu. Dividers from the ActionBar are preserved in the overflow menu." The page has a "Demo of overflow behavior". (docs)
- `disabled` keeps the button focusable with `aria-disabled`, so keyboard users can still land on an unavailable action. (docs)
- Rules (WebFetch): all buttons use the same content type (icon, text, or text with icon); the `primary` variant is not used; `danger` is allowed for destructive actions; "Don't add a selected state or any other information like a notification dot or a counter."
- GitHub's issue list bulk flow is checkboxes then an action in the header: "Select the items you want to assign to someone. ... In the upper-right corner, click **Assign**." Bulk actions replace the list header; each opens a picker. (GitHub docs, assign page)
- I found no GitHub docs page describing bulk-failure reporting for the web list, so I make no claim about it.

### 1.5 Linear: multi-select and the command menu
URL: https://linear.app/docs/select-issues. All documented.
- Selection is keyboard-first: `X` toggles, Shift+arrows extends, `Cmd/Ctrl+A` selects all of the filtered list, `Esc` clears.
- "Once an issue or set of issues are selected, use Cmd/Ctrl K to open the command bar and select the preferred action or right-click anywhere on the selected issue(s) to open the contextual menu for a list of available actions."
- "Common bulk actions will show up at the bottom," so a small bar exists, but the command menu and context menu carry the long tail.
- Filtering first then Select All is the documented way to build an eligible set (example: filter to no-priority issues, `Cmd+A`, then `P`).

### 1.6 Apple HIG: alerts and undo
URLs: https://developer.apple.com/design/human-interface-guidelines/alerts and .../undo-and-redo. The pages render client-side, so I read the same text from Apple's DocC feed (`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/alerts.json` and `undo-and-redo.json`). Documented.
- "Avoid displaying alerts for common, undoable actions, even when they're destructive. ... they can undo the action. In comparison, when people take an uncommon destructive action that they can't undo, it's important to display an alert in case they initiated the action accidentally."
- Buttons use specific verbs: "A specific button title like 'Erase,' 'Convert,' 'Clear,' or 'Delete' helps people understand the action." The destructive style marks a button for an action people "didn't deliberately choose"; for a deliberate action (Empty Trash) it is not applied.
- Undo: "Consider giving people the option to revert multiple changes at once," and name the operation precisely ("Undo Name"). Show the result of an undo when it is off-screen.

### 1.7 Carbon notification pattern (batch result reporting)
URL: https://carbondesignsystem.com/patterns/notification-pattern/. Documented.
- Inline notifications "persist until the message is resolved or dismissed" and sit near their related items; toasts are for system-generated messages and "should not exceed three lines".
- "Toast notifications with actions persist until dismissed by user." An Undo or Retry action therefore makes a toast sticky, which matters for failure reporting.
- Statuses are informational, success, warning, error. Warning means "might have unexpected results", a natural fit for partial success.

### 1.8 MDN: opening many tabs
URLs: https://developer.mozilla.org/en-US/docs/Web/API/Window/open, https://developer.mozilla.org/en-US/docs/Web/Security/User_activation. Documented.
- "Modern browsers have strict popup blocker policies. Popup windows must be opened in direct response to user input, and a separate user gesture event is required for each `Window.open()` call." MDN's workarounds: "Open no more than one new window at once", reuse windows, or "Advise users on how to update their browser settings to allow multiple windows."
- `window.open` returns `null` "if the browser fails to open the new browsing context, for example because it was blocked by a browser popup blocker." That null is the only blocked-signal, so open N links can be counted as opened vs blocked.
- Transient activation "expires after a timeout" and "may also be consumed by some APIs (like `Window.open()`)". Do the opens synchronously in the click handler, never after an await. The page lists `Window.open()` among APIs requiring transient activation. (User_activation)
- MDN does not state a numeric tab limit. Any "open at most N" cap is a product decision, not a spec rule.

## 2. Synthesis for Linklog

1. **Promoted plus overflow.** Spectrum (documented) collapses labels, then moves items into a menu. Polaris (documented) rejects automatic overflow in favour of a "small, stable promoted set" plus one menu. Primer and Carbon overflow automatically. For Linklog the stable form is better: promote Auto-tag and Extract context (the AI actions the app is built around), keep everything else in a "More" menu, and keep Delete in the same menu or as a separated `danger` button. The current pill already has five controls, so each addition crowds it further.
2. **Command palette on selection.** Linear (documented) uses `Cmd+K`, right-click and `X`/`Shift`/`Cmd+A`/`Esc` as the primary surface and keeps the visual bar minimal. A palette scales to tag/untag/archive/move without any bar change. It needs a visible "N selected" anchor and a discoverable shortcut hint, or it hides the feature.
3. **Eligible vs ineligible counts inline.** Polaris excludes disabled resources from counts. Spectrum disables an action key. Primer keeps disabled buttons focusable. Combining them: the action stays enabled when any selected link is eligible, and its label or tooltip carries the scope, e.g. "Extract context (3 of 5)", following Polaris "Delete 2,430 products" over "Delete selected". Disable the action only when 0 are eligible.
4. **Progress and partial failure.** Documented guidance only covers whole-action pending and error: Polaris sets the pending button to loading and blocks repeats, clears selection on success, and keeps it on failure for retry. None of Polaris, Spectrum, Carbon or Primer documents per-item failures. This is a gap, so Linklog has to design it. Compatible with the sources: an inline persistent status near the bar (Carbon: inline "persist until resolved") reading "Extracted 7 of 9, 2 failed" with a Retry action, and failed items remaining selected (the Polaris "keep selection on failure" rule applied per item). Warning status fits partial success (Carbon).
5. **Destructive: confirm vs undo.** Apple (documented): undo for common reversible actions, confirmation for uncommon irreversible ones. Polaris (documented): confirm destructive bulk actions, show total scope, keep selection on failure. For a link library, delete is reversible only if the backend soft-deletes. If it does, undo toast ("12 links deleted. Undo", persisting while the action is available, Carbon) is the lower-friction choice. If it hard-deletes, use a confirmation with the count and a specific verb ("Delete 12 links").
6. **Bulk open in tabs.** MDN (documented): one user gesture per `window.open`, and a blocked call returns `null`. Opening N tabs in one click may be partially blocked, and the result is not the same on every browser. Therefore FAC-47 should cap N, open synchronously in the handler, count `null` returns and report "Opened 8 of 12, 4 blocked" with the blocked links offered as a list to open manually or via a single "open all" retry. This is the same partial-failure surface as item 4 and should share it.
7. **Scope and persistence.** Spectrum and Linear both treat clear as first-class (X button, `Esc`). Carbon pairs it with Select all (N). Polaris warns to clear query-wide selection when filters change. Linklog's filter/search changes should do the same.

## 3. Three structurally different directions

### A. Slim bar: promoted primaries plus one More menu (Polaris/Spectrum shape)
`[x] 5 selected | Auto-tag | Extract context | More v` with Copy, Lens, Open, Archive, Delete (danger, separated) in the menu. Status line replaces the count while a job runs.
- Pros: closest to today's code; stable positions; works on touch; the user sees the bar and the count together.
- Cons: every new action lands in a menu, so discoverability of Open/Delete is lower; the promoted pair is a product bet; two clicks for most actions.
- Fits: eligibility via a tooltip or menu item suffix; progress and failure need a new inline region on the bar.

### B. Selection sets the context, command palette does the work (Linear shape)
A minimal pill with only `[x] 5 selected | Actions ⌘K`. Everything, including tag/untag/archive/move, is a palette entry scoped to the selection, plus right-click and the keyboard shortcuts (`Esc` to clear).
- Pros: unbounded action growth without layout change; the palette can show "Extract context (3 of 5 eligible)" and disable with a reason inline; one place to render results.
- Cons: weak on touch and for new users; needs a palette that does not exist yet (cost); hides the AI actions that are the core pitch; palette sub-pickers (Lens, tags) need design.
- Fits: eligibility best of the three; progress and failure live in a persistent status toast or the pill.

### C. Two-zone contextual bar with a results tray (Carbon batch bar plus Carbon inline notification)
A header-replacing batch bar that swaps with the filter/search bar (Carbon, Polaris "toolbar replaces filters"), with labelled primaries on the left and a danger zone on the right. Running jobs and failures appear in a tray beneath the bar that lists per-item outcomes, with Retry failed and Dismiss.
- Pros: the only direction that gives partial failures and the FAC-47 blocked tabs a real home; no floating overlay on page content; row actions disabled during batch mode (Carbon) avoids conflicts.
- Cons: biggest build; takes over the header so filters are hidden while selecting; a sticky tray can feel heavy for a 3-item job; needs an item-level job-status model in the data layer.
- Fits: eligibility via counts in labels; destructive actions get an undo or confirm inside the bar.

Tradeoff summary: A is cheapest and keeps today's mental model; B scales best for the roadmap but costs a palette and discoverability work; C is the only one that treats partial failure as a first-class state. A good sequence is A now, with the status region designed so it can grow into C's tray, and B added as the power-user layer later (Linear shows these coexist).

## 4. Not read or gaps

- Polaris React classic IndexTable page (polaris-react.shopify.com): socket closed twice. Legacy `promotedBulkActions` overflow rules are therefore not first-hand.
- Material 3 selection and snackbar guidance, Material 2 app bars, and Adobe's Spectrum design page (`spectrum.adobe.com/page/action-bar/` returned 404): pages render client-side or are missing. A search tool summary mentioned the Material contextual action bar, but I did not read the page, so I make no Material claims.
- Gmail help (https://support.google.com/mail/answer/6576) was read but only covers check-box then Archive, with nothing on bulk failure or undo, so I do not rely on it.
- No NN/g material used. No primary guidance found for per-item partial failure in any of the design systems above.
- The Spectrum demo observation was one session at one viewport.
