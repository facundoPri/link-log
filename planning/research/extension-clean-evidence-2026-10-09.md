# Extension Clean: local cache and server ownership evidence

**Disposition: retain the narrow local-cache observation, downgrade its security significance to informational/local hardening, and do not block the auth merge on F2.** No remote-account deletion or server ownership bypass was demonstrated. B's ordinary Clean button did not affect A; a crafted call from the same browser profile, supplied with known A lens IDs, removed A's temporary extension records. Submitting that call's cancellation metadata as authenticated B did not authorize any server mutation of A's data.

This independently checks F2 in `auth-final-review-2026-10-09.md`; it does not modify that report or propose an implementation change.

## Executed evidence

Final run: **6/6 focused checks passed**, 2026-10-09 13:57:46–13:58:24 UTC, Chromium **153.0.8010.12**, real unpacked MV3 extension, HEAD `df26822b0d0e61b89feadddd870b7f834951998e`. The Clean implementation, bridge protocol, frontend runner and ownership routes matched HEAD. The final source snapshot stayed unchanged throughout the replay; it also records concurrent, unrelated local-service capability edits in the Worker/launcher. The AuthScreen work was left alone.

- [Runnable harness](../../.cache/extension-clean-evidence-2026-10-09/run.ts), [isolated environment](../../.cache/extension-clean-evidence-2026-10-09/env.ts), [R2 snapshot reader](../../.cache/extension-clean-evidence-2026-10-09/r2-snapshot.py).
- [Sanitized JSON results](../../.cache/extension-clean-evidence-2026-10-09/results.json): full before/after business rows, hashes, local counts, Clean bridge messages, HTTP method/path/status summaries and R2 logical-object/blob snapshots. No cookies, session tokens, auth headers or email links are recorded.
- [Source provenance](../../.cache/extension-clean-evidence-2026-10-09/provenance.json), [A before Clean](../../.cache/extension-clean-evidence-2026-10-09/01-a-before-clean.png), [B after crafted Clean](../../.cache/extension-clean-evidence-2026-10-09/02-b-after-crafted-clean.png).

The environment is adapted from `tests/browser/env.ts`: unique UI/API/site ports **3217/8917/3218**, state and Chromium profile entirely under the owned evidence directory, real local Better Auth signup/email verification, synthetic A/B accounts, local D1/R2/Queue and deterministic Jev fixtures. It neither uses a global browser profile nor touches ports 3100/8800 or `.wrangler/demo-review-2026-10-09`. The extension is built into this directory; the shared `dist/` is not rebuilt.

## Exactly what changed

“Results” below counts extension cache records, including unfinished records; “pending” counts extension request records. A's retained records were one completed answer plus one accepted/queued local record. Its backend evaluation had already finished; the probe deliberately withheld the extension deposit, making the local pending state stable without a provider race.

| Case | Local before → after | Server outcome |
| --- | --- | --- |
| A's ordinary UI Clean, completed answer | A results **1 → 0**, pending **0 → 0** | Bridge returned `removed: 1, requests: []`; business rows and R2 unchanged |
| B's ordinary UI Clean, its distinct server-created lens ID | B results **1 → 0**, pending **0 → 0**; A results **2 → 2**, pending **1 → 1** | Bridge returned `removed: 1, requests: []`; business rows and R2 unchanged |
| B's scoped reads and invalid/unknown Clean inputs | A results **2 → 2**, pending **1 → 1** | B `results` and `pending` empty; empty and guessed lens lists removed 0; malformed/missing lists were discarded by bridge validation (probe timeout) |
| B's crafted Clean, both known A lens IDs | A results **2 → 0**, pending **1 → 0** | Returned one A request ID/target key; authenticated B cancellation **404**; all tested foreign routes **404**, business rows and R2 unchanged |
| Supporting queued-job authorization control | No cache claim made by this control | B cancellation **404**, no business/R2 change; A cancellation **200**, `cancelled: 1`, no deleted rows |
| A's own pending Clean through the actual UI | A results **1 → 0**, pending **1 → 0** | UI → bridge returned one request → actual frontend `DELETE /api/browser/evaluations/:requestId` **200**; only the queued job row changed to `failed`/`Cancelled` |

A valid guessed lens ID can still increment that ID's local generation counter; “removed nothing” does not mean no internal cache bookkeeping write. Empty IDs are not a wildcard. No separate no-handshake connection test was run.

The two queued-job controls **reset an already completed synthetic job to `queued` in the disposable D1** after its real HTTP evaluation. This is a deterministic authorization/cancellation control, not evidence about naturally racing live Queue consumers. The final case nevertheless exercises the unmodified real UI menu and confirmation, MV3 bridge, returned cancellation metadata and frontend HTTP call end to end.

## Server preservation, with nonempty controls

Before and after both normal B Clean and crafted B Clean, the exact business-row contents hashed to:

`003b02b7b4f52df8b2957c7d0638ba674a95f154e10dfb913812c239a58d0278`

