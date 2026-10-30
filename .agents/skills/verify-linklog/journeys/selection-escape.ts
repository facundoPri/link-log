// selection-escape: Escape that closes a selection-bar menu keeps the selection; a bare Escape clears it.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const urls = ["one", "two", "three"].map((p) => fixture("article", p));

  await step("Seed three links and wait for them to settle");
  for (const url of urls) await api.send("POST", "/links", { url });
  const links = await check(
    "API: three links ready",
    async () => {
      const found = await Promise.all(urls.map((u) => api.link(u)));
      return found.every((l) => l && !l.processing && l.status === "ready") && found;
    },
    { timeout: 60_000 },
  );
  await page.reload();

  await step("Select two links");
  for (const l of links.slice(0, 2)) {
    await check(`Row "${l.title}" is listed`, () => page.getByRole("checkbox", { name: `Select ${l.title}` }).isVisible());
    await page.getByRole("checkbox", { name: `Select ${l.title}` }).click();
  }
  await check("Bar says 2 selected", () => page.getByText("2 selected").isVisible());
  await shot("01-two-selected");

  await step("Open the Copy menu and press Escape");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  const menu = page.getByRole("menu");
  await check("Copy menu is open", () => menu.isVisible());
  await shot("02-copy-menu");
  await page.keyboard.press("Escape");
  await check("Copy menu closed", async () => !(await menu.isVisible()));
  await check("Bar still says 2 selected", () => page.getByText("2 selected").isVisible());
  await shot("03-menu-closed-selection-kept");

  await step("Press Escape with nothing open");
  await page.keyboard.press("Escape");
  await check("Selection cleared", async () => !(await page.getByText("2 selected").isVisible()));
  await shot("04-selection-cleared");
}) satisfies Journey;
