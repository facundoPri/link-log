# Authentication boundary evidence — 2026-10-09

The current Hono app registers 30 application routes behind `sameOriginWrites`, `requireSession`, and `writeQuotaAndBody`. All 268 assertions passed at 13:52 UTC.

| Check | Environment | Passed |
| --- | --- | ---: |
| All 30 routes without a cookie, with an invalid cookie, an expired session, or a revoked session | Hono + real Better Auth, TestD1 | 120 |
| Library, usage and Browser catalog with a valid session | Same harness | 3 |
| All 24 write routes with a valid session but a foreign Origin | Same harness | 24 |
| Rejected requests produce no queue messages, R2 objects or email | Same harness | 1 |
| All 30 routes without a cookie or with an invalid cookie, both through the UI proxy and directly against workerd | Real HTTP, Bun + workerd + local D1 | 120 |

The real HTTP checks use nonexistent audit IDs and no valid user cookie. They do not read or modify the user's demo records. Public exceptions are the SPA/static assets and Better Auth's sign-in/sign-up/recovery endpoints. Wrangler's local scheduled endpoint is development tooling, not a deployed application route.

Reproduction: `bun --preload ./tests/setup.ts .cache/auth-route-evidence-2026-10-09/check.ts` while the demo listens on UI3100/API8800. Full route inventory and per-case results: `.cache/auth-route-evidence-2026-10-09/results.json`. The harness closes TestD1 after asynchronous auth initialization has settled; the final run emitted no schema warnings.

This establishes the authentication boundary for the registered routes. It is not exhaustive ownership, concurrency or production validation. Expired/revoked/origin cases used TestD1; HTTP cases used local D1. Background tasks are not browser endpoints and require their own persisted-owner checks.
