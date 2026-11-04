// batch-progress-ui: while an extract batch runs, each link row reads "In progress…", the batch toast shows
// "N of M", and neither the selection bar nor Activity draws a progress bar (FAC-192).
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const urls = ["a", "b", "c", "d", "e", "f"].map((p) => fixture("pool", p));

  await step("Seed 6 slow links and wait for their first extraction to settle");
  for (const url of urls) await api.send("POST", "/links", { url });
  const links = await check(
    "API: all six links settled",
    async () => {
      const found = await Promise.all(urls.map((u) => api.link(u)));
      return found.every((l) => l && !l.processing && l.content_state === "ready") && found;
    },
    { timeout: 120_000 },
  );
  await page.reload();

  await step("Select the six links and extract their context again");
  for (const l of links) {
    const box = page.getByRole("checkbox", { name: `Select ${l.title}` }).first();
    await check(`Row "${l.title}" is listed`, () => box.isVisible());
    await box.click();
  }
  const bar = page.getByLabel("Selected link actions");
  await check("Bar shows 6 selected", () => bar.getByRole("button", { name: "6 selected" }).isVisible());
  await page.keyboard.press("e");
  await page.getByRole("alertdialog", { name: "Extract context for 6 links?" }).getByRole("button", { name: "Extract", exact: true }).click();
  const batch = await check("API: an extract batch of 6 exists", async () => (await api.library()).batches.find((b) => b.kind === "extract" && b.total === 6 && b.active > 0));

  await step("Rows read In progress…, the toast reads N of 6, and no progress bar is drawn");
  await check("Every row shows In progress…", async () => (await page.getByText("In progress…", { exact: true }).count()) === 6, { timeout: 10_000 });
  await check("No row shows a step name", async () => (await page.getByText(/^(Queued…|Waiting for (content…|Jev slot|Browser slot)|Extracting…|Applying lens…)$/).count()) === 0);
  await check("No row badge has a tooltip title", async () => (await page.getByText("In progress…", { exact: true }).first().evaluate((el) => !el.closest("[title='In progress…']") && !el.getAttribute("title"))));
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: /Extracting context for 6 links/ });
  await check("Toast shows 0 of 6 or more", () => toast.getByText(/^\d of 6$/).isVisible());
  await check("Toast has no 'done' suffix and keeps Cancel", async () => (await toast.getByText(/done/).count()) === 0 && (await toast.getByRole("button", { name: "Cancel" }).isVisible()));
  await check("No progress bar anywhere on the page", async () => (await page.getByRole("progressbar").count()) === 0 && (await page.getByRole("region", { name: "Running job" }).count()) === 0);
  await page.waitForTimeout(400);
  await shot("01-rows-in-progress");

  await step("Toast advances as jobs settle");
  await check("Toast reads 2 of 6 or more", async () => /^[2-6] of 6$/.test(((await toast.getByText(/^\d of 6$/).textContent({ timeout: 1000 }).catch(() => "")) ?? "")), { timeout: 30_000 });
  await shot("02-toast-advanced");

  await step("Activity lists the job steps but draws no progress bar");
  await page.getByRole("button", { name: /Activity|Extracting/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await check("Activity is open", () => sheet.isVisible());
  await sheet.getByRole("button", { name: /Extracting|Extract/ }).first().click().catch(() => {});
  await page.waitForTimeout(500);
  await check("Activity shows no progress bar", async () => (await page.getByRole("progressbar").count()) === 0);
  await shot("03-activity-no-bar");
  await page.keyboard.press("Escape");

  await step("The batch ends and the toast resolves");
  await check("API: batch settled", async () => (await api.library()).batches.find((b) => b.id === batch.id && b.active === 0), { timeout: 90_000 });
  await check("Toast resolves to Extracted 6 links", () => page.locator("[data-sonner-toast]").getByText("Extracted 6 links").isVisible());
  await check("No row reads In progress…", async () => (await page.getByText("In progress…", { exact: true }).count()) === 0);
  await shot("04-settled");
}) satisfies Journey;
