# Browser integration run

- Chromium: 153.0.8010.12
- Extension: ohpalbbmodgclkjoknohidbcnnnaadic v0.1.1
- Build: 8340a6e
- Started: 2026-11-25T05:07:28.319Z · finished: 2026-11-25T05:18:02.982Z
- Fixture Jev calls (mock provider, not paid): 318
- Load content queue: {"tabs":450,"ms":201602,"tabsPerSec":2.23,"maxAwake":3,"rssBeforeMb":56994,"rssPeakMb":58757,"restartedAfterDone":100}

| Area | Check | Result | Detail |
| --- | --- | --- | --- |
| Setup | 0010 applies on a real local D1 with existing rows | pass | links 1, jobs 2, usage_events.job_id kept (j1), leases 1 |
| Connection | without the extension Browser shows connect/install steps | pass |  |
| Connection | lists only the tabs of Linklog's window (20 here, 3 in the other window) | pass | window 1237957257: 20 rows; window 1237957263 tabs hidden |
| Lenses and cache | activating lens A evaluates all 20 tabs once | pass | 20 Jev calls (fixture provider) |
| Lenses and cache | activating lens A shows its run live: sidebar indicator, one progress toast, Activity row (no reload) | pass | sidebar Applying lens; toast Applying lens to 20 tabs…0 of 20CancelActivity → Applying lens to 20 tabs…1 of 20CancelActivity → Lens applied to 20 tabsActivity; toast progress while running: 0 of 20 |
| Lenses and cache | toggling lens A off and on reuses results (0 new calls) | pass |  |
| Lenses and cache | 3 new tabs with A active: only the 3 missing are evaluated; inactive B waits | pass | 20 reused + 3 new = 23 calls |
| Lenses and cache | automatic evaluation of new tabs shows no toast, but its batch appears in Activity | pass | 0 toasts; Activity lists the automatic batch |
| Lenses and cache | filters narrow the list, never the evaluation scope | pass | Yes → 12 rows; new No tab still evaluated (24 done); inverse No filter → 12 |
| Lenses and cache | two active lenses: AND across lenses, OR within a lens | pass | Yes∧Article = 3; Yes∧(Article∨Reference) = 8; Yes∧(any option) = 12 |
| Lenses and cache | classifying tabs never creates saved links | pass | 0 links before and after 48 evaluations |
| Lifecycle and recovery | closing and reopening Linklog keeps done results (0 new calls) | pass |  |
| Lifecycle and recovery | real service-worker suspension keeps session and results | pass | worker stopped and restarted; session 169e8cac… unchanged; 0 new calls |
| Lifecycle and recovery | API outage: stored answers stay visible, nothing is emptied | pass | banner shown; recovered by request id; 2 new calls (A, B) for the new tab |
| Lifecycle and recovery | response lost after the POST was accepted: same job, no duplicate | pass | 2 responses dropped; reconciled by GET; 2 batches, 2 calls |
| Lifecycle and recovery | queue redelivery / recovery sweeps don't repeat evaluations; polling stays calm | pass | 4 recovery sweeps during running jobs; 4 calls for 2 tabs × 2 lenses; 7 status polls in 7.5 s |
| Identity and invalidation | closing and reopening the same URL is a new tab instance | pass | new tabInstanceId; re-evaluated (2 calls) |
| Identity and invalidation | navigation invalidates; hash change doesn't; SPA pushState does | pass | hash: 0 calls; pushState: 2; full navigation: 2 |
| Identity and invalidation | editing a lens: threshold reuses answers, a new question re-evaluates | pass | threshold: 0 calls; question: 28 calls (one per tab) |
| Identity and invalidation | Re-evaluate this window runs every readable tab exactly once | pass | 28 tabs → 28 calls, even across claim rounds of 20; one toast: Applying lens to 20 tabs…0 of 20CancelActivity → Lens applied to 28 tabsActivity |
| Identity and invalidation | Clean drops results, turns the lens off and doesn't re-evaluate | pass | 0 results for A, A off, lens definition kept |
| Identity and invalidation | activating a lens while another lens's run is in flight runs it at once with its toast; the next automatic run stays quiet | pass | lens A ran over 29 tabs right after lens B's run, one toast (Applying lens to 29 tabs…28 of 29CancelActivity); the next automatic run: 0 toasts |
| States that are not answers | provider failure is Failed with explicit retry, never No | pass | no automatic retry; explicit retry = 1 call |
| States that are not answers | an explicit run that fails ends in an error toast that points to Activity | pass | error toast “Lens applied to 1 tab · 1 failed — see Activity”; its Activity action opens Activity |
| States that are not answers | an explicit run with some tabs failed ends in a toast that counts the failures and points to Activity | pass | 1 of 31 tabs failed: Lens applied to 31 tabs 1 failed — see Activity Activity |
| States that are not answers | Cancel on a run's progress toast cancels every batch of the run | pass | 2 batches, all cancelled from one toast (“Cancelled 22 queued jobs”) |
| States that are not answers | no permission and internal pages stay manageable with honest states | pass | No access / Can't read shown; neither evaluated nor activated |
| States that are not answers | application pages keep deterministic evidence (GitHub PR state) | pass | facts: state Merged, 2 comments; sent to Jev as evidence and shown as a badge |
| States that are not answers | page capture excludes form values and passwords | pass |  |
| Content, previews and domains | rows show the page's own preview (description and image), read locally | pass | description and og:image from the page's metadata; nothing sent to the API |
| Content, previews and domains | clicking a tab opens the inspector with the page as Markdown and its links | pass | Markdown with GFM table, fenced code and absolute links (399 chars) |
| Content, previews and domains | domain filter: pick several (OR), remove one, clear | pass | 34 tabs → 1 (github.com) → 32 (+127.0.0.1) → cleared |
| Bridge security | non-Linklog pages get no bridge and can't reach the extension | pass | {"bridge":null,"connect":"no chrome.runtime on the page","reply":"no answer"} |
| Bridge security | bridge finds Linklog on a non-default port (3210) with no configured origin | pass | content script matches http://localhost/*, http://127.0.0.1/*; Linklog connected on :3210 |
| Bridge security | a local page with the marker gets the bridge, but nothing before a handshake | pass | bridge attached; snapshot before hello → “Connect first.” |
| Bridge security | bridge rejects malformed commands and ids from another window | pass | unknown command dropped by the bridge; other-window tab refused and still open |
| Save and Close | Save adds links through the normal library pipeline (extraction queued) | pass | 2 links from URLs only; 1 normal extract batch queued; re-save = duplicate, tags kept |
| Save and Close | Close closes only the selected tabs, after revalidation | pass | 2 closed; 2 saved links untouched |
| Save and Close | Open creates background tabs once per operation, even when the request is repeated | pass | 2 background tabs in window 1237957257; repeating the operation opened none |
| Groups | create a pinned group from the selection | pass | native group 290359430 bound to pinned dd645594… |
| Groups | pinned group appears in another window without tabs and materializes on use | pass | created group 236959019 in window 1237957263 bound to the same definition |
| Groups | same name never merges groups | pass | two native 'Research' groups in window 1, one pinned definition |
| Groups | Autogroup keeps tabs grouped meanwhile and moves the rest after review | pass | 1 Activity batch, 2 calls; tab kept in “Manual”; other moved to pinned Research (290359430 = 290359430); live in the sidebar and Activity, one toast, then “Suggested groups for 2 tabsActivity” |
| Groups | Move to group changes a grouped tab; Ungroup keeps it open | pass | tab 1237957274 open and ungrouped |
| Groups | group filters: one group, several groups (union), ungrouped | pass | Ungrouped = 31 rows; Ungrouped ∪ Manual shown together |
| Two pages, moves and a second profile | two Linklog pages in one window share results without duplicate jobs | pass | 33 tabs, 33 calls from two concurrent activations |
| Two pages, moves and a second profile | moving a tab to another window keeps its cached result | pass | row left window 1, appeared in window 2, cache unchanged |
| Two pages, moves and a second profile | moving the Linklog page switches its scope to the new window | pass | patch stream re-scoped after onAttached |
| Two pages, moves and a second profile | second profile shares pinned definitions, not tabs | pass | installation 025b1fe4… vs 1e737730… |
| Two pages, moves and a second profile | Unpin keeps real groups and their metadata | pass | 3 native “Research” groups still open; definition removed |
| Commands and Open links | ⌘K opens one Commands palette with 0, 1 and 2 tabs selected; G and C run tab actions | pass | 0: 2 rows · 1: 11 rows · 2: 11 rows; G → group picker; C → 2 copied, library unchanged |
| Commands and Open links | narrow chip and phone drawer are the same surface as All links | pass | 900 px: Actions chip; 390 px: phone bar, drawer tiles with Close 2 tabs and the group picker in place |
| Commands and Open links | Open links opens tabs in Linklog's window into a new group, and saves nothing | pass | 2 tabs in new group “Later” (1146652670) in window 1237957257; the already-open one kept its place; window 1237957263 unchanged; 0 library writes |
| Commands and Open links | pasting URLs in Browser opens the links page with them; nothing is saved | pass | links page lists it; Escape: 0 tabs opened, library unchanged |
| Activity | browser evaluations appear in Activity with their usage | pass |  |
| Accounts | sign-out makes the extension forget this account; the next account sees none of it | pass | refused sign-out (503) kept 105 cached entries, metadata {"meta":2,"hints":2} and the bridge; retry: forgotten, old cookie 401; second account: new library id, 0 groups, 0 lens cells, none of 3 lenses |
| Sleeping tabs (native) | restored-but-never-loaded tabs show as Sleeping, never as an endless Loading | pass | 26 of 30 restored tabs have Chrome status "unloaded" with discarded false; all 26 rows say Sleeping, 0 say Loading after 20 s; banner counts 26 |
| Sleeping tabs (native) | the Sleeping filter lists only sleeping tabs and shows their count | pass | 26 rows, all Sleeping; Show only sleeping tabs (26) |
| Sleeping tabs (native) | entering Browser, filtering and selecting never wake a tab | pass | 0 page loads of the restored tabs |
| Sleeping tabs (native) | banner Load content wakes in the background, captures, and puts every tab back to sleep | pass | 26/26 done; 26 pages loaded once each; every one done with a capture; at most 3 awake at once (584 samples); active tab 1561510628 unchanged; all 26 discarded again (26 Sleeping rows with captured content) |
| Sleeping tabs (native) | a Sleeping tab with captured content shows it in the inspector | pass | inspector: “The tab is sleeping. This is the content captured …”, page text shown, no wake |
| Sleeping tabs (native) | a frozen tab is loaded, put to sleep instead, and the UI says so | pass | frozen: true → discarded: true, frozen: false; note “It was frozen; Linklog put it to sleep instead.” |
| Sleeping tabs (native) | Put to sleep from the selection sleeps eligible tabs and reports the rest | pass | bar: 3 selected · Save 3S · Move to groupG · AutogroupA · More⌘K; palette row “Put to sleep1 of 3 are asleep, active, playing audio or a browser page. Frees memory. A page with unsaved changes, such as a half-filled form, may lose them.2/3”; toast “Put to sleep 2 tabs Frees memory. A page with unsaved changes, such as a half-filled form, may lose them.” |
| Sleeping tabs (native) | pinned tabs show a marker and keep pin, order, group and window through Put to sleep and Load content | pass | [id, pinned, index, group, window] unchanged: [[1561510631,true,0,-1,1561510560],[1561510632,true,1,-1,1561510560]] |
| Sleeping tabs (native) | Move to group keeps pinned tabs in place, including one pinned after it was selected | pass | grouped 1561510633; kept 1561510634 (pinned after selection) and 1561510631: “Pinned — kept in place.”; native [id, pinned, group] [[1561510633,false,115431596],[1561510634,true,-1],[1561510631,true,-1]] |
| Sleeping tabs (native) | a lens over sleeping tabs splits waiting from sleeping and finishes after Load content | pass | before: “Sleepy 0/46 · 34 waiting · 8 sleeping · 4 unreadable Load content Yes 0 Unsure 0 No 0”; after Load content: “Sleepy 42/46 · 4 unreadable Yes 11 Unsure 9 No 22” |
| Sleeping tabs (native) | a 450-tab queue keeps at most 3 awake, wakes each tab once across a worker restart, and leaks none | pass | 450/450 done in 202 s (2.23 tabs/s); max 3 awake (sampled every 100 ms); worker stopped after 100 done and a new worker instance resumed the same run; each page loaded exactly once; 0 left awake; browser process tree RSS 56994 → peak 58757 MB (sampled every 100 ms) |
| Sleeping tabs (native) | a page that renders its text after load is read again before it goes back to sleep, so its capture is complete | pass | a page that renders its text 2.5 s after load (the loader's settle is 1 s) was read again: capture “complete”, 1007 chars, with the late text; back asleep |
| Sleeping tabs (native) | tabs that couldn't load can be shown on their own and selected | pass | banner: “Loaded 1 of 2 tabs · 1 couldn't load”; Show failed lists only the tab that went to a sign-in page (load state failed); header toggle “Show only tabs that couldn't load (1)” pressed; Select all selects it |
| Sleeping tabs (native) | Settings sets how many tabs Load content wakes at once, kept by the extension across a worker restart | pass | default 3; chose 5 → storage.local loadSettings {"concurrency":5}; after a worker restart and a reload Settings still shows 5; set back to 3 |
