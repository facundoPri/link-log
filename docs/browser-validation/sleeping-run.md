# Browser integration run

- Chromium: Chrome/153.0.8010.12
- Extension: {"id":"ohpalbbmodgclkjoknohidbcnnnaadic","version":"0.1.1"} v
- Build: 7fd7b6e
- Started: 2026-11-04T18:17:52.221Z · finished: 2026-11-04T18:22:30.398Z
- Fixture Jev calls (mock provider, not paid): 42
- Load content queue: {"tabs":450,"ms":201242,"tabsPerSec":2.24,"maxAwake":3,"rssBeforeMb":56405,"rssPeakMb":56410,"restartedAfterDone":100}

| Area | Check | Result | Detail |
| --- | --- | --- | --- |
| Sleeping tabs (native) | restored-but-never-loaded tabs show as Sleeping, never as an endless Loading | pass | 26 of 30 restored tabs have Chrome status "unloaded" with discarded false; all 26 rows say Sleeping, 0 say Loading after 20 s; banner counts 26 |
| Sleeping tabs (native) | the Sleeping filter lists only sleeping tabs and shows their count | pass | 26 rows, all Sleeping; Show only sleeping tabs (26) |
| Sleeping tabs (native) | entering Browser, filtering and selecting never wake a tab | pass | 0 page loads of the restored tabs |
| Sleeping tabs (native) | banner Load content wakes in the background, captures, and puts every tab back to sleep | pass | 26/26 done; 26 pages loaded once each; at most 3 loading at once; active tab 737346933 unchanged; all 26 discarded again (26 Sleeping rows with captured content) |
| Sleeping tabs (native) | a Sleeping tab with captured content shows it in the inspector | pass | inspector: “The tab is sleeping. This is the content captured …”, page text shown, no wake |
| Sleeping tabs (native) | a frozen tab is loaded, put to sleep instead, and the UI says so | pass | frozen: true → discarded: true, frozen: false; note “It was frozen; Linklog put it to sleep instead.” |
| Sleeping tabs (native) | Put to sleep from the selection sleeps eligible tabs and reports the rest | pass | bar: Save · Group · Autogroup · Load content (1) · Put to sleep (2) · Close · Copy; toast “Put to sleep 2 of 3 tabs 1 skipped: Already asleep. Frees memory. A page with unsaved changes, such as a half-filled form, may lose them.” |
| Sleeping tabs (native) | pinned tabs show a marker and keep pin, order, group and window through Put to sleep and Load content | pass | [id, pinned, index, group, window] unchanged: [[737346936,true,0,-1,737346865],[737346937,true,1,-1,737346865]] |
| Sleeping tabs (native) | Move to group keeps pinned tabs in place, including one pinned after it was selected | pass | grouped 737346938; kept 737346939 (pinned after selection) and 737346936: “Pinned — kept in place.”; native [id, pinned, group] [[737346938,false,200980023],[737346939,true,-1],[737346936,true,-1]] |
| Sleeping tabs (native) | a lens over sleeping tabs splits waiting from sleeping and finishes after Load content | pass | before: “Sleepy”; after Load content: “Sleepy” |
| Sleeping tabs (native) | a 450-tab queue keeps at most 3 awake, wakes each tab once across a worker restart, and leaks none | pass | 450/450 done in 201 s (2.24 tabs/s); max 3 awake (sampled every 100 ms); worker stopped after 100 done and resumed; each page loaded exactly once; 0 left awake; browser process tree RSS 56405 → peak 56410 MB (sampled every 100 ms) |
