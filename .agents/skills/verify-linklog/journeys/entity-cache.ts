// entity-cache (FAC-183): the Inspector shows a link's content from cache the moment it reopens, then
// revalidates; an edit made elsewhere shows up without reopening; saving from the Inspector updates
// it everywhere; and tag changes from the tag dialog reach the sidebar, the list and the Inspector
// without a reload.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const url = fixture("article", "one");
  const tag = `qa-entity-${Date.now() % 100000}`;
  const renamed = `${tag}-b`;

  await step("Set up: a saved link with known content and a tag");
  await api.send("POST", "/links", { url });
  const link = await check("API: link ready with content", async () => {
    const l = await api.link(url);
    return l && !l.processing && l.content_state === "ready" && l;
  }, { timeout: 60_000 });
  await api.send("PUT", `/links/${link.id}/content`, { markdown: "# Cache probe\n\nfirst version body" });
  await page.reload();

  await step("Open the link: its content shows");
  const inspector = page.getByRole("button", { name: "Close inspector" });
  await page.getByText(link.title, { exact: true }).first().click();
  await check("Inspector opens", () => inspector.isVisible());
  await page.getByRole("tab", { name: "Content" }).click();
  await check("Inspector shows the first version", () => page.getByText("first version body").first().isVisible());

  await step("Close and reopen with a slow content endpoint: the cached content shows at once");
  await inspector.click();
  let contentGets = 0;
  await page.route("**/api/links/*/content", async (route) => {
    if (route.request().method() === "GET") {
      contentGets++;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await route.continue().catch(() => {});
  });
  await page.getByText(link.title, { exact: true }).first().click();
  await page.getByRole("tab", { name: "Content" }).click();
  await check("Reopened Inspector shows the content within 1 s, before the slow request answers", () => page.getByText("first version body").first().isVisible(), { timeout: 1000 });
  await check("The content is requested again to revalidate", () => contentGets > 0);
  await page.unroute("**/api/links/*/content");

  await step("An edit made elsewhere shows up when the window regains focus, without reopening");
  await api.send("PUT", `/links/${link.id}/content`, { markdown: "# Cache probe\n\nsecond version body" });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await check("Inspector shows the second version", () => page.getByText("second version body").first().isVisible());

  await step("Save content from the Inspector");
  await page.getByRole("button", { name: "Edit content" }).click();
  await page.getByRole("textbox").last().fill("# Cache probe\n\nthird version body");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await check("API: the stored content is the third version", async () => (await api.get(`/links/${link.id}/content`)).markdown.includes("third version body"));
  await check("Inspector shows the third version", () => page.getByText("third version body").first().isVisible());
  await page.getByRole("tab", { name: "Details" }).click();
  await check("Inspector shows the new content version", async () => page.getByText(new RegExp(`· v${(await api.link(url)).content_version}\\b`)).first().isVisible());
  await page.getByRole("tab", { name: "Content" }).click();
  await shot("01-content-saved");

  await step("Create a tag from the tag dialog");
  await page.getByRole("button", { name: "New tag" }).click();
  const dialog = page.getByRole("dialog", { name: "New tag" });
  await dialog.getByLabel("Name").fill(tag);
  await dialog.getByRole("button", { name: "Create tag" }).click();
  await check("API: the tag exists", async () => (await api.library()).tags.some((t: { name: string }) => t.name === tag));
  await check("Sidebar lists the tag", () => page.getByRole("button", { name: `Tag options for ${tag}` }).isVisible());
  await api.send("PATCH", `/links/${link.id}`, { tags: [tag] });
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
  await check("Inspector shows the tag on the open link", () => page.getByRole("button", { name: `Remove ${tag}` }).first().isVisible());

  await step("Rename it in the tag dialog");
  await page.getByRole("button", { name: `Tag options for ${tag}` }).click({ force: true });
  await page.getByRole("menuitem", { name: "Edit tag…" }).click();
  const edit = page.getByRole("dialog", { name: "Edit tag" });
  await edit.getByLabel("Name").fill(renamed);
  await edit.getByRole("button", { name: "Save changes" }).click();
  await check("API: the tag is renamed", async () => (await api.library()).tags.some((t: { name: string }) => t.name === renamed));
  await check("Sidebar shows the new name", () => page.getByRole("button", { name: `Tag options for ${renamed}` }).isVisible());
  await check("Inspector shows the new name on the open link", () => page.getByRole("button", { name: `Remove ${renamed}` }).first().isVisible());
  await check("The name shows in the sidebar, the list row and the Inspector", async () => (await page.getByText(renamed, { exact: true }).count()) >= 3);
  await shot("02-tag-renamed");

  await step("Delete it from the tag dialog");
  await page.getByRole("button", { name: `Tag options for ${renamed}` }).click({ force: true });
  await page.getByRole("menuitem", { name: "Edit tag…" }).click();
  await page.getByRole("dialog", { name: "Edit tag" }).getByRole("button", { name: "Delete tag" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete tag" }).click();
  await check("API: the tag is gone", async () => !(await api.library()).tags.some((t: { name: string }) => t.name === renamed));
  await check("Sidebar no longer lists it", async () => (await page.getByRole("button", { name: `Tag options for ${renamed}` }).count()) === 0);
  await check("Neither the list nor the Inspector shows it", async () => (await page.getByText(renamed, { exact: true }).count()) === 0);
  await shot("03-tag-deleted");
}) satisfies Journey;
