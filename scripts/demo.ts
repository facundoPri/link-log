// Isolated A/B demo: its own state dir and ports, local-only bindings by default (no Browser
// Rendering/AI calls, no Cloudflare login), fixtures seeded through the real auth flow.
//   bun run demo   ->  http://127.0.0.1:3100  (API 127.0.0.1:8800, state .wrangler/demo-state)
// Override with LINKLOG_UI_PORT / LINKLOG_API_PORT / LINKLOG_PERSIST_TO; LINKLOG_WRANGLER_LOCAL=0
// enables the remote AI/Browser bindings (may incur cost).
// `bun run demo:connected` selects that mode explicitly; D1/R2/accounts stay local.
process.env.LINKLOG_UI_PORT ||= "3100";
process.env.LINKLOG_API_PORT ||= "8800";
process.env.LINKLOG_PERSIST_TO ||= ".wrangler/demo-state";
process.env.LINKLOG_WRANGLER_LOCAL ||= "1";

const { runStack, origin, stateDir } = await import("./dev");
const { apiUrl } = await import("./ports");
const { FIXTURES, seedFixtures, assertDisposableTarget } = await import("./seed-dev-users");
assertDisposableTarget(apiUrl(), stateDir);
console.log(process.env.LINKLOG_WRANGLER_LOCAL === "1"
  ? "Local-only demo: automatic page extraction and Cloudflare AI are unavailable. Use bun run demo:connected for real Browser Run/AI; auth email is still simulated."
  : "Connected demo: Browser Run/AI use Cloudflare (may incur usage charges). Accounts, D1/R2 and auth email stay local.");
await runStack({
  afterApi: () => seedFixtures(apiUrl(), origin, stateDir),
  uiEnv: { BUN_PUBLIC_LINKLOG_DEV_FIXTURES: JSON.stringify(FIXTURES) },
});
