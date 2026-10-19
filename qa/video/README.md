> Current integration: run `--chapter integration` with a fresh `QA_OUT` directory. The harness now creates verified local A/B accounts and authenticates API/browser requests. Earlier chapters document the historical pre-auth contract (including the removed Settings switch); their old pass counts do not apply to the integration.

# QA video harness

Records QA scenarios against the real Linklog UI and Worker. Each scenario becomes a narrated clip: an animated cursor, a caption bar with the scenario ID, the current step and its expected result, and a chip for every check. The clips are composed into MP4s with title cards. The run is deterministic and makes no paid calls: every external edge (DNS, preview fetches, Browser Rendering, Jev) is answered by a fixture.

```
qa/video/
  run.ts            CLI: record scenarios, then compose
  recorder.ts       scenario() / chapter() API, Playwright recording, assertions, manifest entries
  overlay.ts        in-page caption bar, cursor, click ripple, chips (injected with addInitScript)
  compose.ts        title cards (HTML → PNG via Chromium) + clips → MP4s (ffmpeg)
  manifest.ts       qa/out/manifest.json
  env.ts            starts the isolated stack (scripts/dev.ts) on the QA ports with the QA Worker
  worker-entry.ts   QA-only Worker: the product Worker plus fake edges (no product code changed)
  wrangler.qa.jsonc QA Worker config (no remote bindings)
  fixtures.ts       fixture catalog, shared by the Worker and the scenarios
  chapters/*.ts     one chapter per file (default export)
qa/out/             generated output, gitignored: clips/, segments/, cards/, videos/, shots/, logs/, manifest.json
```

Requirements: `bun`, `ffmpeg` and `ffprobe` on PATH (no `drawtext` filter needed), and a Chromium for playwright-core. By default it uses Playwright's cached Chromium (`bunx playwright-core install chromium`); set `CHROME_PATH` to use another one.

## Run

```sh
bun qa/video/run.ts --list                    # chapters and scenarios
bun qa/video/run.ts --scenario P2             # one scenario (comma-separate several), then compose
bun qa/video/run.ts --chapter pilot           # one chapter, then compose
bun qa/video/run.ts                           # current authenticated integration chapter
bun qa/video/run.ts --chapter pilot --no-compose
bun qa/video/compose.ts                       # compose from the manifest only (no recording)
HEADED=1 bun qa/video/run.ts --scenario P1    # watch it run
```

Environment variables: `QA_UI_PORT` (default 3300), `QA_API_PORT` (default 8990), and `LINKLOG_PERSIST_TO`, the root for the D1/R2 state. The harness uses `<root>/qa-video`, which it wipes on each start, so every run starts with an empty library. Without that variable the root is the OS temp dir. `QA_PR` sets the PR line on the cards. The run exits with code 1 if any scenario failed.

Outputs:
- `qa/out/videos/chapter-<id>.mp4`: chapter intro card, then a title card and clip for each scenario, then an outro with pass/fail for each scenario.
- `qa/out/videos/full.mp4`: overall intro, then every chapter in the manifest, then the overall outro.
- `qa/out/segments/<ID>.mp4`: one scenario's title card plus its clip, for attaching a single scenario.
- `qa/out/manifest.json`: per scenario, the chapter, status, assertions (name/ok/ms/error), step timeline, clip and segment paths, and the failure screenshot.

Between scenarios the runner empties the library: it cancels leftover jobs and deletes every link. Each clip therefore starts clean.

## Write a scenario

Add it to a chapter file in `chapters/` (or create one, with a default export):

