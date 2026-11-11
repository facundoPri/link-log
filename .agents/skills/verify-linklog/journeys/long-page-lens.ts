// long-page-lens: a lens run on a page far over the Jev text cap succeeds, and the stored content stays whole (FAC-220,
// features/tags-autotag.md). The fixture Jev window rejects an uncapped state with too_long.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  const url = fixture("article-long", "one");

  await step("Save a long page and wait for its content");
  await api.ensure("/lenses", { name: "Long page worth it?", type: "noul", question: "Is this page worth reading?", threshold: 0.8 });
  await api.send("POST", "/links", { url });
  const link = await check(
    "API: link ready with content",
    async () => {
      const l = await api.link(url);
      return l && !l.processing && l.content_state === "ready" && l.content_key && l;
    },
    { timeout: 60_000 },
  );
  await check("API: stored content has the head and the tail", async () => {
    const c = await api.get(`/links/${link.id}/content`);
    return c.markdown.length > 100_000 && c.markdown.includes("HEAD-MARKER") && c.markdown.endsWith("TAIL-MARKER");
  });
  await check("API: the preview description was saved", () => String(link.description).includes("DESCRIPTION-MARKER"));
  const before = (await api.get(`/links/${link.id}/content`)).markdown as string;

  await step("Select the link and run the lens from the selection bar");
  await page.reload();
  const row = page.getByRole("checkbox", { name: `Select ${link.title}` }).first();
  await check("Row is listed", () => row.isVisible());
  await row.click();
  const bar = page.getByLabel("Selected link actions");
  await bar.getByRole("button", { name: /^Lens/ }).click();
  const palette = page.getByRole("dialog").filter({ has: page.getByRole("option", { name: /Long page worth it\?/ }) });
  await check("Palette offers the lens", () => palette.isVisible());
  await shot("01-palette-lens");
  await palette.getByRole("option", { name: /Long page worth it\?/ }).click();

  await step("Wait for the lens batch and read its jobs");
  const batch = await check("API: a lens batch started for the link", async () => (await api.library()).batches.filter((b) => b.kind === "lens").find((b) => b.total === 1), { timeout: 30_000 });
  const settled = await check(
    "API: the lens batch settles",
    async () => {
      const lib = await api.library();
      const mine = lib.batches.filter((b) => b.kind === "lens" && b.id === batch.id)[0];
      return mine && mine.active === 0 && mine;
    },
    { timeout: 60_000 },
  );
  const detail = await api.get(`/batches/${batch.id}`);
  await note("batch", detail);
  await check("API: no job failed with too_long", () => !JSON.stringify(detail.jobs).includes("too_long") && settled.failed === 0);
  const result = await check("API: the link has a lens result", async () => (await api.link(url))?.lens_results?.[0]);
  await note("lens-result", result);

  await step("The stored content and the reader are unchanged");
  const after = (await api.get(`/links/${link.id}/content`)).markdown as string;
  await check("API: stored content is byte-identical and still ends with the tail", () => after === before && after.endsWith("TAIL-MARKER"));
  await page.reload();
  await page.getByText(link.title, { exact: true }).first().click();
  await check("Inspector opens", () => page.getByRole("button", { name: "Close inspector" }).isVisible());
  await page.getByRole("tab", { name: "Content" }).click();
  await check("Inspector shows the head of the stored content", () => page.getByText(/HEAD-MARKER/).first().isVisible());
  await shot("02-inspector-content");
}) satisfies Journey;
