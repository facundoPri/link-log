# Browser integration run

- Chromium: Chrome/153.0.8010.12
- Extension: ohpalbbmodgclkjoknohidbcnnnaadic v0.1.1
- Build: 66d586b + uncommitted changes
- Started: 2026-11-25T02:19:54.628Z · finished: 2026-11-25T02:25:30.431Z
- Fixture Jev calls (mock provider, not paid): 42
- Load content queue: {"tabs":450,"ms":228333,"tabsPerSec":1.97,"maxAwake":3,"rssBeforeMb":54921,"rssPeakMb":58982,"restartedAfterDone":101}

| Area | Check | Result | Detail |
| --- | --- | --- | --- |
| Sleeping tabs (native) | restored-but-never-loaded tabs show as Sleeping, never as an endless Loading | pass | 26 of 30 restored tabs have Chrome status "unloaded" with discarded false; all 26 rows say Sleeping, 0 say Loading after 20 s; banner counts 26 |
| Sleeping tabs (native) | the Sleeping filter lists only sleeping tabs and shows their count | pass | 26 rows, all Sleeping; Show only sleeping tabs (26) |
| Sleeping tabs (native) | entering Browser, filtering and selecting never wake a tab | pass | 0 page loads of the restored tabs |
| Sleeping tabs (native) | banner Load content wakes in the background, captures, and puts every tab back to sleep | pass | 26/26 done; 26 pages loaded once each; every one done with a capture; at most 3 awake at once (614 samples); active tab 89812852 unchanged; all 26 discarded again (26 Sleeping rows with captured content) |
| Sleeping tabs (native) | a Sleeping tab with captured content shows it in the inspector | pass | inspector: “The tab is sleeping. This is the content captured …”, page text shown, no wake |
| Sleeping tabs (native) | a frozen tab is loaded, put to sleep instead, and the UI says so | pass | frozen: true → discarded: true, frozen: false; note “It was frozen; Linklog put it to sleep instead.” |
| Sleeping tabs (native) | Put to sleep from the selection sleeps eligible tabs and reports the rest | pass | bar: 3 selected · Save 3S · Move to groupG · AutogroupA · More⌘K; palette row “Put to sleep1 of 3 are asleep, active, playing audio or a browser page. Frees memory. A page with unsaved changes, such as a half-filled form, may lose them.2/3”; toast “Put to sleep 2 tabs Frees memory. A page with unsaved changes, such as a half-filled form, may lose them.” |
| Sleeping tabs (native) | pinned tabs show a marker and keep pin, order, group and window through Put to sleep and Load content | pass | [id, pinned, index, group, window] unchanged: [[89812855,true,0,-1,89812784],[89812856,true,1,-1,89812784]] |
| Sleeping tabs (native) | Move to group keeps pinned tabs in place, including one pinned after it was selected | pass | grouped 89812857; kept 89812858 (pinned after selection) and 89812855: “Pinned — kept in place.”; native [id, pinned, group] [[89812857,false,891204306],[89812858,true,-1],[89812855,true,-1]] |
| Sleeping tabs (native) | a lens over sleeping tabs splits waiting from sleeping and finishes after Load content | pass | before: “Sleepy 0/46 · 34 waiting · 8 sleeping · 4 unreadable Load content Yes 0 Unsure 0 No 0”; after Load content: “Sleepy 42/46 · 4 unreadable Yes 11 Unsure 9 No 22” |
| Sleeping tabs (native) | a 450-tab queue keeps at most 3 awake, wakes each tab once across a worker restart, and leaks none | pass | 450/450 done in 228 s (1.97 tabs/s); max 3 awake (sampled every 100 ms); worker stopped after 101 done and a new worker instance resumed the same run; each page loaded exactly once; 0 left awake; browser process tree RSS 54921 → peak 58982 MB (sampled every 100 ms) |
