// settings-back-cache (FAC-182): Settings → Back to library shows the library from cache right away. The
// journey holds the library GET that the return triggers for 4 s; the saved link must be listed before it
// answers, so it can only come from the cache.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const url = fixture("article", "settings-back");

  await step("Set up: a saved link, listed in the library");
  await api.send("POST", "/links", { url, tags: [] });
  const link = await check("API: the link is ready", async () => {
    const l = await api.link(url);
    return l && !l.processing && l;
  }, { timeout: 60_000 });
  await page.reload();
  const row = page.getByText(link.title, { exact: true }).first();
  await check(`Row "${link.title}" is listed`, () => row.isVisible());

  await step("Open Settings from the account menu");
  await page.locator("aside").getByRole("button", { name: /demo-a@linklog\.test/ }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await check("Settings is shown", () => page.getByRole("heading", { name: "Settings" }).isVisible());

  await step("Back to library while the library request is held");
  let held = 0;
  await page.route("**/api/library", async (route) => {
    held++;
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  const back = Date.now();
  await page.getByRole("button", { name: "Back to library" }).click();
  await check(`Row "${link.title}" is listed before the library request answers`, async () => (await row.isVisible()) && Date.now() - back < 3500, { timeout: 3000 });
  await shot("01-back-from-cache");
  await check("The return revalidated the library", () => held > 0);
  await page.unroute("**/api/library");
}) satisfies Journey;
