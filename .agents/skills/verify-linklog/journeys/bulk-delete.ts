// bulk-delete (FAC-46): selected links are deleted from the ⌘K palette (desktop) and the drawer (mobile) after a
// confirmation with the count. Content and tag assignments go, tags stay, a link with a running job is deleted too and
// its job shows in Activity as cancelled because the link was deleted, the list updates from the library the request
// returns, and Demo B can't delete Demo A's links.
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

  await step("Desktop: confirm the delete, reached through More this time");
  await bar.getByRole("button", { name: /^More/ }).click();
  await check("More opens the palette", () => palette.isVisible());
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
  const toast = (text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
  await check("Toast says Deleted 2 links", () => toast("Deleted 2 links").isVisible());
  await check("Selection cleared: the bar is gone", async () => !(await bar.isVisible()));
  await page.waitForTimeout(1500);
  page.off("request", countGets);
  await note("library-gets-after-delete", { count: gets.length });
  await check("The list updated from the returned library, with no GET /api/library", () => gets.length === 0);
  await snap("03-after-delete");

  await step("Desktop: a link with a running job is deleted and its job cancelled");
  const slow = fixture("slow-ok", "running");
  const slowId = ((await api.send("POST", "/links", { url: slow })) as { id: string }).id;
  const slowBatch = await check(
    "API: its extraction job is running",
    async () => {
      const lib = await api.library();
      for (const batch of lib.batches.filter((x) => x.active > 0 && x.kind === "extract")) {
        const detail = (await api.get(`/batches/${batch.id}`)) as { jobs: { link_id: string; status: string }[] };
        if (detail.jobs.some((j) => j.link_id === slowId && j.status === "running")) return batch.id;
      }
      return false;
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
  await check("Confirmation says processing is cancelled", async () => /still processing them is cancelled/.test((await confirm.textContent()) ?? ""));
  await confirm.getByRole("button", { name: "Delete 2 links" }).click();
  await check("API: both links are gone, the running one too", async () => !(await api.link(keep)) && !(await api.library()).links.some((l) => l.id === slowId));
  await check("Toast says Deleted 2 links and the job it cancelled", () => toast("Cancelled 1 job still processing them").isVisible());
  await check("Selection cleared: the bar is gone", async () => !(await bar.isVisible()));
  const cancelledJob = await check("API: Activity keeps the job, cancelled because the link was deleted", async () => {
    const detail = (await api.get(`/batches/${slowBatch}`)) as { jobs: { link_id: string | null; status: string; step: string; error: string | null; title: string | null }[] };
    const j = detail.jobs[0];
    return detail.jobs.length === 1 && j && j.link_id === null && j.status === "failed" && j.step === "Cancelled" && j.error === "Cancelled: link deleted" && j.title && j;
  });
  await note("cancelled-job", cancelledJob);
  await check("API: the batch counts it as cancelled, not failed", async () => {
    const b = (await api.library()).batches.find((x) => x.id === slowBatch);
    return b && b.active === 0 && b.failed === 0 && b.cancelled === 1;
  });
  await snap("04-deleted-running");
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  await sheet.getByText("Extract context", { exact: true }).first().click();
  await check("Sheet: the job is listed under the deleted link's title", () => sheet.getByText(cancelledJob.title!, { exact: true }).first().isVisible());
  await check("Sheet: it says Cancelled: link deleted", () => sheet.getByText("Cancelled: link deleted", { exact: true }).first().isVisible());
  await snap("05-activity-cancelled");
  await page.keyboard.press("Escape");

  await step("Demo B can't delete Demo A's link");
  const asB = apiAs(1);
  const foreign = (await asB.send("POST", "/links/delete", { ids: [m.id] })) as { deleted: string[]; cancelled: number };
  await note("demo-b-delete", { deleted: foreign.deleted, cancelled: foreign.cancelled });
  await check("Demo B's request deletes and cancels nothing", () => foreign.deleted.length === 0 && foreign.cancelled === 0);
  await check("API: Demo A's link is intact", async () => !!(await api.link(mobile)));

  await step("Mobile 390x844: Delete from the drawer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await check("Row checkbox is visible", () => box(m.title).isVisible());
  await box(m.title).click();
  await bar.getByRole("button", { name: /^Actions/ }).click();
  const drawerDelete = page.getByRole("dialog").getByRole("button", { name: "Delete 1 link" });
  await check("Drawer shows Delete 1 link", () => drawerDelete.isVisible());
  await snap("06-mobile-drawer");
  await drawerDelete.click();
  const mobileConfirm = page.getByRole("alertdialog", { name: "Delete 1 link?" });
  await check("Confirmation opens", () => mobileConfirm.isVisible());
  await snap("07-mobile-confirm");
  await mobileConfirm.getByRole("button", { name: "Delete 1 link" }).click();
  await check("API: the link is gone", async () => !(await api.link(mobile)));
  await check("Row disappears", async () => (await page.getByText(m.title, { exact: true }).count()) === 0);
  await snap("08-mobile-after");

  await check("Toast says Deleted 1 link", () => toast("Deleted 1 link").isVisible());
}) satisfies Journey;
