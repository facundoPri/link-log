// settings-revalidate (FAC-181): Settings keeps its usage summary and API key list in the account's query
// cache. A link submitted with a key while Settings is open shows in the key's row when the tab regains
// focus, and coming back to Settings later shows the cached rows right away while both requests revalidate.
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

export default (async ({ page, api, fixture, step, check, shot }) => {
  const name = `Revalidate ${Date.now() % 100000}`;
  const origin = new URL(page.url()).origin;
  const { key, id } = await api.send("POST", "/auth/api-key/create", { name });

  await step("Open Settings from the account menu: the new key has not been used");
  await page.locator("aside").getByRole("button", { name: /demo-a@linklog\.test/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const keys = page.getByRole("region", { name: "API keys" });
  const row = keys.getByRole("listitem").filter({ hasText: name });
  await check("The key row says Never used and 0 links this month", async () => (await row.getByText("Never used").isVisible()) && (await row.getByText("0 links this month").isVisible()));

  await step("An integration submits a URL with the key while Settings is open");
  const res = await fetch(`${origin}/api/v1/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ urls: [fixture("article", "revalidate")] }),
  });
  await check("API: 202", () => res.status === 202);
  await check("API: the usage summary counts the link and the key list has a last use", async () => {
    const summary = await api.get("/usage/summary");
    const listed = (await api.get("/auth/api-key/list")).apiKeys.find((k: { id: string }) => k.id === id);
    return summary.month.apiKeys.find((k: { id: string }) => k.id === id)?.links === 1 && listed?.lastRequest;
  });

  await step("The user switches away and back");
  await setVisibility(page, "hidden");
  await setVisibility(page, "visible");
  await check("The row shows Last used and 1 link this month without a reload", async () => (await row.getByText(/^Last used /).isVisible()) && (await row.getByText("1 link this month").isVisible()), { timeout: 10_000 });
  await shot("01-settings-after-focus");

  await step("Back to the library, then Settings again while both requests are held");
  await page.getByRole("button", { name: "Back to library" }).click();
  await check("Library is shown", () => page.getByRole("button", { name: "Add link" }).first().isVisible());
  let held = 0;
  const hold = async (route: import("playwright-core").Route) => {
    held++;
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  };
  await page.route("**/api/usage/summary", hold);
  await page.route("**/api/auth/api-key/list", hold);
  await page.locator("aside").getByRole("button", { name: /demo-a@linklog\.test/ }).click();
  const back = Date.now();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await check("The key row and its usage are shown before the requests answer", async () =>
    (await row.getByText("1 link this month").isVisible()) && Date.now() - back < 3500, { timeout: 3000 });
  await shot("02-settings-from-cache");
  await check("Opening Settings revalidated both", () => held >= 2);
  await page.unroute("**/api/usage/summary");
  await page.unroute("**/api/auth/api-key/list");
}) satisfies Journey;
