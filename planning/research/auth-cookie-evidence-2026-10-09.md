# Better Auth session renewal — independent browser evidence, 2026-10-09

**Verdict: the header-loss mechanism is real; retract the unconditional P2/“changes requested” merge gate for this issue.** Classify it as a **P3, non-blocking session-persistence/UX limitation** under the stated acceptance of standard Better Auth behavior. Linklog uses the same data-only session lookup as the current official Hono middleware example. This evidence establishes neither an authentication bypass nor a broken logout, and does not establish how often ordinary users encounter unexpected reauthentication. A product requirement that *all private API activity* extends the browser login would make the limitation an implementation gap to address.

This supplements F1 in `auth-final-review-2026-10-09.md`; that other worker's report was not edited. Application HEAD: `df26822b0d0e61b89feadddd870b7f834951998e`. No app/test changes, commits, cloud operations, or live-demo DB/cookie/process operations were performed.

## Reproduction and artifacts

From this checkout:

```sh
bun .cache/auth-cookie-evidence-2026-10-09/reproduce.ts
```

Optional `QA_BROWSER` selects an installed Chromium executable. Requires existing Bun/project dependencies, Wrangler and `lsof`; each invocation writes a new timestamped artifact directory. The runnable [driver](../../.cache/auth-cookie-evidence-2026-10-09/reproduce.ts) first uses **the original `scripts/qa/lib/stack.ts`**: real Bun `src/index.ts` → `src/proxy.ts` → workerd → native Better Auth/D1. A second isolated stack uses a generated copy of that helper with only its root resolution and Worker entry point changed; [probe-worker.ts](../../.cache/auth-cookie-evidence-2026-10-09/probe-worker.ts) delegates normal app/auth requests unchanged and adds controlled Hono endpoints. No TestD1 adapter or fabricated session cookie is involved.

A fresh Chromium context per stack signs up and verifies a synthetic account through simulated local email. Cookie values, session IDs, passwords, verification URLs and response bodies are not written to evidence. The verification page is closed before manipulation; a new script-free page makes real same-origin browser `fetch` requests in deterministic order. Browser profiles are disposable, and non-stack browser requests are blocked. This tests browser HTTP/cookie behavior, not a week-long SPA interaction or natural request-order frequency.

**Completed result: PASS, 17 recorded observations; both stacks cleaned; relevant sources unchanged.** Authoritative artifacts:

- [Sanitized results, cookie/D1 before-after snapshots, request order and cleanup](../../.cache/auth-cookie-evidence-2026-10-09/run-2026-10-09T13-51-14-127Z/results.json)
- [Sanitized execution log](../../.cache/auth-cookie-evidence-2026-10-09/run-2026-10-09T13-51-14-127Z/run.log)

Installed versions: Better Auth **1.7.7**, Hono **4.13.12**, Bun **1.3.14**, Wrangler **4.136.1**, workerd **1.20260921.1**, Chromium **153.0.8010.12**. Relevant source hashes and the unchanged-source check are in JSON. Other workers' AuthScreen work is outside this probe's scope.

## What was measured

Configured durations remain **604800 seconds (7 days)** and **86400 seconds (1 day)**, with cookie caching disabled, exactly as `worker/auth.ts` configures them. To make renewal due, only each disposable session's ISO timestamps are changed: creation/update = now − 2 days, expiry = now + 5 days. This is **time manipulation**, not elapsed usage. No application/server clock or Better Auth duration is altered. Ordinary cases leave the browser's actual seven-day cookie untouched.

| Controlled request | HTTP | Set-Cookie count | D1 and Chromium result |
| --- | ---: | ---: | --- |
| Fresh private library read, not due | 200 | 0 | Neither expiry renewed |
| Due private library read first | 200 | 0 | D1 renewed to now + 7 days; browser expiry unchanged |
| Auth get-session immediately afterward | 200 | 0 | Valid session; neither expiry renewed again |
| Re-age; auth get-session first | 200 | 1 | D1 and browser expiry both renewed |
| Private read immediately afterward | 200 | 0 | Session remains valid |
| Due private POST with malformed JSON | 400 | 0 | Authorization already renewed D1; browser unchanged |
| Due unknown private route | 404 | 0 | Authorization already renewed D1; browser unchanged |
| Official Hono example's session lookup in probe | 200 | 0 | Same D1-only renewal |
| `returnHeaders` forwarding probe, success | 200 | 1 | Both renewed |
| Forwarding probe, downstream rejection | 400 | 1 | Both renewed despite failure response |
| Forwarding probe, thrown downstream error | 500 | 1 | Both renewed through Hono error handler |
| Ordinary auth sign-out while session due, both stacks | 200 | 3 | All three are deletion cookies (`Max-Age=0`); browser token gone, subsequent library read 401 |