```ts
import { chapter, scenario } from "../recorder";

export default chapter({
  id: "attention",                         // used in --chapter and in file names
  title: "Needs attention",                // intro / outro cards
  ticket: "FAC-48",
  summary: ["What the viewer will see, one line each"],
  env: { fastRetries: true },              // optional, see "Environment options"
  scenarios: [
    scenario("A3", "A transient 503 recovers on retry", {
      ticket: "FAC-48",
      covers: "Transient reasons are retried; recovery never enters Needs attention",
      expected: "The preview fails once with 503, the retry succeeds, and the link ends ready",
    }, async ({ page, step, click, type, paste, expect, api, hold, fixture }) => {
      const url = fixture("flaky", "one");              // https://flaky.qa.example/a3/one
      await step("Add a link whose site answers 503 once", "It is retried, not failed");
      await click(page.getByRole("button", { name: "Add link" }));
      await type(page.getByRole("textbox"), url);
      await click(page.getByRole("button", { name: /^Save/ }));
      await expect("API: link ready, no attention", async () => {
        const l = await api.link(url);
        return l && !l.processing && l.status === "ready" && l.attention_kind === null;
      }, { timeout: 30_000 });
      await expect.visible(page.getByText("Recovered article a3/one"));
    }),
  ],
});
```

