# Add links

A user saves one URL or a pasted list. The link appears in the list at once, its preview (title, description, favicon) and content (Markdown) are extracted in the background, and the inspector shows the result. Saving a URL that is already in the library returns the existing link and merges its tags.

## Sub-features

- `add-links-page` saves URLs from the ⌘K palette's links page, with optional tags (FAC-184). There is no Add link dialog.
- `add-shortcut` opens the links page from the ⌘K (Ctrl+K) `Commands` palette: its `Add links…` command, or a paste into its input.
- `add-paste` opens the links page with the URLs pasted outside any field; Enter saves them.
- `add-import` saves several URLs as one batch; tags picked on the links page apply to all of them.
- `add-drop` opens the links page with a link dragged onto the page.
- `add-dedupe` returns the existing link for an already-saved URL and merges tags.
- `add-extract` shows the preview in the row and the Markdown under the inspector's Content tab.

## How to get to it (user POV)

- The toolbar `Add link` button. It shows as a `+` icon when the inspector is open, and keeps the same accessible name.
- The `Add link` button in the empty state of an empty library.
- ⌘K on macOS, or Ctrl+K elsewhere, opens the `Commands` palette from anywhere on the page; its `Add links…` row (Enter) opens the links page, and a paste into its input does too.
- Paste one URL or a list while focus is outside a text field: the palette opens on the links page with them.
- Drag a link from another tab onto the page.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.
- `const url = fixture("article", "one")`, which has an immediate preview and Markdown.

- **Open the links page.** Run `page.getByRole("button", { name: "Add link" }).first().click()`, or `page.keyboard.press("ControlOrMeta+K")` then `Enter` on `Add links…`. The dialog named `Commands` shows the input with the placeholder `Paste or type links…`, focused.
- **Save.** With `palette = page.getByRole("dialog", { name: "Commands" })`, run `palette.getByRole("combobox").fill(url)` and press `Enter`: the URL is listed and the `Save 1 link to Library` option is highlighted. Press `Enter` again. The palette closes, a `1 link saved` toast appears, and the row shows while processing.
- **Tags at save.** On the links page, type a tag name: existing tags filter, and a new name offers `Create tag “<name>”`. `Enter` picks it (the Save row then names it), and `Enter` on the Save row, or `ControlOrMeta+Enter` while typing, saves. After the save, every link's `tags` contains it.
- **Extraction settles.** Run `check` until `api.link(url)` has `!processing`, `status === "ready"`, `content_state === "ready"` and `attention_kind === null`. Allow a 60 s timeout. The row shows `QA article <path>` and `A normal page.`.
- **Inspector content.** Click the row title, then `page.getByRole("tab", { name: "Content" })`. The `Close inspector` button is visible, and the text `deterministic QA article` appears under the `Preview`/`Markdown` toggle.
- **Paste outside a field.** Click a neutral area, then dispatch a paste. Run `page.evaluate((u) => { const d = new DataTransfer(); d.setData("text/plain", u); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true })); }, url2)`. The palette opens on the links page with the URL; `Enter` saves it.
- **Import a list.** Paste two fixture URLs on separate lines, into the palette's input (dispatch the paste on `palette.getByRole("combobox")`) or outside a field. The Save row says `Save 2 links to Library`. After `Enter`, both links exist, carry any picked tags, and `api.library().batches` contains an `extract` batch.
- **Duplicate.** Save `url` again with a different tag. `api.library()` still has one link for `url`, and it carries both tags.
- **Proof.** Reload and confirm the row, then read `api.get(\`/links/${id}/content\`).markdown`. Save `shot` and `aria` of the list. `journeys/add-link.ts` does this for `add-links-page` and `add-extract`; `journeys/command-palette.ts` covers the paste into the palette with a new tag on two links.

## Gotchas

- An empty library has two `Add link` buttons: the toolbar's and the empty state's. `getByRole` in strict mode fails. Use `.first()` for the toolbar's.
- Only fixture hosts resolve. Saving `https://example.com/...` produces a link whose preview fails as unreachable. That is correct for this harness, not a product bug.
- The fixture's `{path}` appears in the title (`QA article add-link-032946/one`). Read the title back from `api.link(url)` instead of hard-coding it.
- Page paste is ignored when the target is a field, or while a dialog (the palette included) or the Activity sheet is open. A paste into the palette's own input adds to its links.
- `journeys/rapid-paste.ts` pastes four lists with `Enter` after each without waiting for the saves.
- The UI polls the library, so a row can appear a second or two after the API has the link.
