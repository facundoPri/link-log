// rapid-paste (FAC-182): four pastes in a row, one of them repeating links still being saved. Each link is
// saved once and the list ends complete, so no older library response replaced a newer one. A regression
// guard for the move to the query cache; it passes on 6f5ade7 too.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot }) => {
  const first = [fixture("article", "a1"), fixture("article", "a2"), fixture("article", "a3")];
  const second = [fixture("article", "b1"), fixture("article", "b2")];
  const third = [fixture("article", "c1"), fixture("article", "c2")];
  const all = [...first, ...second, ...third];

  await step("Paste four lists outside any field without waiting, the third repeating the first");
  await check("The library has loaded", () => page.getByRole("button", { name: "Add link" }).first().isVisible());
  await page.evaluate((lists) => {
    for (const list of lists) {
      const data = new DataTransfer();
      data.setData("text/plain", list.join("\n"));
      document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    }
  }, [first, second, first, third]);

  await step("Every link is saved once");
  const links = await check("API: the library holds each pasted URL exactly once", async () => {
    const lib = await api.library();
    const counts = all.map((u) => lib.links.filter((l: { original_url: string }) => l.original_url === u).length);
    return counts.every((n) => n === 1) && lib.links.filter((l: { original_url: string }) => all.includes(l.original_url));
  }, { timeout: 30_000 });

  await step("The list ends complete without a reload");
  await check("API: every pasted link finished extraction", async () => {
    const lib = await api.library();
    return all.every((u) => lib.links.some((l: { original_url: string; processing: boolean }) => l.original_url === u && !l.processing));
  }, { timeout: 60_000 });
  for (const url of all) {
    const link = await api.link(url);
    await check(`Row "${link.title}" is listed`, () => page.getByText(link.title, { exact: true }).first().isVisible());
  }
  await check("API: 7 links from 9 pasted URLs", () => links.length === 7);
  await shot("01-list-complete");
}) satisfies Journey;
