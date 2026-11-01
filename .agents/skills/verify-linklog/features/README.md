# Linklog verification map

This directory is the maintained source for verifying Linklog's user-facing web behavior. Read this index before driving the app, then use the matching feature file as the recipe for a journey.

## Baseline preconditions

- `V up` started the instance, and `V doctor` passes all six lines. `V` is `bun .agents/skills/verify-linklog/scripts/verify.ts`, run from the repo root.
- The instance was launched after your last code edit. `doctor` checks this.
- Demo A (`demo-a@linklog.test`) and Demo B (`demo-b@linklog.test`) exist and are verified. Both libraries start empty, with no tags or lenses.
- External services are fixtures. Save only `fixture(name, path)` URLs. Any other host reads as unreachable.

## Driving conventions

- One journey file per proof, run with `V run <file>`. Start from `journeys/add-link.ts`.
- Use roles and accessible names. The handles quoted in each feature file come from `src/components/`.
- Libraries persist across journeys on one instance. Build URLs with `fixture()`, and assert on your own links, not on counts, unless you need an empty library. In that case, `down` and `up` first.
- Wait on state with `check`, never with a fixed sleep.
- Shortcuts use `ControlOrMeta`, as in `page.keyboard.press("ControlOrMeta+K")`. The app accepts either modifier.

## Proof and skip reporting

- Capture the user action and the resulting state. `video.webm` covers the action. Add a `shot` or `aria` of the end state, and read the stored value back through `api`.
- Prove a mutation from a second view, either a reload or the API.
- Record which entry point each journey used. Don't report an entry point as verified when you exercised the feature through a different one.
- Report an unreachable path with the attempted step, the failing check from `report.json`, and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs, one line per behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify.ts` starts with `Preconditions:`, then pairs each user action with the Playwright call and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

## Features

- [Add links](./add-link.md) covers the Add link dialog, ⌘K, paste and drop, multi-URL import, tags at save, and duplicates. Proven by `journeys/add-link.ts`.
- [Search and filter](./search-filter.md) covers search, the Filter menu (context, tags, domains), Untagged, and clearing.
- [Tags and auto-tag](./tags-autotag.md) covers creating and editing tags, manual tags, selection-bar Auto-tag with fixture Jev, and lenses.
- [Needs attention and Activity](./needs-attention.md) covers failed previews and content, Retry, Use preview, Dismiss, the Activity sheet and cancelling.
- [Accounts and privacy](./accounts.md) covers sign-in, sign-out, sign-up with emailed verification, magic link, password reset, and library isolation between accounts.
- [Bulk open](./bulk-open.md) covers the bulk `Open` action (toolbar, palette, drawer and `O` key): gating on the extension's connection and capability, opening background tabs, partial failure, and retry safety. Only its missing-extension state is proven live here; the rest uses a scripted stand-in for the extension bridge (see the file's own caveats).
- [Settings and API keys](./settings-api-keys.md) covers opening Settings from the user menu, the Account section, and creating, listing, revoking, enabling and deleting API keys. Proven by `journeys/api-keys-settings.ts` and `journeys/api-keys-revoked-section.ts`.
- Public API submit (`POST /api/v1/links` with a Bearer API key): 202 results, Duplicates, 401s, a key refused on private routes, the Activity label `Extract context · API · <key name>` and cancelling the batch. Proven by `journeys/api-submit-activity.ts` (launch with `--var BROWSER_CONCURRENCY=1`).

Not mapped here: the Browser view and the rest of the Chrome extension (`bun run test:browser`), Usage, the inspector's Links and Analysis tabs, transcript upload, and YouTube and social adapters, which have no fixtures.
