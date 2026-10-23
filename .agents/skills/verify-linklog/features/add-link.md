# Add links

A user saves one URL or a pasted list. The link appears in the list at once, its preview (title, description, favicon) and content (Markdown) are extracted in the background, and the inspector shows the result. Saving a URL that is already in the library returns the existing link and merges its tags.

## Sub-features

- `add-dialog` saves one URL from the Add link dialog, with optional tags.
- `add-shortcut` opens the same dialog with ⌘K or Ctrl+K.
- `add-paste` saves a URL pasted outside any field, without a dialog.
- `add-import` saves several URLs pasted into the dialog or onto the page as one batch, without tags.
- `add-drop` saves a link dragged onto the page.
- `add-dedupe` returns the existing link for an already-saved URL and merges tags.
- `add-extract` shows the preview in the row and the Markdown under the inspector's Content tab.

## How to get to it (user POV)

- The toolbar `Add link` button. It shows as a `+` icon when the inspector is open, and keeps the same accessible name.
- The `Add link` button in the empty state of an empty library.
- ⌘K on macOS, or Ctrl+K elsewhere, from anywhere on the page.
- Paste one URL or a list while focus is outside a text field.
- Drag a link from another tab onto the page.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.
- `const url = fixture("article", "one")`, which has an immediate preview and Markdown.

- **Open dialog.** Run `page.getByRole("button", { name: "Add link" }).first().click()` or `page.keyboard.press("ControlOrMeta+K")`. A dialog named `Add link` appears, with focus in its textbox.
- **Save.** Run `dialog.getByRole("textbox").fill(url)` and then `dialog.getByRole("button", { name: /^Save/ }).click()`, where `dialog = page.getByRole("dialog", { name: "Add link" })`. The dialog closes, a `Link saved` toast appears, and the row shows while processing.
- **Tags at save.** Before saving, click `Add tag` in the dialog, type a new name in the picker, and choose it. After the save, `(await api.link(url)).tags` contains it.
- **Extraction settles.** Run `check` until `api.link(url)` has `!processing`, `status === "ready"`, `content_state === "ready"` and `attention_kind === null`. Allow a 60 s timeout. The row shows `QA article <path>` and `A normal page.`.
- **Inspector content.** Click the row title, then `page.getByRole("tab", { name: "Content" })`. The `Close inspector` button is visible, and the text `deterministic QA article` appears under the `Preview`/`Markdown` toggle.
- **Paste outside a field.** Click a neutral area, then dispatch a paste. Run `page.evaluate((u) => { const d = new DataTransfer(); d.setData("text/plain", u); document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true })); }, url2)`. The link saves without a dialog.
- **Import a list.** Fill the dialog with two fixture URLs on separate lines and press `ControlOrMeta+Enter`. The note `2 URLs detected — they'll be imported without tags.` shows before the save. After it, both links exist and `api.library().batches` contains an `extract` batch.
- **Duplicate.** Save `url` again with a different tag. `api.library()` still has one link for `url`, and it carries both tags.
- **Proof.** Reload and confirm the row, then read `api.get(\`/links/${id}/content\`).markdown`. Save `shot` and `aria` of the list. `journeys/add-link.ts` does this for `add-dialog` and `add-extract`.

## Gotchas

- An empty library has two `Add link` buttons: the toolbar's and the empty state's. `getByRole` in strict mode fails. Use `.first()` for the toolbar's.
- Only fixture hosts resolve. Saving `https://example.com/...` produces a link whose preview fails as unreachable. That is correct for this harness, not a product bug.
- The fixture's `{path}` appears in the title (`QA article add-link-032946/one`). Read the title back from `api.link(url)` instead of hard-coding it.
- Tags in the dialog apply only to a single URL. A multi-URL save drops them, and the dialog says so.
- Page paste is ignored when the target is a field, or while a dialog or the Activity sheet is open. Close those and make sure focus is on the page body first.
- The UI polls the library, so a row can appear a second or two after the API has the link.
