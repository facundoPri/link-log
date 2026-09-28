# Browser integration run

- Chromium: 141.0.7390.37
- Extension: ahholiofnhckbdnahdbncdmcehflobaf v0.1.0
- Started: 2026-09-28T16:17:27.776Z · finished: 2026-09-28T16:20:48.386Z
- Fixture Jev calls (mock provider, not paid): 134

| Area | Check | Result | Detail |
| --- | --- | --- | --- |
| Setup | 0010 applies on a real local D1 with existing rows | pass | links 1, jobs 2, usage_events.job_id kept (j1), leases 1 |
| Connection | without the extension Browser shows connect/install steps | pass |  |
| Connection | lists only the tabs of Linklog's window (20 here, 3 in the other window) | pass | window 85578353: 20 rows; window 85578359 tabs hidden |
| Lenses and cache | activating lens A evaluates all 20 tabs once | pass | 20 Jev calls (fixture provider) |
| Lenses and cache | toggling lens A off and on reuses results (0 new calls) | pass |  |
| Lenses and cache | 3 new tabs with A active: only the 3 missing are evaluated; inactive B waits | pass | 20 reused + 3 new = 23 calls |
| Lenses and cache | filters narrow the list, never the evaluation scope | pass | Yes → 12 rows; new No tab still evaluated (24 done); inverse No filter → 12 |
| Lenses and cache | two active lenses: AND across lenses, OR within a lens | pass | Yes∧Article = 3; Yes∧(Article∨Reference) = 9; Yes∧(any option) = 12 |
| Lenses and cache | classifying tabs never creates saved links | pass | 0 links before and after 48 evaluations |
| Lifecycle and recovery | closing and reopening Linklog keeps done results (0 new calls) | pass |  |
| Lifecycle and recovery | real service-worker suspension keeps session and results | pass | worker stopped and restarted; session e2e2b16b… unchanged; 0 new calls |
| Lifecycle and recovery | API outage: stored answers stay visible, nothing is emptied | pass | banner shown; recovered by request id; 2 new calls (A, B) for the new tab |
| Lifecycle and recovery | response lost after the POST was accepted: same job, no duplicate | pass | 2 responses dropped; reconciled by GET; 2 batches, 2 calls |
| Lifecycle and recovery | queue redelivery / recovery sweeps don't repeat evaluations | pass | 4 recovery sweeps during running jobs; 4 calls for 2 tabs × 2 lenses |
| Identity and invalidation | closing and reopening the same URL is a new tab instance | pass | new tabInstanceId; re-evaluated (2 calls) |
| Identity and invalidation | navigation invalidates; hash change doesn't; SPA pushState does | pass | hash: 0 calls; pushState: 2; full navigation: 2 |
| Identity and invalidation | editing a lens: threshold reuses answers, a new question re-evaluates | pass | threshold: 0 calls; question: 28 calls (one per tab) |
| Identity and invalidation | Clean drops results, turns the lens off and doesn't re-evaluate | pass | 0 results for A, A off, lens definition kept |
| States that are not answers | provider failure is Failed with explicit retry, never No | pass | no automatic retry; explicit retry = 1 call |
| States that are not answers | no permission and internal pages stay manageable with honest states | pass | No access / Can't read shown; neither evaluated nor activated |
| States that are not answers | application pages keep deterministic evidence (GitHub PR state) | pass | facts: state Merged, 2 comments; sent to Jev as evidence and shown as a badge |
| States that are not answers | page capture excludes form values and passwords | pass |  |
| Content, previews and domains | rows show the page's own preview (description and image), read locally | pass | description and og:image from the page's metadata; nothing sent to the API |
| Content, previews and domains | clicking a tab opens the inspector with the page as Markdown and its links | pass | Markdown with GFM table, fenced code and absolute links (399 chars) |
| Content, previews and domains | domain filter: pick several (OR), remove one, clear | pass | 32 tabs → 1 (github.com) → 30 (+127.0.0.1) → cleared |
| Bridge security | non-Linklog pages get no bridge and can't reach the extension | pass | {"bridge":null,"connect":"no chrome.runtime on the page","reply":"no answer"} |
| Bridge security | bridge rejects malformed commands and ids from another window | pass | unknown command dropped by the bridge; other-window tab refused and still open |
| Save and Close | Save creates links from the local capture without remote extraction | pass | 2 links, content_source=browser, 0 extract batches; re-save = duplicate, tags kept |
| Save and Close | Close closes only the selected tabs, after revalidation | pass | 2 closed; 2 saved links untouched |
| Groups | create a pinned group from the selection | pass | native group 430864415 bound to pinned c25dfec4… |
| Groups | pinned group appears in another window without tabs and materializes on use | pass | created group 1659110466 in window 85578359 bound to the same definition |
| Groups | same name never merges groups | pass | two native 'Research' groups in window 1, one pinned definition |
| Groups | Autogroup keeps tabs grouped meanwhile and moves the rest after review | pass | tab kept in “Manual”; other moved to pinned Research (430864415 = 430864415) |
| Groups | Move to group changes a grouped tab; Ungroup keeps it open | pass | tab 85578370 open and ungrouped |
| Groups | group filters: one group, several groups (union), ungrouped | pass | Ungrouped = 29 rows; Ungrouped ∪ Manual shown together |
| Two pages, moves and a second profile | two Linklog pages in one window share results without duplicate jobs | pass | 31 tabs, 31 calls from two concurrent activations |
| Two pages, moves and a second profile | moving a tab to another window keeps its cached result | pass | row left window 1, appeared in window 2, cache unchanged |
| Two pages, moves and a second profile | moving the Linklog page switches its scope to the new window | pass | patch stream re-scoped after onAttached |
| Two pages, moves and a second profile | second profile shares pinned definitions, not tabs | pass | installation e80d4624… vs 3b7d3658… |
| Two pages, moves and a second profile | Unpin keeps real groups and their metadata | pass | 3 native “Research” groups still open; definition removed |
| Activity | browser evaluations appear in Activity with their usage | pass |  |
