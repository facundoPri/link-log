# Needs attention and Activity

When a link's preview or content fails for good (after its retries), the link is flagged and listed under Needs attention with a plain reason. From there the user can Retry only the failed step, use the preview's metadata as content, or Dismiss the flag. Transient failures that recover, cancelled jobs, and failed re-extractions that keep earlier content are never flagged. The Activity sheet shows batches and jobs in progress, the current step and attempt, and lets the user cancel a batch or a single job.

## Sub-features

- `attention-flag` flags permanent preview failures (404, PDF, blocked, unreachable) and content failures (login wall, empty) with a reason.
- `attention-recover` keeps a transient failure that recovers on retry (`flaky`) out of the list.
- `attention-retry` reruns only the failed step and clears the flag on success.
- `attention-use-preview` stores the preview's title and description as content.
- `attention-dismiss` removes the flag without changing anything else.
- `activity-progress` shows batches, the current step and attempts in the `Activity` sheet.
- `activity-cancel` cancels a batch (`Cancel batch`) or one job. The job ends Cancelled and no flag is set.

## How to get to it (user POV)

- The sidebar `Needs attention` button with its count. It only appears while at least one link is flagged.
- A flagged row's inline `Retry`, `Use preview` (when metadata is usable) and `Dismiss` buttons.
- A row's `Link actions` menu, which offers retry and extract.
- The sidebar footer `Activity` button. While a batch runs, it shows the batch label instead.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`. Launch with `V up --fast-retries` so transient failures settle in seconds. Product timing otherwise takes up to a minute.
- Fixtures: `gone` (404), `down` (503 every time), `flaky` (503 once, then OK), `login-wall` (the content is a login page), `pdf` (not HTML) and `nowhere` (DNS miss).

- **Flag.** Save `fixture("gone", "x")` through the dialog. Wait until `api.link(url)` has `!processing` and `attention_kind === "preview"`. The sidebar shows `Needs attention 1`, and the row shows a reason with `Retry` and `Dismiss`.
- **Recover.** Save `fixture("flaky", "x")`. It ends with `status === "ready"` and `attention_kind === null`, and it never appears under `Needs attention`. Use `check` until settled, then assert the flag is absent.
- **Content failure.** Save `fixture("login-wall", "x")`. Content never stores the login text, and `api.get(\`/links/${id}/content\`)` does not contain `Password`. The row shows that metadata is available as content (`Metadata available as content`), or it is flagged `content`.
- **Retry.** On a flagged row, click `Retry`. Only the failed step reruns, and the row stays listed until that step succeeds. A `down` link stays flagged after the retry.
- **Use preview.** On a content-flagged row with usable metadata, click `Use preview`. `content_source === "preview"` and the flag clears.
- **Dismiss.** Click `Dismiss`. `attention_kind === null`, while `content_state` or `status` keep their failed values. The `Needs attention` count drops.
- **Activity.** Click `Activity`. The sheet titled `Activity` lists the batch with each job's step, such as `Waiting for Browser slot`. Use `page.locator("button button").count() === 0` to confirm the markup is valid.
- **Cancel.** With `fixture("pool", …)` links queued behind the Browser pool (launch with `--var BROWSER_CONCURRENCY=1`), click `Cancel batch`. The cancelled jobs show `Cancelled`, and no cancelled link gains content or a flag. Use `check` repeatedly over a window of about 15 s.
- **Proof.** Save a `shot` of the Needs attention view and a `note` of the flagged links' `attention_kind`, `attention_reason` and `content_state`. The video shows each Retry and Dismiss with its result.

## Gotchas

- Without `--fast-retries`, `down` and `slow` take the full product backoff before they flag. Size `check` timeouts to the mode, about 60 s without the flag.
- `browser-hang` alone takes more than 200 s, because of the attempt budget of 100 s × 2. Avoid it unless that path is the point.
- `Needs attention` is absent from the sidebar while the count is 0. Assert its absence, not a zero count.
- A failed re-extract of a link that already has content keeps the content and only shows in Activity. Don't expect a flag.
- Cron recovery runs every 30 s, as in `bun run dev`. A job interrupted by a restart resumes on that tick.
- `qa/video/chapters/integration.ts` holds working Playwright code for fallback, retry, skip and cancel. Copy its locators.
