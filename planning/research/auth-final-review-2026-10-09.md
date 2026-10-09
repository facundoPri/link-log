# FAC-40 / FAC-41 — Final independent review, 2026-10-09

**Disposition: changes requested for F1 (P2 session renewal).** F2 is a reproduced, inherited P3 extension namespace gap, non-blocking on its own. No new server-side cross-user data access or authentication bypass was demonstrated. Review completion is not deployment approval.

## Scope and source identity

Reviewed application commit **`df26822b0d0e61b89feadddd870b7f834951998e`**, with the requested comparison:

```sh
git diff 32fc90f40c6f136e8038aafa0a143404e531d0f4...df26822b0d0e61b89feadddd870b7f834951998e
```

The review covered auth/session configuration and the installed Better Auth **1.7.7** / Hono **4.13.12**, middleware/origin boundaries, owner-scoped routes and D1/R2 access, persisted ownership through Queue/Workflow/usage, Browser/extension state, migrations/adjudication, and the `765ba7b` / `e850b7d` fixes and regressions. The owner-approved scope is Better Auth/Hono, a public free multiuser product, private user data, and real local demo authentication. Billing, API keys, social login, passkeys and sharing are not acceptance requirements here. Ticket scope was taken from the dispatch and recorded owner decisions; I did not fetch or mutate Linear.

This was review-only. A separate worker owns the AuthScreen redesign; that uncommitted redesign is outside this verdict. All app/test sources exercised by the targeted probes matched the pinned commit when checked (`git diff --name-only df26822...` was empty). I wrote only this report and isolated ignored evidence under `.cache/auth-final-review-2026-10-09/`. No application/test/report edits elsewhere, commit, push, deployment, live state access, real mail or paid provider calls were made.

## Findings

### F1 — P2: private API session renewal drops the renewed browser cookie

**Location:** `worker/http/middleware.ts:51` (`requireSession`), supported by `worker/auth.ts:72–76`. Introduced with the new auth middleware relative to `32fc90f`; not a regression of the latest error-handling fix specifically.

`auth.api.getSession({ headers })` returns the session data while internally renewing an old-enough session. The middleware uses that data but does not obtain/forward Better Auth's response headers. In installed Better Auth 1.7.7, `dist/api/routes/session.mjs:198–214` updates D1 `expiresAt` and calls `setSessionCookie` in the same renewal branch. Discarding those headers advances server expiry but leaves the browser cookie's original expiration unchanged.

**Concrete trigger:** keep a signed-in SPA open across the one-day `updateAge`, then let a private API request be the first session accessor after renewal becomes due. A normal mutation can do this; while work is active, `src/App.tsx:172–206` also polls library/jobs every 1.8 seconds. The client has no configured periodic auth-session polling: installed `dist/client/session-refresh.mjs:12–14` defaults to interval 0 and focus refetch enabled, with visibility/online/broadcast triggers. Consequently a private call can renew before a subsequent visibility-triggered `/api/auth/get-session`. That subsequent auth request sees the already-renewed D1 session and does not send a replacement cookie either. If private requests repeatedly win these renewal windows, the browser eventually discards its original seven-day cookie despite continued activity and a later D1 expiry, forcing an unexpected login. A fresh page/session lookup that wins the renewal window can avoid the symptom; this is not a claim that every user is always logged out after seven days.

**Reproduction executed:** first test in [probes.test.ts](../../.cache/auth-final-review-2026-10-09/probes.test.ts), using the real Worker/Hono/Better Auth path, TestD1, and a synthetic verified session:

1. Set that test session's `expiresAt` to now + 5 days and `updatedAt` to now − 2 days, putting it past the configured refresh threshold without expiry.
2. GET `/api/library` with its valid cookie: **200**, D1 expiry advances by more than one day, **zero Set-Cookie headers**.
3. Immediately GET `/api/auth/get-session`: **200**, still **zero Set-Cookie headers**.
4. Control: make the session due again and access `/api/auth/get-session` first: it **does emit `linklog.session_token`**.

Observed the header loss and database update directly; the eventual browser expiry is the consequence of the unchanged cookie lifetime, not an observed seven-day browser run. This is session persistence/UX, not cross-account access or failed revocation.

**Suggested correction:** obtain Better Auth's returned headers and append all Set-Cookie values to the Hono response, or make private authorization lookups non-refreshing and ensure the browser auth path performs renewal. Add a regression for private-first renewal followed by the auth endpoint, including cookie lifetime, rather than testing D1 expiry alone. Keep the current 401/503 distinction.

### F2 — P3, non-blocking: extension Clean does not constrain writes to the connection's account scope

