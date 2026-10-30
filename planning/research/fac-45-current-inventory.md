# FAC-45 current bulk-selection inventory

Read-only inventory of the Library view (not the Browser view, which has its own selection) at branch `fac-45-bulk-ui-prototype`. Paths relative to repo root.

## 1. Selection model

State is a flat `picked: string[]` of link ids in `App` (`src/App.tsx:89`). Browser view has a separate `browserPicked` (`src/App.tsx:102`) and its own bar (`src/components/browser/BrowserSelectionBar.tsx:60`); the Library `SelectionBar` is hidden in Browser view (`src/App.tsx:1120`).

| Interaction | Behavior | Cite |
|---|---|---|
| Row checkbox | `Select <title>`; hidden until row hover/focus, always visible when picked or on `hover:none` (touch) devices; click does not activate the row | `src/components/LinkRow.tsx:101-117` |
| Shift+click range | Checkbox records `shiftKey` in `onClickCapture`; LinkList selects/deselects the index range from the last clicked row (in the currently rendered, filtered order) to this row using the new checked value; anchor reset whenever the visible id list changes | `LinkRow.tsx:78,105-108`; `LinkList.tsx:44-49,98-107` |
| Cmd/Ctrl+click on a row | Not implemented. Row click only opens the Inspector (`onActivate`) | `LinkRow.tsx:97-98`; `App.tsx:1021-1024` |
| Row double click | Opens the URL in a new tab (`window.open`) | `LinkRow.tsx:99` |
| Toolbar select-all checkbox | `Select all N links` / `Deselect all`; tri-state (indeterminate when some of the visible are picked); acts on `filtered` (visible) only; shown only when count > 0 | `Toolbar.tsx:148-157`; `App.tsx:946-954` |
| Cmd/Ctrl+A | Replaces selection with all `filtered` links; ignored in inputs and while a dialog is open | `App.tsx:428-436` |
| Escape | If the Inspector is open (`activeId`) it closes it, otherwise clears the selection (so two presses when both are active); ignored while a dialog is open | `App.tsx:438-441` |
| Other shortcuts | Cmd/Ctrl+K add, `/` focus search, Cmd/Ctrl+\ sidebar, ArrowUp/Down move `activeId` only while the Inspector is open. No j/k, no keyboard range-extend, no Space-to-toggle (grep of `App.tsx` keydown handler) | `App.tsx:405-459` |
| Clear | X button in the bar (`aria-label="Clear selection"`) | `SelectionBar.tsx:206-214`; `App.tsx:1136` |
| Auto-clear on success | Auto-tag clears all picked after submit; Lens-from-bar clears all; Extract removes only the submitted ids | `App.tsx:650,1132,667` |
| Prune | Ids no longer in `library.links` are dropped on every library refresh (e.g. after delete) | `App.tsx:476-480` |
| Filter / view / search change | Selection is NOT cleared. `pickedLinks` is built from the full library, so hidden (filtered-out) links stay selected and count in the bar and in batch submits; only Cmd+A, select-all and shift-range are scoped to the visible list. No `setPicked` call in view/filter handlers (setPicked sites: 435, 440, 478, 630, 650, 667, 1132, 1136) | `App.tsx:592-598,610-624` |
| Mobile | Bar becomes a 2-column grid: count + X on row 1, 4 action buttons on row 2 (labels shrink, "Extract context" becomes "Extract"); list gets extra bottom padding (`pb-32` vs `pb-24`); checkbox always visible on touch. `mobile` = max-width 767px, `narrow` = 1099px, bar breakpoint 700px. Cmd+\ sidebar shortcut disabled on mobile | `SelectionBar.tsx:90-99`; `App.tsx:150-151,993`; `LinkRow.tsx:112` |
| Inspector with multi-select | No multi-selection view. Inspector shows only `activeLink` (single `activeId`); selection and activation are independent. `selectedCount` is passed only to `LensDialog` (`App.tsx:1152`), which offers "Run on the N selected links now" when creating a library-scope lens (`LensDialog.tsx:179,514-523`) | `App.tsx:823,1152` |

