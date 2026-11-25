// activity-usage-totals (FAC-181): the totals at the top of Activity come from GET /usage, kept in the
// account's query cache. Reopening Activity revalidates them, and they follow a batch that settles while
// the sheet is open. Neither case reloads the page.
import type { Page } from "playwright-core";
import type { Journey } from "../scripts/journey";

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => s === "hidden" });
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  }, state);

export default (async ({ page, api, fixture, step, check, shot }) => {
  const name = `Totals ${Date.now() % 100000}`;
  const origin = new URL(page.url()).origin;
  const { key } = await api.send("POST", "/auth/api-key/create", { name });
  const submit = (path: string) =>
    fetch(`${origin}/api/v1/links`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ urls: [fixture("article", path)] }),
    }).then((r) => r.json());
  const idle = async () => {
    const lib = await api.library();
    return !lib.links.some((l: { processing: boolean }) => l.processing) && !lib.batches.some((b: { active: number }) => b.active > 0);
  };
  const calls = async () => (await api.get("/usage")).totals.calls as number;

  await step("Open Activity on an idle page: the totals show the calls so far");
  await check("API: nothing is running", idle, { timeout: 60_000 });
  const first = await calls();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const activity = page.getByRole("button", { name: /^(Activity|Extracting)/ });
  await activity.click();
  await check(`Activity totals read ${first} calls`, () => sheet.getByText(new RegExp(`· ${first} calls`)).isVisible());
  await page.keyboard.press("Escape");
  await check("Activity closes", async () => !(await sheet.isVisible()));

  await step("An integration submits a URL with the key and the work finishes while Activity is closed");
  const accepted = await submit("1");
  await check("API: the batch finished and its calls are counted", async () => {
    const b = (await api.library()).batches.find((x: { id: string }) => x.id === accepted.batchId);
    return b && b.active === 0 && (await calls()) > first;
  }, { timeout: 60_000 });
  const second = await calls();

  await step("Reopen Activity without a reload: the totals revalidate");
  await activity.click();
  await check(`Activity totals read ${second} calls`, () => sheet.getByText(new RegExp(`· ${second} calls`)).isVisible(), { timeout: 10_000 });
  await shot("01-totals-after-reopen");

  await step("Another batch settles while Activity stays open");
  const batch = await submit("2");
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await check("API: the second batch finished", async () => {
    const b = (await api.library()).batches.find((x: { id: string }) => x.id === batch.batchId);
    return b && b.active === 0;
  }, { timeout: 60_000 });
  const third = await calls();
  await check(`Activity totals read ${third} calls`, () => sheet.getByText(new RegExp(`· ${third} calls`)).isVisible(), { timeout: 10_000 });
  await shot("02-totals-after-settle");
}) satisfies Journey;
