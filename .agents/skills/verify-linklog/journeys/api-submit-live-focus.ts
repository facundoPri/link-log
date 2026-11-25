// api-submit-live-focus (FAC-182): Activity stays open while the Linklog tab is in the background; a batch
// submitted through the public API meanwhile appears when the tab comes back, without a reload.
// Headless Chromium never hides a tab, so the journey sets document.visibilityState and fires the same
// visibilitychange event the browser sends when the user switches tabs.
import type { Page } from "playwright-core";
import type { Journey } from "../scripts/journey";

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, state);

export default (async ({ page, api, fixture, step, check, shot, aria, note }) => {
  const name = `Focus ${Date.now() % 100000}`;
  const origin = new URL(page.url()).origin;
  const { key } = await api.send("POST", "/auth/api-key/create", { name });
  const label = `Extract context · API · ${name}`;

  await step("Open Activity on an idle page");
  await check("API: no link is processing and no batch is active", async () => {
    const lib = await api.library();
    return !lib.links.some((l: { processing: boolean }) => l.processing) && !lib.batches.some((b: { active: number }) => b.active > 0);
  }, { timeout: 60_000 });
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await check("Activity opens", () => sheet.isVisible());

  await step("The user switches to another tab");
  await setVisibility(page, "hidden");

  await step("Meanwhile an integration submits a URL with the API key");
  const res = await fetch(`${origin}/api/v1/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [fixture("article", "1")] }),
  });
  const accepted = await res.json();
  await check("API: 202 with a batchId", () => res.status === 202 && accepted.batchId);
  await note("01-submit", { status: res.status, body: accepted });
  await page.waitForTimeout(3000);
  await check(`While the tab is hidden, Activity doesn't list "${label}" yet`, async () => (await sheet.getByText(label, { exact: true }).count()) === 0);

  await step("The user comes back to the Linklog tab");
  await setVisibility(page, "visible");
  await check(`Activity shows "${label}" without a reload`, () => sheet.getByText(label, { exact: true }).isVisible(), { timeout: 10_000 });
  await page.waitForTimeout(600);
  await shot("02-activity-after-focus");
  await aria("02-activity-after-focus");
}) satisfies Journey;