The bar renders `{links.length} selected` (`SelectionBar.tsx:94`), fixed bottom-center, `aria-label="Selected link actions"` (`:90`), CSS `.selection-bar` (`src/index.css:111`).

## 2. Actions on a multi-selection today

Bar buttons (`SelectionBar.tsx`) in order: Auto-tag, Lens, Extract context, Copy, Clear. There are no other multi-link actions anywhere (row menu, Inspector, Toolbar and tag picker are all single-link; Toolbar has only select-all, `Toolbar.tsx:148`).

| Action | Availability and disabled reason (tooltip text) | Calls | Progress and feedback | Failure handling |
|---|---|---|---|---|
| Auto-tag | Disabled if `jevReason`, no links, no tags, or `running` (`SelectionBar.tsx:57`). Reasons: Jev reason; "Create a tag first"; "Some links are still processing"; "N of M links have no content yet" (`:59-67`) | Click goes through confirm dialogs: no-content dialog ("N of M links have no content yet": Auto-tag N with content / Extract, then auto-tag, `App.tsx:1294-1316`), then replace-manual-tags dialog (`:1317-1340`; `manualTagged` `:699`). Then optional `runBatch("extract")` then `runBatch("autotag")` (`:640-655`) | `POST /api/batches {kind, ids, lensId}` in chunks of 100 (`App.tsx:380-384`; `batches.ts:5-28`; `worker/routes/activity.ts:40-47`) | See below |
| Lens | Disabled if `jevReason`, none of the picked have content/queued extraction, or `running` (`:58`). Reasons: "N of M links need context first"; "Some links are still processing"; "N of M links have no content and will be skipped" (`:68-75`) | Popover of lenses (library scope only, `App.tsx:164`) plus "New lens..." -> `LensDialog` with optional run-now (`SelectionBar.tsx:113-157`; `App.tsx:1130-1133,1172-1182`) | same batch endpoint with `kind:"lens"`, `lensId` | same |
| Extract context | Disabled only while `running` (`:164`); no tooltip/reason. Single link with no content extracts immediately; otherwise a confirm dialog (`App.tsx:669-677`) | `runBatch("extract", ids)` | same | same |
| Copy | Always enabled. Menu: Copy URLs, Copy URLs + titles (`url — title`) | `navigator.clipboard.writeText`, client only (`:76-89`) | toast `N links copied` / `Could not copy links` | toast error only |
| Clear | Always enabled | `setPicked([])` | none | none |

`running` is a single boolean set around `runBatch` submission (`App.tsx:121,377-395`), not tied to the polling state, so it only blocks double-submit while requests are in flight. Jev availability: `jevUnavailable(library.capabilities)` (`App.tsx:168`).

**Async progress (batches).**
- Server: `POST /batches` validates kind in `extract|autotag|lens` (`worker/routes/activity.ts:43`), `enqueue` returns `{id, skipped}` (`worker/jobs.ts:150-228`). `skipped` = links without content and no extraction on the way, when Jev is on (`jobs.ts:150`); if all are skipped it throws `NothingToRun` with the list (`jobs.ts:151-152`).
- Client polling every 1800 ms while any link `processing` or batch `active`, fetching `/batches/:id` jobs to build `jobsByLink` (`App.tsx:192-231`).
- Toasts for batches started this session (`sessionBatches`, `App.tsx:149,233-283`): loading toast "Auto-tagging/Extracting context for/Applying lens to N links... X of N done" with Cancel action; success toast with USD/token usage and Activity action; partial failure toast "`F failed - see Activity`" (all-failed uses `toast.error`); "Cancelled" toast.
- Cancel batch: `DELETE /batches/:id` (`App.tsx:681-696`; `activity.ts:69`); per job `DELETE /jobs/:id` (`activity.ts:59`; `ActivitySheet.tsx:111-118`).
- `ActivitySheet` (`src/components/ActivitySheet.tsx`): per-batch progress bar and `done+failed+cancelled/total` (`:378,443`), "N failed" with "Retry failed" (`:391-412`), per-job rows polled every 1600 ms (`:137`), per-job Cancel (`:219`) and Retry (`:259`). Retry only for `autotag`/`lens` (`:99`; `activity.ts:48-58`).
- Per-row status: `LinkRow` badge with spinner from `jobsByLink`: "Queued...", "Waiting for content...", "Extracting...", "Fetching preview...", "Tagging...", "Applying lens..." (`LinkRow.tsx:86-94,195-200`); "Extracting..." from `content_state === "queued"` (`:189`); red "Context failed" for `content_state==="failed"` (`:201`); "No preview" for `status==="failed"` (`:207`); attention row with message + Retry / Use preview / Dismiss when `attention_kind && !processing` (`:213-226`). Sidebar shows active batch label and progress (`App.tsx:700-715`).

