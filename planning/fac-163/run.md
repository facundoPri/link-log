# FAC-163 implementation run

## Workflow

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Definition of done

One integrated Browser delivery meets all seven live FAC-163 acceptance criteria. Native worktree-built Chrome evidence proves honest lifecycle states, bounded explicit loading, recovery, manual hibernation, cached content after cleanup, and pinned-tab protection. Fixture evidence alone is insufficient. No personal browser, backend scheduler redesign, merge, deployment, or paid calls.

## Throughput checkpoint

- [x] Blocking first steps. Refresh live ticket, production evidence and current code. Probe native reload, readiness, capture and re-discard before choosing the queue contract.
- [x] Independent workstreams. Read-only extension and UI exploration can run separately. Design candidates own separate files. One implementation owner integrates protocol, extension queue, UI and tests.
- [x] Shared mutable state. Extension session state and the physical browser are real single-owner invariants. One queue actor owns wake and cleanup across viewers. No other workspace is changed.
- [x] Smallest safe decomposition. Two bounded explorers, then two design candidates and a cross-judge. One integrated implementation owner avoids protocol and lifecycle races. Verification reviews the resulting artifact independently.

## Designed phases

1. Read-only production diagnosis and bounded synthetic native Chrome feasibility probe at baseline HEAD.
2. Ground the Browser architecture and compare two queue and recovery designs.
3. Implement the protocol and extension lifecycle actor with bounded cache, recovery and pinned command guards. Verify regressions.
4. Implement honest UI states, sleeping filters, single and batch actions, progress controls and pinned protection. Verify running app and React advisory.
5. Exercise native edge cases and a 450-item synthetic queue, review concurrency and decision trail, then prepare the authorized review result.

## Acceptance matrix

| Criterion | Evidence | Verdict |
| --- | --- | --- |
| 1. Native baseline reproduction and build identity | Probe at baseline 6f5ade7 reproduced it: restored tabs report `status: "unloaded"`, `discarded: false`, and the hub showed them as Loading, unchanged after 20 s (`probe.json`). After the fix, native lane check 1 shows 26 of 30 restored tabs Sleeping and 0 Loading after 20 s (`docs/browser-validation/sleeping-run.md`, screenshot 20). Identity: Chrome for Testing 153.0.8010.12, extension `ohpalbbmodgclkjoknohidbcnnnaadic` v0.1.1 built from 7fd7b6e. | VERIFIED |
| 2. Lifecycle, filters, lens waiting and restart | Seam 1 `sleeping.test.ts` covers classification (unloaded, frozen, not-loaded), the 30 s Loading bound turning into Not responding, no wake from snapshot, claim or previews, and worker restart. Native checks 2 and 3: the Sleeping filter shows 26 rows, and entering Browser, filtering and selecting cause 0 page loads. Native check 10: the lens bar goes from "0/46 · 34 waiting · 8 sleeping · 4 unreadable" to "40/46 · 2 waiting · 4 unreadable" after Load content, with no second click (screenshots 21, 29, 30). The restart is native too, in check 11. | VERIFIED |
| 3. Loading, cleanup and concurrent user changes | Native check 4: banner Load content finished 26/26, each page loaded once, at most 3 loading, the active tab unchanged, all 26 discarded again. Native check 5: the inspector shows captured content of a sleeping tab with no wake. Native check 6: a frozen tab ends discarded and the note says so. Seam 1 covers timeout, login redirect, pause and resume, cancel putting woken tabs back, retry failed only, partial results, activation, navigation, close and move during a run, cleanup failure pausing the run, a duplicate request joining the run, and Put to sleep eligibility. Native check 7 covers Put to sleep with a mixed selection and the warning. | VERIFIED |
| 4. 450-item queue and representative resource limits | Native check 11: 450/450 done in 201 s (2.24 tabs/s), at most 3 awake (sampled every 100 ms), the worker stopped after 100 done and resumed, each page loaded exactly once (fixture server hits), 0 tabs left awake. Memory: the RSS sum of the browser's process tree stayed flat (56405 → peak 56410 MB). The absolute figure counts shared pages once per process, so it is not a RAM size. It shows only that the run added no measurable memory. Synthetic local pages load in about 70 ms, so throughput is an upper bound and does not predict real sites. | VERIFIED for concurrency, deduplication, restart and leaks. Memory: PARTIAL (flat delta only, no absolute ceiling, per the ticket's note) |
| 5. Native pinned-tab protection including races | Native check 8: pinned tabs keep [pinned, index, group, window] through Put to sleep and Load content, and the marker shows (screenshot 28). Native check 9: Move to group through the real bridge groups only the unpinned tab and keeps a tab pinned after selection, reporting "Pinned — kept in place." Seam 1 covers autogroup exclusion, an all-pinned selection and the pin re-read just before mutation. | VERIFIED |
| 6. Automated, running app and native evidence | `bun run typecheck` passes. `bun test` gives 625 pass, 0 fail. The native lane (`LINKLOG_BROWSER_ONLY=sleeping bun run test:browser`) gives 11/11 with screenshots 20–31 in `docs/browser-validation/`. react-doctor (advisory) reported 7 warnings and none were fixed: an intentional await-in-loop re-read guard, find-in-loop, and component complexity. verify-linklog does not load the extension, so the running-app UI evidence is the native lane, which drives the real app against the worktree-built extension. | VERIFIED. The full Playwright `test:browser` suite was not rerun, because those sections never discard tabs and the changed code paths are covered by Seam 1. |
| 7. Integrated complete delivery | One branch carries protocol v3, extension LoadQueue, sleep and pin guards, the UI and the tests. Non-draft PR https://github.com/facundoPri/link-log/pull/34 with `Closes FAC-163`. Linear read-back on 2026-11-04: status In Review, PR #34 attached. | VERIFIED |

