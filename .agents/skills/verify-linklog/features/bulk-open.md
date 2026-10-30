# Bulk open

A user selects saved links in the library and opens them as background tabs through the Linklog Chrome extension. The action lives in the selection bar alongside Auto-tag, Lens, Extract context and Copy. It is unavailable without a connected, capable extension, and a retry after an unclear outcome reuses the same request instead of risking duplicate tabs.

## Sub-features

- `open-gated` disables the bar's `Open` button with a reason when the extension is missing, unsupported, outdated, reconnecting, or over the 50-link cap.
- `open-success` opens every selected link that is not already open in the window, as inactive background tabs, and keeps the selection.
- `open-partial` reports per-link failures in the toast, with a `Retry` action.
- `open-retry-safe` a `Retry` (or any resend of the same operation) does not duplicate a tab already opened or already open in the window.

## How to get to it (user POV)

- Select rows with their `Select <title>` checkbox, or `Select all N links`. The `Selected link actions` bar shows `Open` alongside `Auto-tag`, `Lens`, `Extract context` and `Copy`.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.
- This harness has no Linklog extension, so only `open-gated`'s missing-extension state is real. Every other case needs a scripted stand-in for the extension bridge (`page.addInitScript`, answering `postMessage` on the `linklog-bridge` channel) because Playwright's Chromium cannot load the unpacked extension. `journeys/bulk-open.ts` is the reference: read it before writing a new one here, instead of re-deriving the stand-in.
- Proof that tabs actually open in a real browser is out of this harness; `tests/browser/run.ts` and `docs/agents/browser-extension-testing.md` (Ego Lite) own that.

- **Gated.** Select links and inspect the bar's `Open` button: it is disabled, and hovering it (or its wrapping `span`) shows a `role=tooltip` with the reason. No extension gives "Install or enable the Linklog extension to open links".
- **Success and already-open.** With the fake bridge answering `hello` and `openTabs`, select links where one URL is already open in a tracked tab; click `Open`. The toast reads "Opened N links" or adds "· K already open". The selection bar still reads "N selected" afterward.
- **Partial failure.** Make the fake bridge fail one URL in `openTabs`'s response. The toast reads "Opened N of M links" with a description naming the failed link's title and its error, and a `Retry` action.
- **Ambiguous retry.** Make the fake bridge never respond (or disconnect) once, so the request rejects. The toast reads "Couldn't confirm which links opened" with `Retry`. Click `Retry` and assert, via the fake bridge's own request log, that the second `openTabs` call reused the same `operationId` as the first.
- **Proof.** Read the fake bridge's request log (store it where the journey's `page.evaluate` calls can report it) rather than trusting the toast text alone; the toast is also a legitimate `shot` target.

## Gotchas

- The connected cases are not proof that a real tab opens. Say so explicitly in any report that uses this file; don't let a passing fixture journey read as an extension proof.
- `openUnavailable` (`src/browser/openLinks.ts`) treats `connection === "connected"` with no `hello` yet as "Connecting…", and only reads `hello.capabilities.includes("open")` once `hello` exists. A fake bridge that answers `hello` immediately skips that transient state.
- The 50-link cap (`BROWSER_LIMITS.maxOpenUrls`) is a page-side reason, checked after the connection reason; it has no live-extension dependency and is cheap to add as a sub-case.
- Selecting rows depends on each link having a unique title in the seeded fixtures; reuse the `fixture(name, path)` pattern other journeys use, not literal duplicate titles.
