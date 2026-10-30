---
name: verify-linklog
description: Launch an isolated Linklog instance (web UI + Worker on local D1/R2/Queue/Workflow, fixture external services, two verified accounts) and drive it in Chromium with Playwright to prove a change works, with screenshots, ARIA snapshots, API state and video as evidence. Use when you need to show that a Linklog web UI or API change behaves correctly for a user, reproduce a bug in the running app, or check a feature end to end. Not for the Chrome extension (use `bun run test:browser`) or for real third-party sites (see "Outside this harness").
---

# Verify Linklog

Linklog is a personal link library: a React UI (Bun server on the UI port, proxying `/api/*`) and a Cloudflare Worker (Hono + Better Auth) on local D1, R2, Queues and Workflows. This skill starts a disposable copy of it and drives the web UI the way a user does.

The instance runs the QA Worker from `qa/video/worker-entry.ts`. It is the product Worker with fakes at its external edges. DNS, preview fetches, Browser Rendering Markdown and Jev answer from the fixture catalog in `qa/video/fixtures.ts`, and every other outbound fetch is refused. A run therefore costs nothing and cannot reach a real site. Use a fixture URL whenever a journey saves a link. Any other host is treated as unreachable.

All commands run from the repo root. `V` below stands for `bun .agents/skills/verify-linklog/scripts/verify.ts`.

## Launch

```sh
bun install --frozen-lockfile        # once per checkout; a stale node_modules fails with "Could not resolve "hono""
V up                                 # returns when the instance is usable (about 5 s)
V up --fast-retries                  # Workflow retry backoffs become 1 s (attempt counts and timeouts unchanged)
V up --var BROWSER_CONCURRENCY=1     # extra Worker vars; repeat --var as needed
V up --ui-port 3500 --api-port 9200  # explicit ports (default: first free pair from 3400/9100, step 10)
```

`up` starts a detached `serve` process that owns the stack, and prints:

```
READY http://127.0.0.1:3400
run: .cache/verify-linklog/<run>
accounts: demo-a@linklog.test, demo-b@linklog.test
```

Ready means usable. Migrations are applied to an empty D1, both accounts went through real sign-up, the emailed verification link and sign-in, and `GET /api/library` answers 200 with Demo A's session. The run directory holds `session.json` (ports, pid, session cookies, passwords), `state/` (D1/R2), `logs/` (`dev.log`, `dev.err.log`, `verify.log`) and `evidence/`. `.cache/verify-linklog/current` points at the newest run; pass `--run <dir>` to any command to target another.

Accounts: `demo-a@linklog.test` / `linklog-demo-a-password` (the default page and API) and `demo-b@linklog.test` / `linklog-demo-b-password`.

The UI is bundled from `src/` and the Worker from `worker/` when the instance starts, without hot reload. After you edit code, run `V down` and then `V up`. `doctor` and `run` refuse a stale instance.

## Doctor

```sh
V doctor
```

This check only reads. Run it first, and again whenever something looks off. It exits 1 if any line fails:

- `session`: the run's `session.json` exists.
- `process`: the `serve` pid is alive.
- `ports`: the UI and API listeners belong to this run's process group, not to someone else's dev server.
- `qa worker`: `/api/__qa/health` answers `qa: true`, so the Worker has fixture edges and is not the paid product Worker.
- `auth`: an anonymous `/api/library` gets 401 and Demo A gets 200.
- `code`: no file under `src/`, `worker/`, `migrations/`, `qa/video/` or `scripts/` changed after launch.

## Drive

A journey is a TypeScript file that default-exports an async function. `V run <file>` opens Chromium already signed in as Demo A, calls the function, records the result, and exits 1 on any failed check.

```sh
V run .agents/skills/verify-linklog/journeys/add-link.ts            # proven reference journey
V run .agents/skills/verify-linklog/journeys/add-link.ts --headed   # watch it
```

Write a new journey next to `add-link.ts` and copy its shape. The context it receives (types in `scripts/journey.ts`):

| Field | Use |
|---|---|
| `page` | Playwright page signed in as Demo A, already on the library |
| `api.get(path)`, `api.send(method, path, body)`, `api.ensure(path, body)`, `api.library()`, `api.link(url)` | Worker API as Demo A, through the UI proxy. Paths omit `/api`. Writes send JSON and a trusted `Origin` |
| `pageAs(1)`, `apiAs(1)` | Demo B, in its own browser context, for isolation checks |
| `fixture(name, path)` | A fixture URL unique to this journey run, such as `https://article.qa.example/add-link-032946/one`. Reruns never dedupe into older links |
| `step(text)` | Starts a step. Its millisecond offset into `video.webm` goes in the report |
| `check(name, fn, { timeout })` | Polls `fn` until it returns something truthy and returns that value. The default timeout is 15 s. A failure stops the journey and saves `failed.png` |
| `shot(name)`, `aria(name)`, `note(name, data)` | Save a screenshot, an ARIA snapshot or JSON to the evidence directory |

