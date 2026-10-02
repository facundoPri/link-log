// Isolated A/B demo: its own state dir and ports, local-only bindings by default (no Browser
// Rendering/AI calls, no Cloudflare login), fixtures seeded through the real auth flow.
//   bun run demo   ->  http://localhost:3100  (API 127.0.0.1:8800, state .wrangler/demo-state)
// Override with LINKLOG_UI_PORT / LINKLOG_API_PORT / LINKLOG_STATE_DIR; LINKLOG_WRANGLER_LOCAL=0
// enables the remote AI/Browser bindings (may incur cost).
process.env.LINKLOG_UI_PORT ||= "3100";
process.env.LINKLOG_API_PORT ||= "8800";
process.env.LINKLOG_STATE_DIR ||= ".wrangler/demo-state";
process.env.LINKLOG_WRANGLER_LOCAL ||= "1";

const { runStack, apiUrl, origin, stateDir } = await import("./dev");
const { FIXTURES, seedFixtures, assertDisposableTarget } = await import("./seed-dev-users");
assertDisposableTarget(apiUrl, stateDir);
await runStack({
  afterApi: () => seedFixtures(apiUrl, origin, stateDir),
  uiEnv: { BUN_PUBLIC_LINKLOG_DEV_FIXTURES: JSON.stringify(FIXTURES) },
});
