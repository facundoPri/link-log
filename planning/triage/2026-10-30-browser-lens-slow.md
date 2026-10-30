# Browser lens on 21 tabs takes ~20 s

## Symptom

A Browser lens over the 21 tabs of a window took ~20 s from the click to the last result. Results seemed to arrive about 5 at a time.

## Evidence

Production, 2026-10-30, one lens (`noul`), two requests: batch `5172df04` (20 tabs, saved 15:27:25.8Z) and `f3962428` (1 tab, saved 15:27:30.6Z). The live version (`6c4b7c7d`) is untagged; code paths below are from `production-deploy` at `f990b6d`.

- `jobs`: 19 `done`, 2 `failed` with "Jev rejected the content for exceeding its token window".
- `usage_events`: 21 TypeSafe calls, 389 ms average, 1,262 ms max.
- `prod.ts timeline 5172df04-…`: first Jev call at +8.1 s; 5 calls between +8.1 and +8.35 s, then roughly one every 0.5–1 s; last settled at +19.4 s.
- `workflows instances describe`: each instance runs ~2 s (`evaluate-jev` ~1 s). For the first job, "Queued" (`create()`) came 4.5 s after the job was saved and "Start" 3 s after that. For job #12, `create()` came 12 s after it was saved.

## Cause

Workflow instances are created one at a time. `dispatch` (`worker/jobs.ts:251`) handles each Queue message in a `for` loop: a D1 read, then `await env.PROCESS_LINK.create()`, before moving to the next. At ~0.5–0.6 s per `create()`, a 20-job batch needs ~12 s just to start its Workflows. The ~4.5 s before the first `create()` (Queue delivery) and ~3 s before the first instance starts are fixed costs on top.

The user's guess is refuted: no limit of 5 applies. `browser-lens` uses the `jev` pool (16 slots, `worker/jobs.ts:9`), and the three instances inspected got their slot on the first try (`provider-slot-0` → `true`). The early burst of 5 is the start of the sequential loop overlapping with Workflow startup.

Confidence: high for the sequential `create()`, which matches the "Queued" times of the three instances described and the one-by-one spacing of all 21 Jev calls. The split of the first ~8 s between Queue delivery and the POST is inferred: nothing logs it.

## Suggested fix

Start a batch's Workflows concurrently in `dispatch`: group messages by job id (so a repeated message still creates one instance) and run them through `Promise.all`, keeping per-message ack/retry. Prove it with the same `timeline` on a 20-tab lens: every instance's "Queued" time should fall within ~1 s of the first. Not implemented.

## Observability gaps

- Dispatch is invisible: no event records saved → `create()` per job.
- No job lifecycle event (queue wait, run time).
- The live version has no commit tag.

All three are in `docs/agents/production-observability.md`.