**Location:** `apps/extension/src/background/commands.ts:243–247`; underlying `apps/extension/src/background/cache.ts:326–346`, particularly `:337` and `:346`.

The handler scopes the window snapshot but passes only lens IDs and tab IDs to `cache.clean`. The local variable named `scope` on line 246 is a list of tab instance IDs, not the library/account scope. The cache removes matching lens entries across all library scopes, returns in-flight request IDs/target keys, and prunes requests without checking their scope. Generations are also keyed by lens ID rather than account + lens.

**Reproduction executed:** second test in [probes.test.ts](../../.cache/auth-final-review-2026-10-09/probes.test.ts), using real command/cache classes and the repository's fake Chrome/KV harness. A claims a lens evaluation and marks it accepted. Switch the connection to B without `forget` (the supported expiry/revocation case). B's ordinary `pending` and `results` reads both correctly show nothing. Send a crafted B bridge `clean` call naming A's known lens ID: it reports **one removed result**, returns **A's request ID**, and afterward A has **zero pending requests and zero cached results**. No A library scope was supplied in that Clean call.

**Exposure boundaries:** the normal B catalog/UI does not expose A's random lens IDs, and distinct backend-created A/B lenses do not ordinarily collide. This therefore requires a crafted bridge call with a known foreign lens ID, not a demonstrated normal B button flow. Moreover `commands.ts:98` explicitly accepts a page-supplied `hello.libraryScope`; extension scope is a namespace, not a cryptographic identity proof. This probe is not a remote account attack, does not read A's answers, and does not bypass server ownership checks: attempts by B to cancel A's backend request still encounter the server's owner check. Native Chrome tabs/groups remain shared by profile by design.

**Attribution:** `cache.clean` and its unscoped pruning are byte-for-byte inherited from `32fc90f`. The auth diff adds account isolation and scopes adjacent command reads but does not adapt this mutation. Treat this as a low-priority remaining integration/hardening gap, not a newly introduced server security vulnerability or a reopening of the fixed group-description leak.

**Suggested correction:** pass the connection scope through Clean; constrain entry deletion, returned cancellation metadata and request pruning to it, and namespace generations consistently. Preserve the global removal behavior for actual tab close/navigation. Add cross-scope Clean tests with a foreign lens ID, in both directions. Strengthening the trust model of `hello` itself would be a separate design change.

## Existing evidence and historical findings

Read and reconciled [auth-cloudflare.md](auth-cloudflare.md), [auth-implementation-report.md](auth-implementation-report.md), [auth-code-review.md](auth-code-review.md), [auth-code-review-latest-fixes.md](auth-code-review-latest-fixes.md), [auth-validation-report.md](auth-validation-report.md), and the untracked [auth-qa-video-validation.md](auth-qa-video-validation.md) / [auth-qa-matrix.md](auth-qa-matrix.md).

- Original R1–R10 are historical findings with subsequent fixes/reviews. R3's premature cleanup, R9's partial import, R10's large-import bindings and R2's group metadata issue are not being asserted as current defects. Final R10 approval is for `a8a1f62`, with inherited prior coverage and explicit local/remote limits.
- `765ba7b` uses JSON-array bindings for Browser ack/cancel, distinguishes failed session lookup from absence, corrects quota accounting/refunds, makes internal failures generic 500s, handles explicit fixture-off values, prunes old auth rate-limit rows, and consolidates owner-scoped link lookup. `e850b7d` adds the corresponding regressions and local D1 E2E step. The targeted rerun below includes all **22 latest-review regressions**, which pass.
- The earlier claim that Better Auth never prunes `rateLimit` is not valid for installed 1.7.7; its database limiter has opportunistic expiry deletion, supplemented here by cron. Per-request auth construction captures request-specific env/mailer/waitUntil; its reported Bun CPU cost is a tradeoff, not an independently measured edge defect.
- Older reports retain statements about 100 serial dedupe reads and unfixed 100-target Browser ack/cancel. Those describe earlier snapshots and are superseded by the latest-fixes report and current implementation. Do not use them as current failure evidence.
- The reported full **220-unit / 13-E2E** results in the latest-fixes report and historical real-extension/UI runs are inherited evidence, not reruns by this reviewer. The 200-case matrix is a plan, not 200 executed passes; its local P0/P1/P2 labels are test priorities, not this report's defect severities.

### Video provenance

