// inspector-delete (FAC-181): deleting a link from the Inspector removes it from the list using the library the
// DELETE returns, with no follow-up GET /api/library.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  const url = fixture("article", "delete");

  await step("Set up: one ready link");
  await api.send("POST", "/links", { url, tags: [] });
  const link = await check("API: link ready", async () => {
    const l = await api.link(url);
    return l && !l.processing && l.status === "ready" && l;
  }, { timeout: 60_000 });
  await page.reload();
  const row = page.getByText(link.title, { exact: true }).first();
  await check("Row is listed", () => row.isVisible());

  await step("Delete it from the Inspector");
  await row.click();
  // The row has its own "Link actions" menu; take the one beside "Close inspector".
  const inspector = page
    .getByRole("button", { name: "Close inspector" })
    .locator("xpath=ancestor::*[.//button[@aria-label='Link actions']][1]");
  await inspector.getByRole("button", { name: "Link actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete this link?" });
  await check("Confirmation opens", () => confirm.isVisible());
  const gets: string[] = [];
  const count = (r: { url(): string; method(): string }) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/api/library") gets.push(r.url());
  };
  page.on("request", count);
  await confirm.getByRole("button", { name: "Delete" }).click();

  await check("Row disappears", async () => (await page.getByText(link.title, { exact: true }).count()) === 0, { timeout: 5_000 });
  await check("Inspector closes", async () => !(await page.getByRole("button", { name: "Close inspector" }).isVisible()));
  await page.waitForTimeout(1500);
  page.off("request", count);
  await note("library-gets-after-delete", { count: gets.length });
  await check("No GET /api/library after the delete", () => gets.length === 0);
  await check("API: link is gone", async () => !(await api.link(url)));
  await shot("01-after-delete");
}) satisfies Journey;