**Partial failure handling.**
- Chunk-level: `submitInChunks` (`src/batches.ts`) sends 100 ids at a time; a chunk refused with `skipped` only drops those links, other chunks continue; any other error aborts; if nothing ran, the refusal is rethrown (`batches.ts:10-27`). Client toast "Skipped N links without content - Extract the content first." (`App.tsx:388-392`).
- Job-level: failures stored per job with `reason`; user text from `FAILURE_MESSAGES` (content) and `JEV_FAILURE_MESSAGES` (cost-aware: "no cost" vs "may have been billed") in `src/failures.ts:5-36`; `jobProgress` renders attempt/budget/previous-attempt note (`failures.ts:41-65`). Batch toast and Activity surface counts, not per-link reasons in the toast.
- Selection after partial failure: bar is cleared on submit success (before jobs finish), so failed links are not left selected.
- `api()` throws `Error` with `.data` set to the response body (`src/api.ts:19-22`).

## 3. Single-link actions (bulk candidates) and existing endpoints

Row hover buttons and menu (`LinkRow.tsx:265-312`): Open link (`<a target=_blank>`, `:268-280`); menu: Open in new tab, Copy URL, Edit tags (opens Inspector with tag picker focus, `App.tsx:1030-1033`), Extract / Re-extract context, Retry preview / Fetch preview (`canRetryPreview`), Use preview as content (`canUsePreview`), Dismiss from Needs attention, Delete (destructive, `:305-307`). Double-click opens URL (`:99`). Inspector adds tag editing (`TagPicker.tsx`), content edit/transcript language, related links, lens results, per-lens delete (`worker/routes/links.ts:93`) (`Inspector.tsx`, ~1035 lines).

| Operation | Client | Endpoint | Notes |
|---|---|---|---|
| Delete one link | `deleteLink` AlertDialog "Delete this link?" then `mutate("/links/:id","DELETE")`, toast "Link deleted" (`App.tsx:1197-1219`, `:1010,1041`) | `DELETE /api/links/:id` (`worker/routes/links.ts:141-158`) | Refuses if an active job (queued/running/waiting) exists: "Wait for the running job to finish." (`worker/routes/shared.ts:141-147`). Deletes row `WHERE id AND user_id`; R2 cleanup in `waitUntil` under both `contentPrefix(userId,id)` and legacy `links/<id>/`; returns whole library. No batch/bulk variant |
| Tags edit | Inspector TagPicker | `PATCH /api/links/:id` (`links.ts:133-139`, `setTags`) | no bulk endpoint |
| Extract/retry/dismiss/use-preview | row menu | `POST /links/:id/retry`, `/dismiss`, `/use-preview` (`links.ts:101-125`); batches for extract | |
| Open URL | plain anchor / `window.open` (`LinkRow.tsx:99,270-275`) | none (client only) | Library is a web page; no extension needed for a plain open |
| Open in Browser integration | `ws.browser.request("focusTab", { tab })` only focuses an existing tab (`useBrowserActions.ts:170`); `BridgeClient.request(command,args)` (`src/browser/bridge.ts:94-103`); `compatibleBrowser()` (`bridge.ts:108-112`); connection state `"connected"` in `useBrowserWorkspace.ts:138` | Command set (`packages/browser-protocol/src/browser.ts:216-303`): hello, snapshot, results, claim, accepted, release, pending, deposit, clean, capture, previews, closeTabs, moveToGroup, ungroup, updateGroup, unbindPinned, focusTab, openPermissions, forget. There is NO command that opens/creates a tab from a URL today | Relevant to FAC-47 |
| Close tabs (Browser view bulk) | `BrowserSelectionBar` Save, Group, Autogroup, Close, Copy | `closeTabs` bridge command | exists only for browser tabs, with `ItemResult[]` per-item results (a pattern for partial failures) |
| Browser selection bar (reference) | `src/components/browser/BrowserSelectionBar.tsx` (Save, move to group, Autogroup, Close, Copy URLs / URLs + titles, Clear) | | duplicates the same bar chrome as `SelectionBar` |

