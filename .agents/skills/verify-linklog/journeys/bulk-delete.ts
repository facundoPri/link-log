// bulk-delete (FAC-46): selected links are deleted from the ⌘K palette (desktop) and the drawer (mobile) after a
// confirmation with the count. Content and tag assignments go, tags stay, a link with a running job is skipped and
// stays selected, the list updates from the library the request returns, and Demo B can't delete Demo A's links.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, apiAs, fixture, step, check, shot, note }) => {
  const snap = async (name: string) => {
    await page.waitForTimeout(500);
    await shot(name);
  };
  const [one, two, keep, mobile] = ["one", "two", "keep", "mobile"].map((p) => fixture("article", p));
  const tag = `bulk-delete-${Date.now()}`;

  await step("Seed four articles; two carry a fresh tag");
  for (const url of [one, two, keep, mobile]) await api.send("POST", "/links", { url, tags: url === keep || url === mobile ? [] : [tag] });
  const [a, b, k, m] = await check(
    "API: all four ready with content",
    async () => {
      const found = await Promise.all([one, two, keep, mobile].map((u) => api.link(u)));
      return found.every((l) => l && !l.processing && l.content_key) && found;
    },
    { timeout: 60_000 },
  );
  const content = (id: string) =>
    api.get(`/links/${id}/content`).then((r: { markdown: string }) => r.markdown, (e: Error) => (/→ 404/.test(e.message) ? null : Promise.reject(e)));
  await check("API: the first link has stored content", async () => !!(await content(a.id)));
  await page.reload();
  const box = (title: string) => page.getByRole("checkbox", { name: `Select ${title}` }).first();
  const bar = page.getByLabel("Selected link actions");

  await step("Desktop: select two, Delete from ⌘K, then cancel");
  for (const l of [a, b]) {
    await check(`Row "${l.title}" is listed`, () => box(l.title).isVisible());
    await box(l.title).click();
  }
  await check("Bar says 2 selected", async () => /2 selected/.test((await bar.textContent()) ?? ""));
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Commands" });
  await check("Palette lists Delete under Danger with 2/2", async () => /2\/2/.test((await palette.getByRole("option", { name: /^Delete/ }).textContent()) ?? ""));
  await snap("01-palette-delete");
  await palette.getByRole("option", { name: /^Delete/ }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete 2 links?" });
  await check("Confirmation names the count and says it can't be undone", async () => /can't be undone/.test((await confirm.textContent()) ?? ""));
  await snap("02-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await check("Cancel keeps both links and the selection", async () => !!(await api.link(one)) && !!(await api.link(two)) && /2 selected/.test((await bar.textContent()) ?? ""));

  await step("Desktop: confirm the delete");
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("option", { name: /^Delete/ }).click();
  const gets: string[] = [];
  const countGets = (r: { url(): string; method(): string }) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/api/library") gets.push(r.url());
  };
  page.on("request", countGets);
  await confirm.getByRole("button", { name: "Delete 2 links" }).click();
  await check("API: both links are gone, the third stays", async () => !(await api.link(one)) && !(await api.link(two)) && !!(await api.link(keep)));
  await check("API: the deleted link's content is gone", async () => (await content(a.id)) === null);
  await check("API: the tag definition stays with no links", async () => (await api.library()).tags.some((t) => t.name === tag));
  await check("Rows disappear", async () => (await page.getByText(a.title, { exact: true }).count()) === 0 && (await page.getByText(b.title, { exact: true }).count()) === 0);
  await check("Toast says Deleted 2 links", async () => (await page.locator("[data-sonner-toast]").filter({ hasText: "Deleted 2 links" }).count()) > 0);
  await check("Selection cleared: the bar is gone", async () => !(await bar.isVisible()));
  await page.waitForTimeout(1500);
  page.off("request", countGets);
  await note("library-gets-after-delete", { count: gets.length });
  await check("The list updated from the returned library, with no GET /api/library", () => gets.length === 0);
  await snap("03-after-delete");

  await step("Desktop: a link with a running job is skipped and stays selected");
  const slow = fixture("slow-ok", "running");
  const slowId = ((await api.send("POST", "/links", { url: slow })) as { id: string }).id;
  await check(
    "API: its extraction job is running",
    async () => {
      const lib = await api.library();
      const batch = lib.batches.find((x) => x.active > 0 && x.kind === "extract");
      if (!batch) return false;
      const detail = (await api.get(`/batches/${batch.id}`)) as { jobs: { link_id: string; status: string }[] };
      return detail.jobs.some((j) => j.link_id === slowId && j.status === "running");
    },
    { timeout: 20_000 },
  );
  const running = await check("API: its preview title arrived", async () => {
    const l = await api.link(slow);
    return l?.title.startsWith("Slow but fine") && l.processing && l;
  });
  await page.reload();
  for (const title of [running.title, k.title]) {
    await check(`Row "${title}" is listed`, () => box(title).isVisible());
    await box(title).click();
  }
  await check("Bar says 2 selected", async () => /2 selected/.test((await bar.textContent()) ?? ""));
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("option", { name: /^Delete/ }).click();
  await confirm.getByRole("button", { name: "Delete 2 links" }).click();
  await check("API: the idle link is gone, the running one stays", async () => !(await api.link(keep)) && (await api.library()).links.some((l) => l.id === slowId));
  await check("Toast says 1 still processing, skipped", async () => (await page.locator("[data-sonner-toast]").filter({ hasText: "1 still processing, skipped" }).count()) > 0);
  await check("The running link stays selected", async () => /1 selected/.test((await bar.textContent()) ?? ""));
  await snap("04-skipped-running");
  await bar.getByRole("button", { name: "Clear selection" }).click();

  await step("Demo B can't delete Demo A's link");
  const asB = apiAs(1);
  const foreign = (await asB.send("POST", "/links/delete", { ids: [m.id] })) as { deleted: string[]; running: string[] };
  await note("demo-b-delete", { deleted: foreign.deleted, running: foreign.running });
  await check("Demo B's request deletes nothing", () => foreign.deleted.length === 0 && foreign.running.length === 0);
  await check("API: Demo A's link is intact", async () => !!(await api.link(mobile)));

  await step("Mobile 390x844: Delete from the drawer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await check("Row checkbox is visible", () => box(m.title).isVisible());
  await box(m.title).click();
  await bar.getByRole("button", { name: /^Actions/ }).click();
  const drawerDelete = page.getByRole("dialog").getByRole("button", { name: "Delete 1 link" });
  await check("Drawer shows Delete 1 link", () => drawerDelete.isVisible());
  await snap("05-mobile-drawer");
  await drawerDelete.click();
  const mobileConfirm = page.getByRole("alertdialog", { name: "Delete 1 link?" });
  await check("Confirmation opens", () => mobileConfirm.isVisible());
  await snap("06-mobile-confirm");
  await mobileConfirm.getByRole("button", { name: "Delete 1 link" }).click();
  await check("API: the link is gone", async () => !(await api.link(mobile)));
  await check("Row disappears", async () => (await page.getByText(m.title, { exact: true }).count()) === 0);
  await snap("07-mobile-after");

  await step("The skipped link deletes once its extraction finished");
  await check("API: the skipped link finished with content", async () => {
    const l = await api.link(slow);
    return l && !l.processing && !!l.content_key;
  }, { timeout: 60_000 });
  const retry = (await api.send("POST", "/links/delete", { ids: [slowId] })) as { deleted: string[]; running: string[] };
  await check("API: deleted this time, nothing running", () => retry.deleted[0] === slowId && retry.running.length === 0);
  await check("API: its content is gone", async () => (await content(slowId)) === null);
}) satisfies Journey;
