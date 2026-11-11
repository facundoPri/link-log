// batch-jobs-shared (FAC-183): with Activity open and an active batch expanded, the batch's jobs are
// requested once per poll interval (the sidebar's per-link "running" label and the sheet share one
// request), the row label still shows the running job, and cancelling a job or the batch updates the
// sheet and the library without a reload. Launch with `V up --var BROWSER_CONCURRENCY=1` so the pool
// links stay queued.
import type { Journey } from "../scripts/journey";

const POLL_MS = 1800;
const WINDOW_MS = 8000;

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  const origin = new URL(page.url()).origin;
  const urls = [fixture("pool", "1"), fixture("pool", "2"), fixture("pool", "3")];

  await step("Set up: an API key submits three slow links, so one extract batch stays active");
  const name = `Batch jobs ${Date.now() % 100000}`;
  const { key } = await api.send("POST", "/auth/api-key/create", { name });
  const res = await fetch(`${origin}/api/v1/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls }),
  });
  const { batchId } = await res.json();
  await check("API: the batch is accepted and active", async () => (await api.library()).batches.find((b: { id: string }) => b.id === batchId)?.active > 0);

  await step("The list labels the running links while the batch runs");
  await page.reload();
  await check("The list shows the In progress label", async () => (await page.getByText(/^In progress…$/).count()) > 0);
  await shot("01-running-labels");

  await step("Open Activity and expand the batch, counting GET /api/batches/:id");
  const requests: number[] = [];
  const start = Date.now();
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/api/batches/${batchId}`) requests.push(Date.now() - start);
  });
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await sheet.getByText(`Extract context · API · ${name}`, { exact: true }).click();
  await check("The sheet lists the batch's jobs", async () => (await sheet.getByRole("button", { name: "Cancel", exact: true }).count()) > 0);
  const opened = requests.length;
  await page.waitForTimeout(WINDOW_MS);
  const polls = requests.length - opened;
  await note("02-batch-requests", { opened, polls, windowMs: WINDOW_MS, atMs: requests });
  const expected = Math.ceil(WINDOW_MS / POLL_MS);
  await check(`One request per poll interval: at most ${expected + 1} in ${WINDOW_MS} ms, saw ${polls}`, () => polls >= 2 && polls <= expected + 1);

  await step("Cancel one job from the sheet");
  const jobs = sheet.getByRole("button", { name: "Cancel", exact: true });
  const before = await jobs.count();
  await jobs.last().click();
  await check("Sheet: the job shows Cancelled right away", () => sheet.getByText("Cancelled", { exact: true }).first().isVisible(), { timeout: 3000 });
  await check("API: the batch counts a cancelled job", async () => (await api.library()).batches.find((b: { id: string }) => b.id === batchId)?.cancelled > 0);
  await check("Sheet: one fewer Cancel button", async () => (await jobs.count()) < before, { timeout: 3000 });
  await shot("03-job-cancelled");

  await step("Cancel the batch from the sheet");
  await sheet.getByRole("button", { name: "Cancel batch" }).click();
  await check("API: no active jobs left", async () => (await api.library()).batches.find((b: { id: string }) => b.id === batchId)?.active === 0, { timeout: 30_000 });
  await check("Sheet: no Cancel batch button", async () => (await sheet.getByRole("button", { name: "Cancel batch" }).count()) === 0, { timeout: 5000 });
  await check("Sheet: no job offers Cancel", async () => (await jobs.count()) === 0, { timeout: 5000 });
  await check("List: no running label is left", async () => (await page.getByText(/^(Queued…|Extracting…|Fetching preview…)$/).count()) === 0, { timeout: 5000 });
  await shot("04-batch-cancelled");
}) satisfies Journey;