Driving rules:

- Locate by role and accessible name, such as `getByRole("button", { name: "Add link" })`, `getByRole("dialog", { name: "Add link" })` or `getByRole("tab", { name: "Content" })`. Use visible text only for link titles. Never use CSS classes or coordinates.
- Make every claim a `check`, and assert both the UI and the API. The UI polls the library, so it can trail the API by a second or two. Check the API first, then check the UI with a polling `check`.
- Extraction is asynchronous. Wait for `!link.processing` plus the end state you expect (`status`, `content_state`, `attention_kind`), not for a fixed delay.
- Pick fixtures by behavior. `README.md` in `qa/video/` has the catalog, and `about` on each entry in `qa/video/fixtures.ts` says what it does. Examples: `article` (preview and content right away), `gone` (404), `down` (503 every time), `flaky` (503 once, then OK), `login-wall`, `pdf`, `blocked`, `nowhere` (DNS miss) and `article-yes` (content with a `jev:yes` marker, so fixture Jev applies tags).

The feature map in `features/README.md` lists every user-facing feature with its entry points, handles and end states. Read the feature's file before you write its journey.

## Evidence

Each `run` writes to `.cache/verify-linklog/<run>/evidence/<journey>-<time>/`:

- `report.json`: status, steps with video offsets, every check with its duration and error, and the artifact list.
- `video.webm`: the whole session, including the action and the state that followed. Another account's page is saved as `video-<n>.webm`.
- `*.png`, `*.aria.yml` and `*.json` from `shot`, `aria` and `note`, plus `failed.png` on failure.

Proof standards:

- Drive the real user path: the dialog, the keyboard shortcut or the paste. A test-only route or a direct API write proves nothing about the UI. Use `api` for setup the feature under test doesn't own, and for reading state back.
- Capture the action and the state it produced, not only the final screen. Confirm a mutation from a second view, such as a reload or the API, as `add-link.ts` does.
- Check side effects alongside the visible UI: stored content (`GET /links/:id/content`), jobs (`GET /batches/:id`), tags and scores (`api.library()`).
- Fixtures replace only the external systems: DNS, sites, Browser Rendering and Jev. D1, R2, Queues, Workflows, auth and email run for real on the local runtime.
- When you report, give the evidence path, the PASS/FAIL line, and the features or entry points you did not cover.

## Cleanup

```sh
V down                 # or: V down --run .cache/verify-linklog/<run>
```

`down` sends SIGTERM to `serve`, which stops `scripts/dev.ts`, Wrangler, workerd and the UI server. It then stops whatever is left in the run's process group, sending SIGTERM and then SIGKILL after 5 s. It never kills processes by name or touches other listeners. It then deletes `session.json`, `state/`, the generated Wrangler config and `.wrangler/`, which hold live session tokens and sign-in links. It keeps `evidence/` and `logs/`. Run `down` after every attempt, including failed ones. A failed `up` already cleans up its own processes and leaves `logs/` for diagnosis.

## Isolation

Each `up` uses its own ports, its own D1/R2 under the run directory, and its own process group. Several instances can therefore run side by side, and none of them touches `.wrangler/state`, `bun run dev` (3000/8787), `bun run demo` (3100/8800), the QA video harness (3300/8990) or browser tests (3010/8790). Don't drive an instance whose `doctor` fails, and don't drive one you didn't start.

## Outside this harness

- **Chrome extension (Browser view):** the extension surface has its own real-Chromium harness, `bun run test:browser` (`tests/browser/`). It covers isolated ports and profiles and the fixture Jev provider.
- **Real sites, YouTube, social posts and Workers AI OCR:** these adapters are not fixtured, so their hosts read as unreachable here. `bun run demo` runs the product Worker on 3100/8800 with real DNS and preview fetches but local-only bindings. `bun run demo:connected` adds real Browser Rendering and AI, which needs `wrangler login` and may cost money. Neither has a doctor or evidence capture, so say which one you used when you report.
- **Narrated QA videos:** `bun qa/video/run.ts` (see `qa/video/README.md`).
