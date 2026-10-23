# Tags and auto-tag

A user creates tags with a description for the AI and a confidence threshold, adds or removes tags by hand, and runs Auto-tag on selected links. Auto-tag scores each tag per link and replaces the link's tags with those above the threshold. A lens asks a question about selected links without changing tags. In this harness the fixture Jev provider answers. Content markers decide its answers, so runs are free and deterministic.

## Sub-features

- `tag-create` creates a tag from the sidebar `New tag` button.
- `tag-edit` edits a tag's name, description and threshold, or deletes it, from `Tag options for <name>`.
- `tag-manual` adds or removes a tag on a link from the inspector, the row's `Link actions` → `Edit tags`, or a chip's `Remove <name>`.
- `autotag-run` scores selected links from the selection bar's `Auto-tag`, and skips links without content.
- `autotag-scores` shows each tag's confidence in the inspector and the percentage on hover over a chip.
- `lens-run` creates a lens with `New lens` and runs it on a selection with the selection bar's `Lens`.

## How to get to it (user POV)

- The sidebar `TAGS` section: `New tag`, or `Create one` when there are no tags yet. Each tag has a `Tag options for <name>` menu.
- Select rows with their `Select <title>` checkbox, or with `Select all N links`. The `Selected link actions` bar then shows `Auto-tag`, `Lens` and `Extract context`.
- The inspector's `Add tag` button, and a row's `Link actions` → `Edit tags`.
- The sidebar `LENSES` section: `New lens`, and `Lens options for <name>`.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.
- Seed `fixture("article-yes", "one")`, whose content carries `jev:yes`, and `fixture("article", "two")`, with no marker. Wait until both have `content_state === "ready"`.

- **Create tag.** Click `New tag`. In the dialog named `New tag`, fill `Name` (`#tag-name`) with `qa-topic` and `Description` with a sentence, then click `Create tag`. The sidebar lists `qa-topic`, and `api.library().tags` contains it with `threshold` 0.8.
- **Manual tag.** Open the `two` link's inspector, click `Add tag`, and choose `qa-topic`. The chip appears, and `api.link(url2).tags` contains it.
- **Auto-tag.** Check `Select all N links` (or each `Select <title>`), then click the bar's `Auto-tag`. If a confirmation offers `Auto-tag N with content`, choose it. Wait until no link is processing. The `article-yes` link carries `qa-topic` with an evaluation above the threshold, and `api.link(url).evaluations` is not empty.
- **Scores.** Open the evaluated link's inspector, then the `Analysis` tab. Each tag's confidence is listed. Hovering an auto-tagged chip shows the percentage.
- **Edit threshold.** Use `Tag options for qa-topic`, then edit `Confidence threshold` and click `Save changes`. Existing scores stay. Only a new Auto-tag run uses the new threshold, and the dialog says so.
- **Lens.** Click `New lens` and create a yes/no question. Select links and click the bar's `Lens`, then pick the lens from `Pick a lens…`. Per-link verdicts appear, and the tags are unchanged.
- **Proof.** Save a `shot` of the inspector's Analysis tab and a `note` of `api.link(url)` with `tags` and `evaluations`.

## Gotchas

- A complete Auto-tag result replaces all of a link's tags, including manual ones. Don't assert that a manual tag survives an Auto-tag run.
- Links without content are skipped, and the result says `Skipped N link(s) without content`. `Extract, then auto-tag` is a separate, explicit choice.
- Fixture Jev markers live in the content: `jev:yes`, `jev:fail` and `jev:slow=<ms>` (`worker/ai/fixture.ts`). Pick an `*-yes` fixture to get a positive score.
- An Auto-tag requested while the link is still extracting waits (`waiting` job) and starts after extraction. Wait for `!processing` before asserting tags.
