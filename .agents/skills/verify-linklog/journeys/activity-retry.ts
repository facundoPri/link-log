// activity-retry (FAC-183): retrying a failed auto-tag run from Activity lists the retry batch in the
// sheet and the library without a reload. Launch with `V up --fast-retries` so the failing job ends in seconds.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const url = fixture("article", "retry");

  await step("Set up: a link whose content makes the fixture provider fail, and a tag");
  await api.ensure("/tags", { name: "qa-retry" });
  await api.send("POST", "/links", { url });
  const link = await check("API: link ready with content", async () => {
    const l = await api.link(url);
    return l && !l.processing && l.content_state === "ready" && l;
  }, { timeout: 60_000 });
  await api.send("PUT", `/links/${link.id}/content`, { markdown: "# Retry probe\n\njev:fail" });
  const { batchId } = await api.send("POST", "/batches", { ids: [link.id], kind: "autotag" });
  const failed = await check("API: the auto-tag batch ends with a failed job", async () => {
    const b = (await api.library()).batches.find((x: { id: string }) => x.id === batchId);
    return b && b.active === 0 && b.failed === 1 && b;
  }, { timeout: 60_000 });
  await page.reload();

  await step("Open Activity and expand the failed batch");
  await page.getByRole("button", { name: /^(Activity|Extracting|Auto-tagging)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await sheet.getByText("Auto-tag", { exact: true }).click();
  await check("The sheet lists the failed job", () => sheet.getByText(link.title, { exact: true }).isVisible());
  await shot("01-failed");

  await step("Retry failed from the sheet");
  await sheet.getByRole("button", { name: "Retry failed" }).click();
  await check("API: the retry is a second auto-tag batch", async () => (await api.library()).batches.filter((x: { kind: string }) => x.kind === "autotag").length === 2);
  await check("Sheet: the retry batch is listed without a reload", async () => (await sheet.getByText("Auto-tag", { exact: true }).count()) === 2, { timeout: 3000 });
  await check("Sheet: the retry batch settles as failed", async () => (await sheet.getByText("1 failed").count()) === 2, { timeout: 60_000 });
  await shot("02-retried");
}) satisfies Journey;