The existing manifest at `.cache/qa-video/validated-2026-10-05-task-89c52dde5bb6/results.json` records **12 PASS cases** (VID-01–11 and SEC-LOGS), pinned HEAD `df26822`, `source.changed=false`, 147 tracked app files, and aggregate source hash `5dd0c126220f83e1966fa5137fdd1d35f64251e2d608c9e7f7ece6c318db1a2c`. I checked the manifest/video exist, all four current automation hashes match the manifest, and independently ran ffprobe: H.264, 1280×800, 30 fps, **206.099023 seconds**, **2,986,037 bytes**, matching its record. I inspected the VID-07 empty-library and same-URL screenshots: Bruno is identified in both, the first is empty, and the second has his own tag/link. Full decoding, 52 assertions, 16 screenshot verification, leak scan and cleanup inspection are attributed to the existing independent video-validation report; I did not replay the full video or rerun its runner.

This is credible local filmed evidence for its documented subset: signup/verification/password, reload/session reuse, A/B library and content isolation, logout, forced expiry and reset. It does not prove a week of cookie renewal, extension Clean, the whole QA matrix, production cookies, email delivery, edge limits or remote Queue/Workflow behavior. It also predates the concurrent AuthScreen redesign.

## Checks executed in this review

```sh
bun test tests/auth.test.ts tests/review-latest.test.ts tests/isolation.test.ts \
  tests/migration.test.ts tests/session.test.ts tests/proxy.test.ts \
  apps/extension/tests/commands.test.ts apps/extension/tests/groups.test.ts
# 98 pass, 0 fail; 436 assertions; 8 files.

bun test ./.cache/auth-final-review-2026-10-09/probes.test.ts
# 2 pass, 0 fail; 14 assertions. These assert and reproduce the defects above.
```

Logs: [targeted-tests.log](../../.cache/auth-final-review-2026-10-09/targeted-tests.log), [probes.log](../../.cache/auth-final-review-2026-10-09/probes.log). Bun **1.3.14**. Tests used in-memory SQLite through TestD1, fake R2/Queue/mail/Chrome as appropriate, and the installed pinned auth library. No network servers or full new QA campaign were required. No fresh typecheck/build, workerd E2E, browser suite or remote tests were run; no implementation was changed. TestD1's 100-binding guard is useful regression coverage but is not a measurement of remote D1 query budgets.

## Standards and specification disposition

**Standards:** no separate actionable documented-style violation was identified. The repository's applicable operational constraints and ownership boundaries were respected. No speculative code-smell refactoring is requested. The functional gaps above belong to behavior/spec review, not a formatting/tooling checklist.

**Spec:** Better Auth/Hono and the owner-approved public multiuser model are implemented. Private routes derive a principal from the session; SQL reads/mutations include ownership or first establish an owned parent. R2 reads require an owned link and permitted prefix. Background jobs resolve the persisted batch owner, while related insert triggers and owner immutability reinforce the boundary; Queue payloads do not grant authority. Legacy rows remain NULL-owned until explicit adjudication, with unique per-user library identity. The targeted isolation/migration/auth tests support these observations, without proving every adversarial interleaving. F1 leaves a session-persistence defect; F2 qualifies the extension's mutation isolation claim. Real demo authentication is documented and covered by existing evidence; no bypass requirement is introduced.

## Deployment and delivery gates, separate from defects

- **Remote readiness remains unverified:** canonical HTTPS domain, real Email Service delivery/DNS, secrets/bindings, remote migration rehearsal, Secure-cookie behavior, edge client-IP/rate limiting, alternate hosts/previews, remote A/B isolation and Queue/Workflow/cron. The local demo/video cannot certify these.
- **Known operational decisions:** anonymous email budget exhaustion remains possible within deliberate caps; no new CAPTCHA requirement is imposed by this review. Confirm effective D1 plan and query budget for large batches; free access for product users does not imply Workers Free. Multi-quota compensation is not a global transaction, and D1/R2/Queue are not one atomic system.
- **Legacy data:** obtain the owner's destination choice and rehearse backup/restore/adjudication on a copy before any real transfer. No real data was assigned here.
- **Delivery gap, attributed to coordinator:** its live PR check reports remote PR #5 at `eb98062`, while local `765ba7b` / `e850b7d` / `df26822` are not yet in that remote head. I did not independently query GitHub. This review cannot approve the older remote tree or the concurrent redesign; eventual delivery must identify its final commit and applicable evidence.

Primary documentation checked on 2026-10-09: [Better Auth Hono integration](https://better-auth.com/docs/integrations/hono), [session management](https://better-auth.com/docs/concepts/session-management) (expiry/updateAge semantics), and [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/). Pinned installed source and the executable probes take precedence for the exact behaviors reported here. Current documentation confirms that the parameter limit and queries-per-invocation budget are distinct; no hosted budget pass is inferred.

**Final accounting:** one P2 implementation fix requested (F1); one P3 inherited extension namespace hardening item (F2), non-blocking by itself; no demonstrated new server-side ownership bypass. Hosted readiness and final remote commit delivery remain separate gates.