Open: tabs that capture the screen, camera or microphone are detected only when Chrome refuses the discard. The refusal is reported per tab, but there is no automatable native media capture to prove it. Audible tabs are excluded through `tab.audible` (Seam 1 only).

## Phase 1 probe results (2026-11-04, partial)

Script: `planning/fac-163/probe.ts` (raw CDP attached only to the extension worker; results in `planning/fac-163/probe.json`). Chrome for Testing 153.0.8010.12 (Playwright chromium-1243), headless new, isolated profile `.cache/fac163-probe/profile`, extension built from this worktree (HEAD 6f5ade7, unmodified extension code), synthetic pages on 127.0.0.1:3197.

| Question | Observation | Consequence |
| --- | --- | --- |
| Endless "Loading" | `--restore-last-session` with 30 tabs: first 4 load, the rest are `status: "unloaded"`, `discarded: false`. The hub DTO reports them as `status: "complete"`, `content: "loading"`, unchanged after 20 s. | Prime suspect confirmed: `contentAccess()` and `tabDto()` treat restored-unloaded as loading. |
| Background wake | `chrome.tabs.reload()` on a discarded tab: 0 `onActivated` events, focused window and active tab unchanged, `complete` in ~55 ms locally. | Wake = reload, no activation. |
| Readiness and capture | `extract.js` + `__linklogExtract` right after `complete`: ok, ~1.8k chars, ~20 ms. | Readiness = status complete plus short settle, bounded. |
| Re-discard | `chrome.tabs.discard()` keeps the tab id under raw CDP; pin, index, group and window unchanged for a pinned and a grouped tab. Under Playwright, discard returned a new id and then crashed the browser (headless and headed). | Track items by tabInstanceId and follow `onReplaced`. Seam 2 must not let Playwright attach to tabs that get discarded. |
| Frozen | CDP-frozen tab reports `frozen: true`; `executeScript` does not return in 3 s; `discard()` works and leaves it `discarded: true, frozen: false`; reload + capture then works. | Frozen slot = discard, then wake; ends discarded (as the ticket says). |
| Login redirect | Woken tab lands on `/login?next=…` (documentKey differs). | Document mismatch → fail, leave awake. |
| Slow page | `status: "loading"` while the server delays. | Loading bound needed. |
| Timing and memory for N | Bench alone (`PROBE_BENCH=1`, `probe-bench.json`), 18 tabs per run: per-tab wake→capture→sleep p50 63–76 ms, p95 ≤ 90 ms for N = 1, 3, 5, 8; throughput scales linearly (13 → 45 → 64 → 90 tabs/s); `maxAwake` equals N every run. RSS delta at peak: 156/94/55/0 MB (plain pages) and 277/184/366/0 MB (32 MB pages). | Timing: VERIFIED for local pages only. They load in ~70 ms, so this shows no contention in the extension, not real-site latency. Memory: INCONCLUSIVE. Runs last 0.2–1.4 s against a 150 ms `ps` sampler, and the ~4 GB baseline includes every Chrome for Testing process, so the deltas are noise. Nothing contradicts the ticket's N = 3 and 30 s, so both stand as constants. |

Not yet probed: wake of a restored-unloaded tab (the probe picked a loaded one; fix: choose a tab with `status === "unloaded"`), discard of audible or capturing tabs.