For example, private-first left Chromium expiry at `2026-10-16T13:51:18.229Z` while D1 moved from `2026-10-14T13:51:19.843Z` to `2026-10-16T13:51:20.825Z`. The auth-first control subsequently advanced Chromium expiry to `2026-10-16T13:51:23.139Z`. Because only D1 was aged, this run demonstrates a missed renewal rather than a two-day browser/D1 gap.

Counts refer to actual HTTP response headers received by Chromium through Bun, with cookie values removed. JSON includes cookie name/domain/path/flags and exact expiry timestamps; D1 snapshots select only expiry/creation/update fields. `hasSession`/`authenticated` JSON flags describe response-body fields, not the authentication verdict for library responses. The library's 200/401 status is the relevant access result.

**Separate browser-boundary simulation:** the script manually shortens its own browser cookie to 20 seconds, makes a private request with a due D1 session, waits 21 seconds, then checks again. Baseline: private request is 200 with no renewal header; Chromium discards the cookie; D1 remains unexpired; next private read is 401. Forwarding probe: its response restores the standard seven-day cookie; next private read is 200. **This demonstrates cookie expiry mechanics, not an observed week or production logout rate.**

Sign-out does not renew/recreate the browser session. In the baseline simulation, relogin creates a second session because the first cookie was discarded; sign-out removes the current session and leaves the older disposable D1 row. That is not session resurrection or a failed logout. No claim is made about all-device logout.

## Standard Better Auth behavior and relevance

Current official [Hono integration documentation](https://better-auth.com/docs/integrations/hono), checked 2026-10-09, mounts `auth.handler` directly for auth routes. Its optional middleware reads `auth.api.getSession` with request headers and places the returned session in context; it does not forward response cookies. The isolated Hono probe uses that same lookup and reproduces the limitation. Therefore **“our integration violates the standard Hono example” is unsupported**.

The [session-management documentation](https://better-auth.com/docs/concepts/session-management) describes renewal after `updateAge`. Installed `node_modules/better-auth/dist/api/routes/session.mjs:180–221` checks `expiresAt − expiresIn + updateAge <= now`, then updates D1 and generates a renewal cookie. `updatedAt` alone is not the threshold. Installed `dist/api/dispatch.mjs:258–270` returns only the response data unless headers/a Response are requested. A direct server function call cannot independently modify Hono's outgoing browser response. `worker/http/middleware.ts:51` discards those generated headers; `src/proxy.ts` correctly preserves cookies that actually reach it, as the auth-first control demonstrates.

The application's auth handler already precedes private middleware. `src/Root.tsx` uses the Better Auth session hook, and the client has focus/online/broadcast refresh behavior. Installed `dist/client/session-refresh.mjs:12–14` has no periodic polling by default; private work polling exists in `src/App.tsx` while jobs are active. A private request **can** win a due-renewal window; this run deliberately makes it win. An auth request can also win and renew correctly. One private-first event does not prove eventual logout: a later auth-first renewal can extend the cookie.

**Inference, not a week-long observation:** if private requests keep consuming the renewal opportunities and no auth response renews the cookie before its browser expiry, the user must authenticate again even though D1 was extended. Incidence, ordinary multi-day request ordering, real HTTPS cookie behavior and hosted Cloudflare execution remain unmeasured. This is a reason for an optional persistence improvement, not evidence of a current security or launch blocker by itself.

## Minimal integration recommendation, if desired

Follow Better Auth's documented [server API `returnHeaders` option](https://better-auth.com/docs/concepts/api): request `{ response, headers }` from the existing `getSession` call, append each `headers.getSetCookie()` value to Hono's response, and use `response` as the session. The isolated probe does exactly this before `await next()`; success and downstream 400/500 responses retain the renewal cookie. Better Auth still owns session generation, signatures, expiry, refresh decisions and revocation. No custom renewal timers, token machinery or database renewal logic are needed.

If adopted later, keep this only in the existing **private** middleware, preserve its 401-versus-503 behavior, and keep auth/sign-out routing before it. Do not wrap sign-out with a second renewing middleware. The probe is evidence for the approach, not an application patch or a complete fault/race regression suite: D1 outage and concurrent revoke/renew races were not fault-injected here. The user requested evidence first; no fix was applied.

## Run accounting

Two failed development runs are retained under the same ignored evidence directory: `13-48-15-136Z` stopped on a harness date-conversion assertion (ISO text versus number); `13-49-15-300Z` stopped when a callback-loaded SPA allowed background auth renewal before the intended official-example probe. Both cleaned their processes/state. Neither is presented as the completed reproduction. The final runner preserves ISO storage and explicitly isolates/records request order.

Cleanup is part of the completed run's evidence: both owned stacks stopped, no owned listening ports remained, temporary D1/R2/mail/env files were removed, and relevant source hashes were unchanged. The live demo on **3100/8800** and `.wrangler/demo-review-2026-10-09` were never used.