| Persisted resource | Before | After crafted B Clean and foreign requests |
| --- | ---: | ---: |
| Saved links | 2 | 2 |
| Lens definitions | 4 | 4 |
| Saved-link lens evaluations (`lens_results`) | 1 | 1 |
| Tag evaluations | 1 | 1 |
| Browser request receipts | 4 | 4 |
| Browser targets | 4 | 4 |
| Jobs | 4 | 4 |
| Batches | 4 | 4 |
| Usage events | 4 | 4 |
| Tags / link memberships / pinned browser groups | 1 / 0 / 0 | 1 / 0 / 0 |
| R2 live objects / blob files | 1 / 1 | 1 / 1 |

Full row equality was checked, not just counts. The R2 sentinel held synthetic saved-link content at A's owner-prefixed key; logical object metadata and blob bytes were unchanged, aggregate hash `f18a50c297eeff8fbb43b2a1fbb744ac7638f3d27263938b867eba4201ff7a00`. Saved links/evaluations and the R2 sentinel were explicitly seeded fixtures, avoiding external extraction. The browser requests/jobs were created through real HTTP. “No server mutation” here means these business resources and R2; incidental auth/rate-limit bookkeeping was not compared.

Authenticated B received **404** for each of:

- `DELETE /browser/evaluations/<A request>` with the target key returned by Clean.
- `GET /browser/evaluations/<A request>` and `POST /browser/evaluations/<A request>/ack`.
- `DELETE /links/<A saved link>` and `DELETE /lenses/<A library lens>`.
- `DELETE /links/<A saved link>/lenses/<A library lens>`.
- `DELETE /batches/<A browser batch>`.

The crafted bridge call itself performs no HTTP request. The harness explicitly submitted its returned cancellation metadata as B, following the frontend's cancellation shape. The normal UI does not offer A's foreign lens ID; this was not a normal B button action. The final A queued case independently establishes the real frontend cancellation chain. Counts there were 2 links, 4 lenses, 1 lens result, 1 tag evaluation and 5 each browser requests/targets/jobs/batches/usage events, unchanged after Clean; only one job's status/step/error/completion fields changed.

## Why this is local hardening, not remote deletion

[Clean's command handler](../../apps/extension/src/background/commands.ts#L243) limits tabs to the connected Chrome window but passes no account scope into [cache.clean](../../apps/extension/src/background/cache.ts#L326). The cache matches lens IDs across the selected tabs, deletes matching local entries, advances generations, and prunes matching local pending requests. The `clean`/pruning implementation is unchanged from `32fc90f` (the later diff adds `forget`, not a Clean change).

The [frontend runner](../../src/browser/useLensRunner.ts#L249) uses returned request IDs only to cancel queued browser work. The [server cancellation route](../../worker/routes/browser.ts#L53) verifies ownership first, then updates queued jobs; it does not delete links, lens definitions, evaluations, browser receipts/targets, or R2. Cancellation metadata is an identifier, not an authorization capability. Separately, the acknowledgement route can clear an owned browser answer/capture, but B's foreign acknowledgement was rejected too.

The preconditions matter: A's cache must remain in the **same profile/session and window**, the caller must be able to issue crafted page bridge messages, and it must already know A's random lens IDs. This run switched only the disposable profile's cookie to B without invoking sign-out/`forget`; it models retained-cache state but does not claim to reproduce expiry/revocation itself. Normal sign-out has an explicit `forget` path. The ordinary B catalog contains only B's distinct lens ID, and its Clean preserved A.

A person who controls the local profile can already clear extension storage or reload the extension. Moreover, `hello.libraryScope` is page-supplied (`commands.ts:98`), not cryptographic proof of account identity. Thus this namespace inconsistency does not establish new remote authority. What can be lost is the cached Browser answer and its local resumption record; an already acknowledged Browser answer may exist only in that cache and require re-evaluation. It is not a saved-library evaluation or server record deletion.

**Corrected review wording:** “Optional consistency hardening: crafted same-profile Clean with known foreign lens IDs can evict retained local Browser cache/pending entries. Ordinary distinct-lens Clean isolates correctly, and authenticated foreign cancellation/deletion is rejected. No demonstrated server security or auth merge blocker.”

## Reproduction and limits

From the repository root, with dependencies installed and the three ports free:

```sh
bun .cache/extension-clean-evidence-2026-10-09/run.ts
bun .cache/extension-clean-evidence-2026-10-09/cleanup.ts
```

Set `CHROME_PATH` if the bundled Chrome-for-Testing executable differs. The harness recreates only its own disposable state/profile, stops its owned stack/browser/site in `finally`, and overwrites its evidence JSON. The cleanup command removes the owned profile, D1/R2/auth/email state after confirming the task ports have stopped. Scripts, JSON, screenshots and provenance remain available; `.cache/` artifacts are ignored and must be retained/copied if evidence needs to survive workspace cleanup.

This is a focused local proof, not hosted Cloudflare, production browser policy, email delivery, full QA-matrix, multi-window, native-group, profile-compromise, concurrent Queue-race or real-provider evidence. No application fix, permanent test change, commit, push or merge was made. Earlier harness attempts failed on counter grouping, snapshot reader assumptions and a 201-status assertion; those are not counted as passing evidence. The final source-stable replay executed all six checks successfully.
