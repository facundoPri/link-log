// api-submit-live-activity (FAC-182): with the page idle and never reloaded, a batch submitted through
// the public API appears when Activity is reopened, its progress stays live, and once the work settles the
// page stops polling GET /api/library. api-submit-activity.ts reloads first, so it can't catch this.
import type { Page } from "playwright-core";
import type { Journey } from "../scripts/journey";

const libraryGets = (page: Page) => {
  const seen: number[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/api/library") seen.push(Date.now());
  });
  return { since: (t: number) => seen.filter((s) => s >= t).length };
};

export default (async ({ page, api, fixture, step, check, shot, aria, note }) => {
  const name = `Live ${Date.now() % 100000}`;
  const origin = new URL(page.url()).origin;
  const urls = [fixture("article", "1"), fixture("article", "2")];
  const gets = libraryGets(page);
  const { key } = await api.send("POST", "/auth/api-key/create", { name });

  await step("The page is idle: no batch is active, so it doesn't poll the library");
  await check("API: no link is processing and no batch is active", async () => {
    const lib = await api.library();
    return !lib.links.some((l: { processing: boolean }) => l.processing) && !lib.batches.some((b: { active: number }) => b.active > 0);
  }, { timeout: 60_000 });
  const idleFrom = Date.now();
  await page.waitForTimeout(5000);
  await check("No GET /api/library in 5 s while idle", () => gets.since(idleFrom) === 0);

  await step("Open Activity, then close it");
  const activity = page.getByRole("button", { name: /^(Activity|Extracting)/ });
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const label = `Extract context · API · ${name}`;
  await activity.click();
  await check("Activity opens", () => sheet.isVisible());
  await check(`Activity has no "${label}" yet`, async () => (await sheet.getByText(label, { exact: true }).count()) === 0);
  await page.keyboard.press("Escape");
  await check("Activity closes", async () => !(await sheet.isVisible()));

  await step("An integration submits two URLs with the API key");
  const res = await fetch(`${origin}/api/v1/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls }),
  });
  const accepted = await res.json();
  await check("API: 202 with a batchId", () => res.status === 202 && accepted.batchId);
  await note("01-submit", { status: res.status, body: accepted });

  await step("Reopen Activity without reloading: it lists the API batch");
  await activity.click();
  await check(`Activity shows "${label}" without a reload`, () => sheet.getByText(label, { exact: true }).isVisible());
  await page.waitForTimeout(600);
  await shot("02-activity-reopened");
  await aria("02-activity-reopened");

  await step("The batch finishes while Activity is open");
  await check("API: the batch has no active jobs", async () => {
    const b = (await api.library()).batches.find((x: { id: string }) => x.id === accepted.batchId);
    return b && b.active === 0;
  }, { timeout: 60_000 });
  const row = sheet.getByRole("button", { name: label }).locator("..");
  await check("Activity marks the batch Done without a reload", () => row.getByText("Done", { exact: true }).isVisible(), { timeout: 10_000 });
  await shot("03-activity-done");

  await step("Nothing is in flight: polling stops");
  await check("API: no link is processing and no batch is active", async () => {
    const lib = await api.library();
    return !lib.links.some((l: { processing: boolean }) => l.processing) && !lib.batches.some((b: { active: number }) => b.active > 0);
  }, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  const settledFrom = Date.now();
  await page.waitForTimeout(6000);
  const after = gets.since(settledFrom);
  await note("04-idle-gets", { libraryGetsIn6s: after });
  await check("No GET /api/library in 6 s once the work settled", () => after === 0);
}) satisfies Journey;