The scenario gets these helpers:
- `step(caption, expected?)` starts a step. It updates the caption bar and, when given, the expected-result panel.
- `click(target)`, `type(target, text)` and `paste(target, text)` glide the cursor to the target with easing, show a ripple, then act. `paste` fills the field at once, for long text. A string target is a Playwright selector; a `Locator` is used as is.
- `expect(name, check, { timeout })` polls `check` until it returns something truthy.
- `expect.visible(target | text, name?)` waits for the target to appear. `expect.hidden(target | text, name?)` waits for it to be gone.
- `expect.holds(name, ms, check)` requires `check` to stay truthy for the whole window. It fails at the first violation and shows a countdown chip.
- `api` calls the Worker: `get`, `send(method, path, body)`, `library()`, `link(url)`, and `jobs(url)` (the link's jobs with their `kind`).
- `hold(ms, label)` waits with a countdown chip.
- `fixture(name, path)` returns a fixture URL unique to this scenario (see below).

Assertion rules: assertions are mandatory. A scenario passes only if it made at least one assertion and every assertion passed. The first failing assertion turns the bar red and shows the error. It then takes a screenshot (`qa/out/shots/<ID>-failed.png`), stops the scenario, and marks the clip FAILED in the manifest and on the cards. Any other error, such as a missing click target, also fails the scenario. Every claim a caption makes should have an `expect` that checks it, in the UI, the API, or both.

## Fixtures

`fixtures.ts` declares each fixture host under `qa.example`. Any path on a host behaves the same way, so `fixture("pool", "article-1")` and `fixture("pool", "article-2")` are two distinct links with the same behaviour. `{path}` in titles and Markdown is replaced by the request path. The QA Worker serves three things from that catalog:

| Edge | What the product calls | What the QA Worker does |
|---|---|---|
| DNS | `validateDestination` → DoH `cloudflare-dns.com/dns-query` | Fixture hosts resolve to a public IP (`93.184.215.14`), or to nothing with `dns: "nxdomain"`. **Any other host resolves to nothing**, so it reads as "could not be reached". |
| Preview | `extractMetadata` → `fetch(url)` | Serves the fixture's `preview`: `html` (title/description, optional `delayMs`), `pdf`, `status` (any code, extra headers such as `cf-mitigated`), or `flaky` (fails N times, then behaves like `then`). Delays honour the product's abort signal. |
| Markdown | `env.BROWSER.quickAction("markdown" \| "content")` | A fake binding answers the fixture's `browser`: `markdown` (text, `delayMs`, `browserMs`), `error` (HTTP status plus `{code, message}` envelope), `flaky`, or `hang`. |
| Jev | fixture provider, or TypeSafe `api.typesafe.ai` | `jev: "fixture"` (default) uses the product's fixture Jev; markers in the content steer it (`jev:yes`, `jev:fail`, `jev:slow=<ms>`… see `worker/ai/fixture.ts`). `jev: "fake-typesafe"` runs the real TypeSafe code path against a local fake: a `qa:jev-http=<status>` marker in the content answers that status (401, 402 → `account`; 5xx → `provider_error`), and anything else gets the fixture answers. |

Every other outbound `fetch` is refused (logged as `qa_blocked_fetch`). Neither Browser Rendering nor Workers AI is bound. A run therefore cannot reach a real site or a paid API, even by mistake. `QA_ALLOW_NET=1` in the Worker vars lifts the fetch block for non-fixture hosts; nothing uses it.

Retry counters for `flaky` are stored per full URL in the run's R2, under `qa/counters/`. Give each scenario its own path, which `fixture()` already does.

To add a fixture, add an entry to `FIXTURES` with an `about` line. The Worker picks it up on the next start.

Current catalog: `pool`, `article`, `pdf`, `gone`, `flaky`, `down`, `slow`, `blocked`, `nowhere`, `login-wall`, `render-timeout`, `browser-auth`, `browser-flaky`, `browser-empty`, `browser-hang`, `jev-401`, `jev-402`, `jev-500`. The `about` field of each entry describes it.

## Environment options (per chapter)

- `jev: "fixture" | "fake-typesafe"`: see the Jev row above.
- `fastRetries: true`: the QA Workflow wrapper rewrites every `step.do` retry config to a 1 s constant backoff. Product timing is preview 5 s → 10 s and content 10 s. The number of attempts, the timeouts and the attempt budgets are unchanged. Only QA config changes; product code does not.
- `vars: { BROWSER_CONCURRENCY: "1", … }`: extra Worker vars.
- Per scenario: `scenario(id, title, { env, keepState }, fn)`. `env` overrides the chapter's options for that scenario only, and the runner restarts the stack when the options change. With `keepState: true` the runner skips the library reset and the restart keeps D1/R2, like the plan's "restart the same persist dir under another profile" (chapter 5: configured → no key → bad key → configured). Run such a chain as a whole chapter; a lone `--scenario` of a `keepState` scenario has nothing to continue from.
- Jev profiles with the fake TypeSafe: no key is `{ jev: "fake-typesafe", vars: { TYPESAFE_API_KEY: "" } }`; a wrong key is `vars: { TYPESAFE_API_KEY: "qa-fake-invalid" }`, which the fake answers with 401 for every call. Each fake call logs `{"event":"qa_fake_typesafe","status":…}`.

Chapters with the same options share one environment. A different set of options restarts the stack, which takes about 10 s.

## Known limits

- Timing is real time. Pool waits, the 10 s preview fetch timeout, the 20 s and 100 s attempt budgets, and the 2 s slot polling all play at full length. Only retry backoffs can be shortened (`fastRetries`). The `browser-hang` fixture alone takes more than 200 s.
- The Workflow engine is wrangler's local one, not production. No fixture forces an engine-level step timeout or eviction, so the "attempt ended by the engine" path is not filmed.
- Usage still lists `cloudflare/browser-markdown` rows for fake Browser calls (the product meters the call). These are labels only; nothing left the machine.
- Social and YouTube adapters are not fixtured. Their hosts are not fixture hosts, so they resolve to nothing and read as unreachable. Fixtures cover the web adapter path, which is what FAC-48 changes.
- The fake Browser binding implements only `quickAction`.
- The UI polls the library, so it can lag the API by a second or two. Assert the UI with `expect.visible` / `expect.hidden`, which wait, rather than right after an API check.
- The caption bar takes the bottom 84 px. The app is shrunk by that height so nothing is hidden. Dialogs are centered in the full viewport.
- Cron recovery runs every 30 s, as in `bun run dev`.
- `qa/out/logs/dev.log` holds the current stack's output only; each start moves the previous one to `dev.prev.log` (and `dev.prev.err.log`). Wrangler colours `console.error` lines, so strip ANSI codes before parsing JSON log lines.
