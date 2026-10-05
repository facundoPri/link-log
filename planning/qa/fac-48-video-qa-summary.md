# FAC-48 QA walkthrough video: summary

Branch `facundoPri/fac-48-needs-attention`, FAC-48 + FAC-52..57. Plan: `planning/qa/fac-48-test-plan.md` (§11 summary table, §12 chapters). Chapter reports: `.reviews/QA-ch1-waiting.md` … `.reviews/QA-ch6-cancel.md`. Harness: `qa/video/` (see its README). Media is generated under `qa/out/` (gitignored, not committed); `qa/out/INDEX.md` is the local index of the files.

Recorded against the real UI and Worker on an isolated local stack. Every external edge (DNS, preview fetch, Browser Rendering, Jev/TypeSafe) is answered by a deterministic fixture, so no paid or remote call was made. A scenario only counts as PASS if every assertion behind its captions passed (UI text and/or API state, sometimes log lines).

## Result

**44 of 49 scenarios passed, 640/645 checks.** The 5 failures are the product behaving differently from the plan. They are kept FAILED in the video; see [Possible product bugs](#possible-product-bugs).

`qa/out/videos/full.mp4` (1665.6 s, h264 1440×900 30 fps): PR card → what the video covers (6 chapters) → caption-bar legend → chapters 1–6 (each: intro, per scenario a title card + recording, results) → results by chapter → possible product bugs. The pilot chapter is excluded (P1 is superseded by NA-01, P2 by ch2).

### Waiting is not failing (`ch1-waiting`, FAC-48)
`qa/out/videos/chapter-ch1-waiting.mp4`, 260.3 s, h264 1440×900 30 fps.

| Scenario | Plan cases | Status | Checks |
|---|---|---|---|
| RG-02 | RG-02 | PASS | 10/10 |
| NA-01 | NA-01 + NA-02 | PASS | 14/14 |
| NA-03 | NA-03 | **FAILED** | 4/5 |
| NA-04 | NA-04 | **FAILED** | 2/3 |
| NA-05 | NA-04 + NA-05 | PASS | 20/20 |

### Failures that explain themselves (`ch2-failures`, FAC-48)
`qa/out/videos/chapter-ch2-failures.mp4`, 250.8 s, h264 1440×900 30 fps.

| Scenario | Plan cases | Status | Checks |
|---|---|---|---|
| NA-07 | NA-07 | PASS | 15/15 |
| NA-10 | NA-10 + NA-19 | PASS | 19/19 |
| NA-16 | NA-16 + NA-20 + NA-26 | PASS | 24/24 |
| NA-09 | NA-09 | **FAILED** | 9/10 |
| NA-21 | NA-21 | PASS | 9/9 |
| NA-23 | NA-23 + NA-24 | PASS | 13/13 |
| NA-30 | NA-30 | PASS | 10/10 |

### Keep what you had, use what you have (`ch3-keep-use`, FAC-56 · FAC-57 · FAC-48)
`qa/out/videos/chapter-ch3-keep-use.mp4`, 275.2 s, h264 1440×900 30 fps.

| Scenario | Plan cases | Status | Checks |
|---|---|---|---|
| PF-01 | PF-01 | PASS | 8/8 |
| PF-02 | PF-02 + PF-03 + PF-04 | PASS | 28/28 |
| PF-07 | PF-07 | PASS | 12/12 |
| PF-06 | PF-06 | PASS | 18/18 |
| NA-27 | NA-27 + PF-09 | PASS | 17/17 |
| LW-01 | LW-01 (+ LW-02) | PASS | 22/22 |
| LW-04 | LW-04 | PASS | 13/13 |
| LW-05 | LW-05 | PASS | 12/12 |
| LW-06 | LW-06 | PASS | 8/8 |

### Jev waits its turn (`ch4-jev-waits`, FAC-53)
`qa/out/videos/chapter-ch4-jev-waits.mp4`, 346.8 s, h264 1440×900 30 fps.

| Scenario | Plan cases | Status | Checks |
|---|---|---|---|
| PQ-01 | PQ-01 | PASS | 24/24 |
| PQ-05 | PQ-05 | PASS | 13/13 |
| PQ-08 | PQ-08 | PASS | 10/10 |
| PQ-02 | PQ-02 | **FAILED** | 10/11 |
| PQ-03 | PQ-03 | PASS | 12/12 |
| PQ-04 | PQ-04 | PASS | 14/14 |
| PQ-06 | PQ-06 | PASS | 11/11 |
| PQ-07 | PQ-07 | **FAILED** | 5/6 |
| PQ-07b | PQ-07 (per job) | PASS | 14/14 |
| X-02 | X-02 | PASS | 16/16 |
| X-01 | X-01 | PASS | 13/13 |

### Jev failures cost what they cost (`ch5-jev-cost`, FAC-52 · FAC-54)
`qa/out/videos/chapter-ch5-jev-cost.mp4`, 229.2 s, h264 1440×900 30 fps.

| Scenario | Plan cases | Status | Checks |
|---|---|---|---|
| JC-00 | Setup | PASS | 13/13 |
| JC-01 | JC-01 | PASS | 6/6 |
| JC-02 | JC-02 | PASS | 5/5 |
| JC-03 | JC-03 | PASS | 7/7 |
| JC-04 | JC-04 | PASS | 8/8 |
| JP-01 | JP-01 | PASS | 12/12 |
| JP-02 | JP-02 | PASS | 11/11 |
| JP-03 | JP-03 | PASS | 17/17 |
| JP-04 | JP-04 | PASS | 19/19 |
| JP-01b | JP-01b | PASS | 15/15 |

### Cancel means nothing happened (`ch6-cancel`, FAC-55 · FAC-48)
`qa/out/videos/chapter-ch6-cancel.mp4`, 241.4 s, h264 1440×900 30 fps.

| Scenario | Plan cases | Status | Checks |
|---|---|---|---|
| CJ-01 | CJ-01 + CJ-10 | PASS | 20/20 |
| CJ-07 | CJ-07 | PASS | 11/11 |
| CJ-02 | CJ-02 | PASS | 13/13 |
| CJ-03 | CJ-03 + CJ-05 | PASS | 15/15 |
| CJ-04 | CJ-04 + CJ-10 | PASS | 20/20 |
| CJ-06 | CJ-06 | PASS | 4/4 |
| NA-29 | NA-29 + CJ-09 + NA-26 | PASS | 15/15 |


## Coverage against the test plan

The plan has 136 cases, 57 of them marked "Video: yes".

**Filmed (all 57 "Video: yes" cases).** Status per plan case:

| Status | Cases |
|---|---|
| PASS | NA-01, NA-02, NA-05, NA-07, NA-10, NA-16, NA-19, NA-20, NA-21, NA-23, NA-24, NA-26, NA-27, NA-29, NA-30; JC-01, JC-02, JC-03, JC-04; PQ-01, PQ-03, PQ-04, PQ-05, PQ-06, PQ-08; JP-01, JP-02, JP-03, JP-04; CJ-01, CJ-02, CJ-03, CJ-04, CJ-05, CJ-06, CJ-07, CJ-09, CJ-10; PF-01, PF-02, PF-03, PF-04, PF-06, PF-07, PF-09; LW-01, LW-04, LW-05, LW-06; X-01, X-02; RG-02 |
| FAILED as planned, behaviour shown passing another way | NA-04 (batch Cancel answers “Nothing left to cancel”; the neutral end state is shown PASS through per-job ✕ in NA-05), PQ-07 (same cause; the cascade is shown PASS through per-job ✕ in PQ-07b) |
| FAILED | NA-03 (jobs waiting for the slot never read “Queued”), NA-09 (NXDOMAIN fails fast: 1+1 attempts, not 3+2; everything else in NA-09 passes and NA-21 passes), PQ-02 (no “Skipped 1 link without content” toast; tagging itself correct) |

Adaptations (fixtures instead of httpbin/real sites, per-job ✕ where batch cancel fails, the fake TypeSafe instead of one real 401, NA-26 inside NA-16 and NA-29, CJ-06 API half only) are listed in each chapter report under "Plan cases adapted".

**Also asserted inside filmed scenarios (plan says "Video: no")**: LW-02 (sign-in form wall, in LW-01), X-03 (Jev failures never in Needs attention: PQ-04, X-02, JP-01, JP-01b, JP-03), JP-08 (one Usage row per call: JP-02), JP-10 (Jev telemetry `jev_step_failed` / `jev_batch_stopped`: JP-01, JP-03), JP-09 visible part (nothing resent after a recovery tick: JP-03, CJ-04), NA-17 in part (`link_step_failed` fields in NA-07/NA-09/NA-10/NA-16, `login_wall_detected` in LW-01), NA-11 in part (`gone` 404 in NA-30), PF-08 UI/API guard (NA-16, NA-29), RG-03 (import: NA-04/NA-05), RG-05 (auto-tag: PQ-01, JP-02), RG-06 (lenses: PQ-05, CJ-03), RG-08 (manual content: NA-16, NA-27, CJ-02).

**Covered only by automated tests (`bun test`, per the plan's notes):** NA-06, NA-13, NA-14, NA-18, NA-22, NA-25, NA-28, NA-32, JC-06, JC-08, JC-09, PQ-09 (`submitInChunks`; also not reachable through the UI, see PQ-02), PQ-12, JP-05, JP-06, JP-07, JP-09 (the race itself), CJ-08, CJ-11, PF-05, PF-13, LW-03, RG-01 (the suite itself). MG-01..MG-06 are DB/migration checks: the upgrade tests plus a manual local `wrangler d1` run.

**Still manual (local, not filmed, no dedicated test):** NA-08, NA-11 (410), NA-12, NA-15, NA-31, JC-05, JC-07 (needs the extension), PQ-10, PQ-11, PF-10, PF-11, PF-12, PF-14, LW-07, LW-08, X-04, X-05, X-06, X-07, X-08, RG-04, RG-07, RG-09, RG-10, RG-11, RG-12, RG-13, RG-14. Note **CJ-12** (batch cancel still works) is marked "covered by NA-04 and PQ-07" in the plan, and both of those FAILED for slot-waiting jobs; batch cancel of *queued/waiting Jev* jobs works (PQ-06 PASS).

**Hosted-only (after deploy):** HO-01..HO-10, plus LW-09 (real-world walls) and the hosted half of JP-01 (a slow real 401 widens the batch-stop window, see ch5 notes).

## Possible product bugs

Product code was not changed. Paths are under `qa/out/` (local, gitignored). Frame sheets come from `bun qa/video/verify.ts`.

1. **Jobs waiting for a browser slot read “Preparing content”, never “Queued”** (P2 in the plan). Scenario NA-03 FAILED (4/5).
   - API: polling `/api/batches/:id` every 2 s showed every job behind the single slot as `running · Preparing content` from 2 s on. The Workflow sets `status='running', step='Preparing content'` (`worker/jobs.ts`, load-job) before `acquire()` polls `provider_leases`.
   - UI: Activity reads `Slow but fine na-03/1 Extracting content · Attempt 1 of 2 · 12s of 1m 40s | article.qa.example Preparing content | article.qa.example Preparing content`.
   - Evidence: `shots/NA-03-failed.png`, `verify/sheets/NA-03.png`. Not specific to local dev: the slot wait lives in the Workflow in production too.
   - Suggested: a "Waiting for a browser slot" step, or keep the job `queued` until it holds a lease.
2. **Cancel batch can't cancel links waiting for the browser slot** (NA-04 is P0 in the plan). Scenarios NA-04 FAILED (2/3) and PQ-07 FAILED (5/6). Same root cause as 1.
   - API: `DELETE /api/batches/:id` → `cancelled: 0, dependents: 0`; it only cancels `queued`/`waiting` jobs, and these are `running`. Toast “Nothing left to cancel”; every link is extracted anyway, and in PQ-07 the waiting auto-tag runs too.
   - Evidence: `shots/NA-04-failed.png`, `shots/PQ-07-failed.png`, `verify/sheets/NA-04.png`, `verify/sheets/PQ-07.png`, probes in `probe/`.
   - Per-job ✕ works and gives exactly the expected end state (NA-05, PQ-07b, CJ-01, NA-29 PASS). Also affects NA-29's planned path and CJ-12.
3. **An unresolvable host fails at once instead of being retried.** Scenario NA-09 FAILED (9/10).
   - Log: `{"step":"preview","attempt":1,"max_attempts":3,"final":true,"reason":"unreachable","retryable":false,"detail":"Error: Not a public destination"}` and the same for `content`, so 1 + 1 attempts instead of the plan's 3 + 2.
   - Cause: `validateDestination` (`worker/metadata.ts`) throws "Not a public destination" on an empty DoH answer; `classify` (`worker/failures.ts`) maps it to `unreachable`, not retryable, together with private-address and port refusals. A real `.invalid` host takes the same path.
   - Evidence: `shots/NA-09-failed.png`, `verify/sheets/NA-09.png`.
   - Decide: keep it (and fix the plan's NA-09 and U-DNS rows) or make an empty DNS answer retryable while private/port refusals stay fail-fast.
4. **“Auto-tag N with content” never shows “Skipped 1 link without content”.** Scenario PQ-02 FAILED (10/11), low severity.
   - API: only the ready link gets an auto-tag job (correct); the server reports nothing skipped because `doAutoTag` (`src/App.tsx` ~L566–573) drops the no-content links before `runBatch`, so the toast at `src/App.tsx:315` never fires.
   - Evidence: `shots/PQ-02-failed.png`, `verify/sheets/PQ-02.png`. Either fix the plan line (the dialog already told the user) or report the dropped links client-side.
5. **Nested buttons in Activity batch cards** (minor, markup/a11y). Seen while filming PQ-07/PQ-07b.
   - "Cancel batch" / "Retry failed" sit inside the `CollapsibleTrigger` button (`src/components/ActivitySheet.tsx` ~L360–410); React logs "<button> cannot contain a nested <button>", and the trigger's accessible name includes "Cancel batch".

UX notes (not bugs; from the chapter reports):
- Re-extract confirmation says "extracting again replaces it", but a failed extraction keeps the content (NA-27, LW-04 prove it). Suggest "replaces it if the extraction succeeds". (ch3)
- The Inspector header drops "· Partial" while "Retry getting content" runs (`content_state` is `queued`); it returns at the end. (ch3, PF-04)
- "Auto-tagged 3 links · 3 failed — see Activity" when nothing was tagged. (ch5, JP-01)
- `jev_step_failed` for a provider 500 logs `max_attempts:2` with `final:true`; consistent but easy to misread. (ch5)
- Jobs whose extraction was cancelled carry `error:"Cancelled: its extraction was cancelled"`; Activity shows "Cancelled". (ch6)

## Plan corrections

- **NA-01 / NA-04 / RG-03:** the Add link / paste path shows "N links saved · Fetching titles and previews…" only. There is no "Extracting context for N links…" toast with Cancel and no "Extracted 6 links" toast (same on `main`). Use Activity → Cancel batch (which then hits bug 2) or per-job ✕.
- **NA-09 / U-DNS:** if bug 3 is accepted as intended, `unreachable` from an empty DNS answer is not retryable: 1 + 1 attempts.
- **NA-10:** with a real PDF the page reader returns `empty`, so the link lands in content attention (NA-16's reason). The robots.txt-like variant (file preview, text content) gives the planned preview attention.
- **PQ-01:** link B carries `jev:no`, so it is evaluated but not tagged; "tags appear on all 4" should be "on the 3 `jev:yes` links".
- **PQ-02 / PQ-09:** the "Skipped N links without content" toast cannot come from the UI path (bug 4).
- **JC-04:** the lens body field is `lensId`, not `lens` (`worker/index.ts:254`); with `lens` the API answers 400 "Pick a lens." before the Jev check.
- **CJ-01:** "3× Cancelled" is the Activity label; the API error of the two dependents is "Cancelled: its extraction was cancelled".
- **CJ-03:** `jev:slow=8000` is too short to land the ✕ on a still-waiting job reliably; 20000 works.
- **CJ-10:** "Cancelled N queued jobs" is reachable only for Jev batches (PQ-06), not for slot-waiting extractions (bug 2).
- **NA-29:** "cancel that batch from Activity or the toast" hits bug 2; filmed through the per-job ✕ (= CJ-09).
- **LW-02:** the sign-in fixture matches the pattern "log in to continue" before the generic sign-in-form rule.
- **NA-27 / LW-04:** "Re-extract context" on a link with content opens a confirmation dialog the plan doesn't mention.
- **JP-01:** the plan's one real 401 to `api.typesafe.ai` was replaced by the harness's fake TypeSafe (same product code path).

## Independent verification (final assembly)

- `bun qa/video/verify.ts` (new): ffprobe of every video, freeze (≥10 s) and black (≥1 s) detection on every clip, and a 4-frame sheet per scenario (first, middle and last step from the manifest timeline, plus the final frame) in `qa/out/verify/sheets/`.
- All 7 chapter videos and `full.mp4` are h264 1440×900 at 30 fps; `full.mp4` is 1665.6 s. All 51 raw clips probe as vp8 1440×900 (none missing or corrupt, nothing re-recorded).
- No frozen or black stretch in any of the 49 clips.
- Manifest statuses and check counts match all six chapter reports exactly (5 FAILED: NA-03, NA-04, NA-09, PQ-02, PQ-07).
- The new opening/closing cards were rendered and inspected. **Not done:** a visual pass over the 49 per-scenario frame sheets (caption vs screen, cursor visible) by this final step; the chapter workers each did that on their own frames (see their reports). The sheets are ready in `qa/out/verify/sheets/`.
- `qa/out/shots/` also holds stale `*-failed.png` from earlier attempts of scenarios that now pass; only the manifest's `screenshot` field is current.
