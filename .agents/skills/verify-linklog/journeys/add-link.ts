// add-link: save one URL from the Add link button (the palette's links page), watch extraction finish in the list,
// open it in the inspector, and confirm the stored link and content from a reload and the API (features/add-link.md).
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot, aria, note }) => {
  const url = fixture("article", "one");

  await step("Open the library signed in as Demo A");
  // The toolbar button renders first; an empty library adds a second "Add link" in the empty state.
  const add = page.getByRole("button", { name: "Add link" }).first();
  await check("Add link button is visible", () => add.isVisible());
  await shot("01-library");

  await step("Add one link from the palette's links page: type it, Enter, then Enter on Save");
  await add.click();
  const palette = page.getByRole("dialog", { name: "Commands" });
  await palette.getByRole("combobox").fill(url);
  await page.keyboard.press("Enter");
  await check("The typed URL is listed, with Save first", () => palette.getByRole("option", { name: /^Save 1 link to Library/ }).isVisible());
  await shot("02-links-page");
  await page.keyboard.press("Enter");
  await check("Palette closes after Save", async () => !(await palette.isVisible()));

  await step("Wait for the preview and content extraction to settle");
  const link = await check(
    "API: link ready with content, nothing needs attention",
    async () => {
      const l = await api.link(url);
      return l && !l.processing && l.status === "ready" && l.content_state === "ready" && l.attention_kind === null && l;
    },
    { timeout: 60_000 },
  );
  const row = page.getByText(link.title, { exact: true }).first();
  await check(`Row shows the fetched title "${link.title}"`, () => row.isVisible());
  await shot("03-row-ready");

  await step("Open the link in the inspector");
  await row.click();
  await check("Inspector opens", () => page.getByRole("button", { name: "Close inspector" }).isVisible());
  await page.getByRole("tab", { name: "Content" }).click();
  await check("Inspector shows the extracted content", () => page.getByText(/deterministic QA article/).first().isVisible());
  await shot("04-inspector-content");
  await page.getByRole("button", { name: "Close inspector" }).click();

  await step("Reload: the link persists, and its stored content matches");
  await page.reload();
  await check("Row is still listed after reload", () => page.getByText(link.title, { exact: true }).first().isVisible());
  const content = await check("API: stored Markdown has the article text", async () => {
    const c = await api.get(`/links/${link.id}/content`);
    return typeof c.markdown === "string" && c.markdown.includes("deterministic QA article") && c;
  });
  await note("link", { id: link.id, url, title: link.title, status: link.status, content_state: link.content_state, content_source: link.content_source, markdown: content.markdown.slice(0, 300) });
  await aria("05-library-after-reload");
  await shot("05-library-after-reload");
}) satisfies Journey;
