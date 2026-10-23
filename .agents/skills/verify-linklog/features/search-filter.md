# Search and filter

A user narrows the library by typing a query, which matches title, description, URL, domain and tags. They can also filter by context (with or without extracted content), by tags (AND semantics) and by domain, or switch to the Untagged view. Filters show as removable chips, and clearing them restores the full list.

## Sub-features

- `search-query` filters rows by title, description, URL, domain or tag text.
- `search-shortcut` focuses search with `/`.
- `search-clear` empties the query from the `Clear search` button.
- `filter-context` keeps links with context (`With context`) or without it (`Without context`).
- `filter-tags` keeps links carrying every selected tag.
- `filter-domain` keeps links from the chosen domains, also reachable by clicking a row's domain.
- `view-untagged` lists only links without tags.

## How to get to it (user POV)

- The toolbar textbox `Search links` (placeholder `Search`), or press `/` outside a field.
- The toolbar `Filter` button, which opens a menu with the groups `Context`, `Tags` and `Domains`.
- The domain button on a row, such as `article.qa.example`, which applies that domain filter.
- The sidebar `Untagged` button inside the `Library` navigation.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.
- Seed three links with `api.send("POST", "/links", { url, tags })`: `fixture("article", "alpha")` with tag `alpha-topic`, `fixture("article", "beta")` with no tags, and `fixture("pdf", "gamma")`, whose content fails. Wait until all three have `!processing`.

- **Search.** Run `page.keyboard.press("/")`, then type `alpha`. The `Search links` textbox has focus, and only the `QA article …/alpha` row stays visible.
- **Clear.** Click `page.getByRole("button", { name: "Clear search" })`. The textbox is empty and all seeded rows are back.
- **Context filter.** Click `Filter`, then `page.getByRole("option", { name: "With context" })`. The rows without content (the `pdf` one) disappear, and a `With context` chip with `Remove context filter` appears.
- **Tag filter.** Open `Filter` and choose the option `alpha-topic` under `Tags`. Only rows tagged `alpha-topic` remain.
- **Domain filter.** Click the row's `article.qa.example` button, or choose it under `Domains`. A chip with `Remove domain filter article.qa.example` appears, and the `pdf.qa.example` rows disappear.
- **Untagged.** Click `page.getByRole("navigation", { name: "Library" }).getByRole("button", { name: /^Untagged/ })`. The heading reads `Untagged · N`, and only links without tags are listed.
- **Proof.** For each state, save an `aria` snapshot, which lists the row titles, and a `shot` with the chips visible. Compare against `api.library()` filtered the same way.

## Gotchas

- `/` types a slash when focus is already in a field. Press `Escape` or click the page first.
- The tag filter uses AND. Two selected tags only show links that carry both.
- Search matches the domain and URL too. A query like `qa` matches every fixture link.
- Filters persist until removed. Clear chips between steps, or reload.
- The `Filter` menu is a command list. Its items have role `option`, not `menuitem`.
