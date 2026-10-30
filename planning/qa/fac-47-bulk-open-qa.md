# FAC-47 bulk open: QA report

Run on 2026-10-30, following `docs/agents/browser-extension-testing.md`.

## Build under test

- Worktree: `/Users/facundopri/orca/workspaces/link-log/fac-47-bulk-open`, branch `fac-47-bulk-open`.
- HEAD at test time was `9f9e7dc`. The source tree was clean apart from this report and its screenshots.
- Build command: `bun run extension:build`, run at 2026-10-30T02:33:02Z. No `LINKLOG_ORIGINS` or `LINKLOG_UI_PORT` overrides were set. The bridge matches `http://localhost/*` and `http://127.0.0.1/*`.
- The app was a verify-linklog isolated instance at `http://127.0.0.1:3410`, with the API on `127.0.0.1:9110`. It ran the QA Worker with fixture edges. Its UI was bundled after the last source edit.
- The browser was Ego Lite, user agent `Chrome/156.0.0.0`, in TaskSpace 6 `fac47-bulk-open-qa`. The coordinator's setup space 1 was not used.
- The extension ID was `ekdpigljeknpdcoabmgdmhkodlcoging`, enabled, with no errors. It was loaded from `~/orca/workspaces/link-log/fac-47-bulk-open/apps/extension/dist`. See `fac-47/ego-01-extension-details.png`.
- The extension was reloaded at 02:36:10Z, before the run, and again at 02:37:59Z as the disconnect test.

SHA-256 of the loaded `dist`. The hashes were identical before and after the run.

```
3c9a248a42a8bd24d5476b725563d5e432c8b726e3c54dc1f2f934cd07211f13  manifest.json
f42fdbf9e31c07bd56e08b6b0120db13229add53129988e05e4363618329dfc3  background.js
f72e1f7dea322c707c542ea6b4081c25b96a794b9e1bda2ef9535b78d13dca31  bridge.js
9db8319ff4f1584738331b116b0b35c38507d9dd28d84d5c248fec55bcf054b7  connect.js
65c9df895f44eecec320c925a7944220cb51d0e2cf51816516307f5de105235b  extract.js
db8fd2f066be3edaf765ddcbe8423cd272c5eb1e7a29dcc5451c8028b5c181e2  popup.js
```

## Real extension in Ego Lite

Demo A's library held three saved links: `https://example.com/?fac47=a`, `https://example.org/?fac47=b` and `https://www.iana.org/help/example-domains?fac47=c`. They were driven through the library's selection bar.

| Case | Window tabs before | Action | Result | Window tabs after |
|---|---|---|---|---|
| Handshake | Linklog only | Open the Browser view | Connected empty state, "No other tabs in this window" (`ego-02`). Pre-opening example.org made Browser count 1 tab, so it is the same window | Linklog, example.org |
| Bulk open | Linklog, example.org | Select all three, click **Open** | Toast "Opened 2 links · 1 already open". Linklog stays the active tab. The selection stays at "3 selected" (`ego-04`) | + iana.org, + example.com, both inactive |
| Repeat | 4 tabs | Click **Open** again | Toast "3 links already open" (`ego-05`) | 4 tabs, no duplicates |
| Extension disconnected | 4 tabs | Reload the extension under the open page | Open disabled. Browser view shows "Reconnecting to the extension…" (`ego-07`) | unchanged |
| Reconnect | example.com tab closed by hand | Reload the page, select all three, click **Open** | Toast "Opened 1 link · 2 already open" (`ego-08`) | example.com reopened once |

In Ego the disabled Open button's tooltip would not open under the agent's synthetic pointer. The tooltip text is proven in the fixture journey below.

## Fixture and harness proof

- verify-linklog journey `.agents/skills/verify-linklog/journeys/bulk-open.ts` passed 25/25. Its evidence is in `.cache/verify-linklog/20261030-023208-3410/evidence/bulk-open-20261030-023223/`.
  - The "no extension" state is real: Playwright's Chromium has no extension. The tooltip says "Install or enable the Linklog extension to open links". Auto-tag, Lens, Extract context, Copy and Clear selection are unchanged (`fixture-01`).
  - The remaining cases use a **scripted stand-in for the bridge**, not the extension:
    - an extension without the `open` capability shows "Update the Linklog extension to open links" (`fixture-02`);
    - a partial failure shows "Opened 1 of 2 links", with the failed link's title and reason and a Retry action, and the selection is kept (`fixture-03`). Retry resends the same operationId and URLs;
    - a disconnect mid-request shows "Couldn't confirm which links opened". Retry reuses the operationId and reports both links opened.
- `bun run test:browser` ran on ports 3610/9610/3699/3698 with Chrome for Testing 1243 and a real unpacked extension. It passed 43/46. The new check, "Open creates background tabs once per operation, even when the request is repeated", passed: two background tabs opened in the page's window, and repeating the operation opened none. The three failures are listed below.
  - "navigation invalidates; hash change doesn't; SPA pushState does"
  - "editing a lens: threshold reuses answers…"
  - "group filters: … ungrouped"

  The implementing agent reported that these three also fail when the new check is removed. I did not rerun that baseline.
- `bun run typecheck` passed. `bun test` passed 469 tests with 0 failures.

## Not exercised

- A partial failure from real Chrome. Every saved link is http(s), so no organic URL makes `chrome.tabs.create` fail. The per-URL failure path is covered by extension unit tests and the fixture journey.
- An ambiguous timeout against the real extension. The ledger replay is covered by unit tests and the real-Chromium harness check. The page's retry path is covered by the fixture journey.
- More than 50 selected links. The page gate and protocol validator are covered by unit tests only.
