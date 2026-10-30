// bulk-actions-desktop: the desktop selection bar, the ⌘K palette, direct shortcuts and the per-link results card (1280x820).
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  // Bar, palette and dialogs fade in; a screenshot taken mid-animation shows half-drawn controls.
  const snap = async (name: string) => {
    await page.waitForTimeout(400);
    await shot(name);
  };
  const articles = ["one", "two", "three", "four"].map((p) => fixture("article", p));
  const broken = ["gone", "nowhere", "pdf"].map((name) => fixture(name, "x"));
  const all = [...articles, ...broken];

  await step("Seed 4 articles and 3 links that can never be extracted, one tag and one lens");
  await api.send("POST", "/tags", { name: "reading" });
  await api.send("POST", "/lenses", { name: "Worth reading?", type: "noul", question: "Is this worth reading?" });
  for (const url of all) await api.send("POST", "/links", { url });
  const links = await check(
    "API: all seven links settled",
    async () => {
      const found = await Promise.all(all.map((u) => api.link(u)));
      return found.every((l) => l && !l.processing) && found;
    },
    { timeout: 60_000 },
  );
  const withContent = links.filter((l) => l.content_key).length;
  await check("API: the four articles have content, the others none", () => withContent === 4);
  await page.reload();

  const bar = page.getByLabel("Selected link actions");
  const countButton = (n: number) => bar.getByRole("button", { name: `${n} selected` });
  const rowBox = (title: string) => page.getByRole("checkbox", { name: `Select ${title}` });

  // Row by row, so the journey also works on an instance that already holds other links.
  const selectSeven = async () => {
    for (const l of links) {
      await check(`Row "${l.title}" is listed`, () => rowBox(l.title).isVisible());
      if (!(await rowBox(l.title).isChecked())) await rowBox(l.title).click();
    }
  };

  await step("Select the seven links");
  await selectSeven();
  await check("Bar shows 7 selected", () => countButton(7).isVisible());
  const autotag = bar.getByRole("button", { name: /^Auto-tag/ });
  const lens = bar.getByRole("button", { name: /^Lens/ });
  const open = bar.getByRole("button", { name: /^Open/ });
  await check("Auto-tag shows 4/7 and its key T", async () => /4\/7/.test((await autotag.textContent()) ?? "") && /T$/.test((await autotag.textContent()) ?? ""));
  await check("Lens shows 4/7 and its key L", async () => /4\/7/.test((await lens.textContent()) ?? "") && /L$/.test((await lens.textContent()) ?? ""));
  await check("Open reads Open 7 with no badge and its key O", async () => {
    const t = (await open.textContent()) ?? "";
    return /^Open 7/.test(t) && !t.includes("/") && /O$/.test(t);
  });
  await check("Extract context is not on the bar: it lives in the palette and on E", () => bar.getByRole("button", { name: /^Extract context/ }).count().then((n) => n === 0));
  await check("More ⌘K and Clear are on the bar", async () => (await bar.getByRole("button", { name: /^More/ }).isVisible()) && (await bar.getByRole("button", { name: "Clear selection" }).isVisible()));
  await autotag.hover();
  await check("Tooltip says why only 4 qualify", () => page.getByRole("tooltip").getByText("3 of 7 links have no content yet").isVisible());
  await snap("01-bar-seven-selected");

  await step("Open: this instance has no extension, so it is blocked with its reason and O does nothing");
  await check("Open is disabled", () => open.isDisabled());
  // The disabled button swallows pointer events, so hover the span the tooltip is attached to. Radix ignores
  // pointer moves for a moment after leaving another trigger, so leave the Auto-tag one first and give it time.
  await page.mouse.move(600, 300, { steps: 8 });
  await page.waitForTimeout(1000);
  const openBox = (await open.locator("xpath=..").boundingBox())!;
  await page.mouse.move(openBox.x + openBox.width / 2, openBox.y + openBox.height / 2, { steps: 8 });
  const openTip = await check("Tooltip gives the extension reason", async () => {
    const tips = await page.getByRole("tooltip").allTextContents();
    return tips.find((t) => /extension|Chrome/.test(t)) ?? false;
  });
  await note("open-blocked-reason", openTip);
  await page.mouse.move(0, 0);
  await page.keyboard.press("o");
  await page.waitForTimeout(500);
  await check("Nothing happened: no toast, still 7 selected, no dialog", async () => (await page.locator("[data-sonner-toast]").count()) === 0 && (await countButton(7).isVisible()) && !(await page.getByRole("dialog").isVisible()));

  await step("Count menu: Escape closes it and keeps the selection");
  await countButton(7).click();
  const menu = page.getByRole("menu");
  await check("Menu offers Select all N visible and Clear selection", async () => (await menu.getByRole("menuitem", { name: /^Select all \d+ visible$/ }).isVisible()) && (await menu.getByRole("menuitem", { name: "Clear selection" }).isVisible()));
  await snap("02-count-menu");
  await page.keyboard.press("Escape");
  await check("Menu closed", async () => !(await menu.isVisible()));
  await check("Still 7 selected", () => countButton(7).isVisible());

  await step("⌘K opens the palette with no vertical scrollbar");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Bulk actions" });
  await check("Palette is open", () => palette.isVisible());
  const list = palette.getByRole("listbox");
  const overflow = await check("Palette list fits without scrolling", async () => {
    const m = await list.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    return m.scrollHeight <= m.clientHeight && m;
  });
  await note("palette-list-metrics", overflow);
  await check("Rows: Auto-tag 4/7 with its skip reason, Extract 7/7, Open with its blocked reason, Copy URLs, Copy URLs + titles", async () => {
    const row = (name: string) => palette.getByRole("option", { name: new RegExp(`^${name}`) });
    return (
      /4\/7/.test((await row("Auto-tag").textContent()) ?? "") &&
      /3 of 7 links have no content yet/.test((await row("Auto-tag").textContent()) ?? "") &&
      /7\/7/.test((await row("Extract context").textContent()) ?? "") &&
      /extension|Chrome/.test((await row("Open").textContent()) ?? "") &&
      (await row("Copy URLs").first().isVisible()) &&
      (await row("Copy URLs \\+ titles").isVisible())
    );
  });
  await check("Groups sit in a gutter: Process and Share are labelled", async () => (await palette.getByText("Process", { exact: true }).isVisible()) && (await palette.getByText("Share", { exact: true }).isVisible()));
  await snap("03-palette");
  await page.keyboard.type("ag");
  await check("Typing filters the actions", async () => (await palette.getByRole("option", { name: /^Auto-tag/ }).isVisible()) && !(await palette.getByRole("option", { name: /^Lens/ }).isVisible()));
  await snap("04-palette-filtered");

  await step("The lens sub-page lists lenses and New lens…, and picking one runs it");
  await page.keyboard.press("Escape");
  await check("Palette closed", async () => !(await palette.isVisible()));
  await check("Selection kept", () => countButton(7).isVisible());
  await page.keyboard.press("ControlOrMeta+k");
  await check("Palette reopened", () => palette.isVisible());
  await page.keyboard.press("l");
  await check("Lens page offers New lens…", () => palette.getByRole("option", { name: "New lens…" }).isVisible());
  await check("Lens page lists Worth reading?", () => palette.getByRole("option", { name: /Worth reading\?/ }).isVisible());
  await snap("05-palette-lens-page");
  await palette.getByRole("option", { name: /Worth reading\?/ }).click();
  await check("API: a lens batch started for the links with content", async () => (await api.library()).batches.find((b) => b.kind === "lens" && b.total === 4));
  await check("Palette closed", async () => !(await palette.isVisible()));
  await check("Selection cleared after the lens run, as the button always did", async () => !(await bar.isVisible()));
  await check("API: the lens batch settles", async () => (await api.library()).batches.filter((b) => b.kind === "lens").every((b) => b.active === 0), { timeout: 60_000 });
  await selectSeven();
  await check("Seven selected again", () => countButton(7).isVisible());

  await step("Shortcuts are ignored while typing in search");
  await page.keyboard.press("/");
  await page.keyboard.type("te");
  await check("Search holds the typed letters and no dialog opened", async () => (await page.getByPlaceholder("Search").inputValue()) === "te" && !(await page.getByRole("alertdialog").isVisible()));
  await page.getByPlaceholder("Search").fill("");
  await page.getByPlaceholder("Search").blur();

  await step("Press E: the same confirm as the button, then extraction starts");
  await page.keyboard.press("e");
  const confirm = page.getByRole("alertdialog", { name: "Extract context for 7 links?" });
  await check("Extract confirm dialog opened", () => confirm.isVisible());
  await snap("06-extract-confirm");
  const before = (await api.library()).batches.length;
  await confirm.getByRole("button", { name: "Extract", exact: true }).click();
  const batch = await check(
    "API: an extract batch of 7 links exists",
    async () => (await api.library()).batches.find((b) => b.kind === "extract" && b.total === 7),
  );
  await check("API: exactly one new batch", async () => (await api.library()).batches.length === before + 1);
  const settled = await check(
    "API: the batch settles with the 3 impossible links failed",
    async () => {
      const b = (await api.library()).batches.find((x) => x.id === batch.id);
      return b && b.active === 0 && b.failed === 3 && b;
    },
    { timeout: 90_000 },
  );

  await step("The results card lists the failed links");
  const failedJobs = ((await api.get(`/batches/${settled.id}`)).jobs as { status: string; link_id: string; title: string }[]).filter((j) => j.status === "failed");
  const failedIds = new Set(failedJobs.map((j) => j.link_id));
  await check("API: the failed jobs are the three broken links", () => failedIds.size === 3 && links.filter((l) => failedIds.has(l.id)).every((l) => !l.content_key));
  const card = page.getByRole("region", { name: "Extract context results" });
  await check("Card says 3 of 7 failed", () => card.getByText("3 of 7 failed").isVisible());
  await check("Card names each failed link with a reason", async () => {
    for (const j of failedJobs) if (!(await card.getByText(j.title, { exact: true }).isVisible())) return false;
    return (await card.locator("li").count()) === 3;
  });
  await check("The bar is gone: the extracted links were deselected", async () => !(await bar.isVisible()));
  await snap("07-results-card");

  await step("Select failed re-selects exactly the failed links");
  await card.getByRole("button", { name: "Select failed" }).click();
  await check("Bar shows 3 selected", () => countButton(3).isVisible());
  await check("Card is dismissed", async () => !(await card.isVisible()));
  await check("Exactly the failed links are checked", async () => {
    for (const l of links) {
      const checked = await rowBox(l.title).isChecked();
      if (checked !== failedIds.has(l.id)) return false;
    }
    return true;
  });
  await snap("08-select-failed");

  await step("Escape on an open menu keeps the selection");
  await countButton(3).click();
  await check("Menu open", () => menu.isVisible());
  await page.keyboard.press("Escape");
  await check("Menu closed", async () => !(await menu.isVisible()));
  await check("Still 3 selected", () => countButton(3).isVisible());

  await step("⌘K with nothing selected is still Add link");
  await bar.getByRole("button", { name: "Clear selection" }).click();
  await check("Bar is gone", async () => !(await bar.isVisible()));
  await page.keyboard.press("ControlOrMeta+k");
  await check("Add link dialog opened", () => page.getByRole("dialog", { name: "Add link" }).isVisible());
  await check("No palette", async () => !(await palette.isVisible()));
  await snap("09-add-link-with-no-selection");
  await page.keyboard.press("Escape");

  await snap("10-done");
}) satisfies Journey;