Other deletes: tags (`DELETE /tags/:id`, `taxonomy.ts:17`), lenses (`DELETE /lenses/:id`, `:67`), batches/jobs (`activity.ts`).

## 4. Earlier bulk-actions research

- No prior research doc on bulk actions exists. `docs/` has only `agents/`, `browser-feature-plan.md`, `browser-implementation-handoff.md`, `browser-validation*`; `planning/research/` is auth, browser RPC, needs-attention, PR previews; `planning/qa/` is FAC-48. Grep for `bulk|multi-select|selection bar|SelectionBar|FAC-4[567]` over README, docs, planning/research, planning/qa, planning/linklog-board-review.md and qa/ found only:
  - `README.md:28` ("Row checkboxes open a floating selection bar: Auto-tag, Lens, Extract context"; Copy is not listed) and `README.md:37` (Browser selection bar).
  - `docs/browser-feature-plan.md:222` (SelectionBar listed as reusable UI).
  - `planning/linklog-board-review.md:17` (FAC-45/46 revised on 27 Sep 2026).
  - `qa/video/chapters/ch4-jev-waits.ts:200` (QA asserts "4 selected" text).
  - `planning/research/auth-code-review.md:237` uses "bulk" for auth import, unrelated.
- Git history (`git log --all`): `802d50c feat: refine bulk selection bar and add copy actions` (PR #2, merge `ca5d9a4`, 23 Sep 2026; touched `App.tsx`, `SelectionBar.tsx`, `index.css`); `c5e1a20 Call the selection-bar lens action Lens in the README`; `498115c` and `e4ca235` mention bulk/selection but are about pasted imports and skipped chunks. `git log --all -S SelectionBar` finds `1219eb1` (redesign, introduces it), `b696c63` (Browser view), `9cf0efb`, `00f3b5c`.
- Verify skill feature doc `.agents/skills/verify-linklog/features/tags-autotag.md:17,30,33` documents the bar's three actions (Auto-tag, Lens, Extract context) and `Select all N links`.

### Planning board tickets (Linear, in `planning/linklog-board-*.json`)
Baseline JSONs list only titles: FAC-45 "Improve the bulk actions UI", FAC-46 "Add bulk delete for selected links", FAC-47 "Add bulk open when Browser is enabled"; all Backlog, group "Bulk actions". The details baseline adds: FAC-45 "Improve how users select items, see the selection, and invoke available bulk actions. Expose available bulk actions with understandable enabled/disabled states. Bulk delete and bulk open are tracked separately." The reviewed baseline (`planning/linklog-board-reviewed-baseline.json`) has the current text:

- **FAC-45 Redesign the existing bulk-action UI to support more actions.** Bulk actions exist but the UI does not comfortably support many options. Plan: (1) inventory current and planned actions incl. FAC-46 delete, FAC-47 open; (2) research good UI examples, present alternatives with tradeoffs; (3) owner chooses interaction before implementation; (4) implement as a reusable component and consistent UI standard. Acceptance: preserve existing actions and selection behavior; accommodate more actions without crowding or hiding essential choices; make selection/count, action availability, progress and partial failures clear; document the chosen pattern and how future bulk actions use it. "An improvement to existing functionality, not a new bulk-selection system." The review note says "Auth and bulk UI require your decision before implementation."
- **FAC-46 Bulk-delete links and clean up associated content, records, and tag associations.** Criteria: define owned records/content affected and verify no orphans; delete only selected links and their data (not other users'); remove tag associations, explicitly decide policy for unused/shared tag definitions (open decision); communicate scope and count, with confirmation or recovery; update lists/counts and report partial failures accurately; verify in-flight processing cannot recreate deleted content or records.
- **FAC-47 Add bulk open when Browser is enabled.** Open selected saved links together when the Browser integration is enabled and usable. Criteria: open via Browser integration; gate on Browser availability with an understandable unavailable state; report failed opens accurately; "Confirm exact tab/window behavior during implementation." Criteria are an organizational draft, not confirmed requirements.

## 5. Data shape and fixtures

`Link` (`src/types.ts:30-72`) fields that drive availability: `id`, `url`, `title`, `status` ("pending|ready|failed", preview), `processing` (derived: active job on the link), `previewing`, `attention_kind` ("preview|content|null"), `content_key` (string or null; presence = content exists), `content_state` ("missing|queued|ready|partial|failed"), `content_error/reason`, `tags: Tag[]` (each with `origin: "manual"|"auto"`, `types.ts:1-8`), `evaluations`, `lens_results`, `media?`. Existing availability predicates: no-content = `!content_key && content_state !== "queued"` (`App.tsx:638`; `SelectionBar.tsx:54-56`); manual-tagged = any tag with `origin==="manual"` (`App.tsx:699`). `Library = { links, tags, lenses, batches, capabilities }` (`types.ts:~176`); `Batch` has `kind`, `total/done/failed/cancelled/active/waiting` (`types.ts:~148-165`); `Job.status` queued|running|waiting|done|failed (`types.ts:~80`). `Capabilities = { markdown, jev, provider }`.

**Fixtures and verification.**
- `bun run demo` (`scripts/demo.ts:7-8`): UI 3100, API 8800, isolated state, local-only bindings (no real extraction/AI unless `demo:connected`). Seeds two accounts via `seedFixtures` -> `sampleData` (`scripts/seed-dev-users.ts:9-12,81-88`): `demo-a@linklog.test` / `linklog-demo-a-password`, `demo-b@linklog.test` / `linklog-demo-b-password`. UI gets them as `BUN_PUBLIC_LINKLOG_DEV_FIXTURES` (`demo.ts:21`).
- Preferred for proof, `verify-linklog` skill (`.agents/skills/verify-linklog/SKILL.md`): `bun install --frozen-lockfile` once; `V up` where `V = bun .agents/skills/verify-linklog/scripts/verify.ts` (default ports: first free pair from UI 3400 / API 9100, step 10; `--ui-port/--api-port`, `--fast-retries`, `--var K=V`); prints `READY http://127.0.0.1:3400`, run dir `.cache/verify-linklog/<run>`; same two accounts (A is the default signed-in page/API); `V doctor`; `V run <journey.ts> [--headed]` (reference `journeys/add-link.ts`); `V down` after every attempt. No hot reload: after editing `src/` or `worker/`, `V down` then `V up` (doctor flags stale code). Worker is `qa/video/worker-entry.ts` with fixture DNS/preview/Browser Rendering/Jev from `qa/video/fixtures.ts` (`article`, `gone` 404, `down` 503, `flaky`, `login-wall`, `pdf`, `blocked`, `nowhere`, `article-yes` which gets tags via fixture Jev); only fixture hosts (`*.qa.example`) resolve. Journey helpers: `page`, `api.library()`, `fixture(name,path)`, `check`, `shot`, `aria`. Locate by role/name: `Select <title>`, `Select all N links`, `Selected link actions`, `Clear selection`.
- Not covered by verify-linklog: the Chrome extension / Browser view (use `bun run test:browser`, ports 3010/8790), relevant to FAC-47 because bulk open depends on the extension bridge.
