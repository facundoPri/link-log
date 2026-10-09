# Local demo Browser Run failure — 2026-10-09

The reported `The RPC receiver does not implement the method "quickAction".` comes from the local Browser simulator, not authentication or the demo identity. `bun run demo` sets `LINKLOG_WRANGLER_LOCAL=1`, and `scripts/dev.ts` passes `--local`; this overrides `remote: true` on the Browser binding. Cloudflare documents that Quick Actions are not supported in local mode: [Quick Actions](https://developers.cloudflare.com/browser-run/quick-actions/), [Wrangler reference](https://developers.cloudflare.com/browser-run/reference/wrangler/).

## Minimal actual-service comparison

Same temporary Worker, compatibility date 2026-09-21, Browser binding `remote: true`, same URL `https://gpui-kit.com/base`, Wrangler 4.136.1. Only `--local` changed. Worker source/config retained in ignored `.cache/browser-rpc-evidence-2026-10-09/`.

- `wrangler dev ... --local`: HTTP 502, exact reported RPC error.
- `wrangler dev ...` with the configured remote binding: Browser Run HTTP 200, `success: true`, 9,089 Markdown characters, GPUI text present.

The probe had no DB, R2, auth, email or app user data. It ran on port 8897 and was stopped after both observations. This proves the binding-mode cause; it does not by itself prove the whole application's extraction/job persistence path.

## Change

`bun run demo:connected` explicitly enables real Browser Run/AI calls while retaining local accounts/D1/R2 and simulated email. Both modes print their capabilities at startup; the offline default remains available without cloud charges. The launcher sends a local-only services flag to the Worker. Offline Quick Actions now fail before the unsupported RPC and before recording a nonexistent cloud call, with a message offering manual text or the connected demo; the library no longer advertises Markdown extraction in that mode. The flag is effective only for local/test environments.

Focused validation: 29 tests passed, 93 assertions, covering the unavailable RPC boundary, deployed/connected capability controls, existing social parsing and fixture isolation. Typecheck passed for app/protocol/extension. No changes to Better Auth renewal or extension cleaning were made.

The user's Orca demo is restarted with `LINKLOG_PERSIST_TO=.wrangler/demo-review-2026-10-09 bun run demo:connected`, preserving the state directory and local auth secret. Historical failed jobs are retained; they are not silently removed or re-executed. A new Retry uses the connected service.

## Full application recheck

After restart, a separate Ego browser task space used the real Demo A form, opened the user's existing GPUI Base link, and clicked its Content → Retry once. The inspector subsequently rendered GPUI Markdown, exposed Preview/Markdown and Re-extract controls, and no longer displayed the RPC error. This verifies the actual UI → authenticated API → local Queue/Workflow → remote Browser Run → local R2 → inspector path. The two historical `example.com` fixture failures were not changed. This is connected local evidence, not a hosted preview or email-delivery test.
