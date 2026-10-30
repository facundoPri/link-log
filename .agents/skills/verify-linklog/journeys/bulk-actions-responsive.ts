// bulk-actions-responsive: the narrow chip (900x820) and the mobile bar with its bottom drawer (390x844).
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  // Bars, sheets and popovers animate in; a screenshot taken mid-animation shows half-drawn controls.
  const snap = async (name: string) => {
    await page.waitForTimeout(600);
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
  await check("API: the four articles have content, the others none", () => links.filter((l) => l.content_key).length === 4);
  const visible = (await api.library()).links.length;
  const bar = page.getByLabel("Selected link actions");
  const rowBox = (title: string) => page.getByRole("checkbox", { name: `Select ${title}` });
  const selectSeven = async () => {
    for (const l of links) {
      await check(`Row "${l.title}" is listed`, () => rowBox(l.title).isVisible());
      if (!(await rowBox(l.title).isChecked())) await rowBox(l.title).click();
    }
  };

  await step("Narrow 900x820: a chip replaces the bar");
  await page.setViewportSize({ width: 900, height: 820 });
  await page.reload();
  await selectSeven();
  await check("Chip says 7 selected with Actions ⌘K and Clear", async () => /7 selected/.test((await bar.textContent()) ?? "") && (await bar.getByRole("button", { name: /^Actions/ }).isVisible()) && (await bar.getByRole("button", { name: "Clear selection" }).isVisible()));
  await check("No desktop buttons on the chip", async () => (await bar.getByRole("button", { name: /^Auto-tag/ }).count()) === 0);
  await snap("01-narrow-chip");
  await bar.getByRole("button", { name: /^Actions/ }).click();
  const palette = page.getByRole("dialog", { name: "Bulk actions" });
  await check("The chip opens the compact palette", () => palette.isVisible());
  await check("Palette rows carry counts: Auto-tag 4/7, Extract context 7/7", async () => /4\/7/.test((await palette.getByRole("option", { name: /^Auto-tag/ }).textContent()) ?? "") && /7\/7/.test((await palette.getByRole("option", { name: /^Extract context/ }).textContent()) ?? ""));
  const overflow = await check("Palette list fits without scrolling", async () => {
    const m = await palette.getByRole("listbox").evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }));
    return m.scrollHeight <= m.clientHeight && m;
  });
  await note("narrow-palette-metrics", overflow);
  await snap("02-narrow-palette");
  await page.keyboard.press("Escape");
  await check("Escape closes the palette and keeps the selection", async () => !(await palette.isVisible()) && /7 selected/.test((await bar.textContent()) ?? ""));
  await bar.getByRole("button", { name: "Clear selection" }).click();
  await check("Chip is gone after Clear", async () => !(await bar.isVisible()));

  await step("Narrow: a blocked action's key says why");
  await selectSeven();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("o");
  await check("Toast gives Open's reason (this instance has no extension)", async () => (await page.locator("[data-sonner-toast]").filter({ hasText: /extension|Chrome/ }).count()) > 0);
  await check("Still 7 selected", async () => /7 selected/.test((await bar.textContent()) ?? ""));
  await snap("03-narrow-blocked-key");
  await bar.getByRole("button", { name: "Clear selection" }).click();

  await step("Mobile 390x844: the bar offers Select all N");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await check("Row checkbox is visible", () => rowBox(links[0]!.title).isVisible());
  await rowBox(links[0]!.title).click();
  await check("Bar shows 1 selected and Select all N", async () => /1 selected/.test((await bar.textContent()) ?? "") && (await bar.getByRole("button", { name: new RegExp(`Select all ${visible}$`) }).isVisible()));
  await snap("04-mobile-bar");
  const targets = await check("Bar buttons are at least 44px tall", async () => {
    const boxes = await bar.getByRole("button").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    return boxes.every((h) => h >= 44) && boxes;
  });
  await note("mobile-bar-target-heights", targets);
  await bar.getByRole("button", { name: new RegExp(`Select all ${visible}$`) }).click();
  await check("Every visible link is selected", async () => {
    for (const l of links) if (!(await rowBox(l.title).isChecked())) return false;
    return true;
  });
  await check("Bar now says All N selected · Deselect all", async () => new RegExp(`All ${visible} selected · Deselect all`).test((await bar.textContent()) ?? ""));
  await snap("05-mobile-bar-all");

  await step("Actions opens the bottom drawer");
  await bar.getByRole("button", { name: /^Actions/ }).click();
  const drawer = page.getByRole("dialog");
  await check("Drawer is open and titled with the count", () => drawer.getByText(`${visible} selected`, { exact: true }).isVisible());
  await check("No Select all in the header: everything is selected", async () => (await drawer.getByRole("button", { name: /^Select all/ }).count()) === 0);
  const tiles = await check("Tiles for every registry action", async () => {
    const names = ["Auto-tag", "Lens", "Extract", "Open", "Copy URLs", "Copy URLs + titles"];
    for (const n of names) if (!(await drawer.getByRole("button", { name: new RegExp(`^${n.replace("+", "\\+")}( \\d+/\\d+)?$`) }).isVisible())) return false;
    return names;
  });
  await note("drawer-tiles", tiles);
  await check("Auto-tag tile shows 4/7 when partial", async () => /4\/7/.test((await drawer.getByRole("button", { name: /^Auto-tag/ }).textContent()) ?? ""));
  await check("The counts are explained in one line", () => drawer.getByText(/Numbers show how many of the 7 selected links each action can run on/).isVisible());
  const grid = await check("4-column grid, the last tile fills its row, tiles at least 44px", async () => {
    const m = await drawer.locator(".grid").evaluate((el) => {
      const kids = [...el.children].map((c) => c.getBoundingClientRect());
      const g = el.getBoundingClientRect();
      const rows = [...new Set(kids.map((k) => Math.round(k.top)))];
      const lastRow = kids.filter((k) => Math.round(k.top) === rows[rows.length - 1]);
      return {
        columns: getComputedStyle(el).gridTemplateColumns.split(" ").length,
        lastRowRight: Math.round(Math.max(...lastRow.map((k) => k.right))),
        gridRight: Math.round(g.right),
        minHeight: Math.round(Math.min(...kids.map((k) => k.height))),
      };
    });
    return m.columns === 4 && m.lastRowRight === m.gridRight && m.minHeight >= 44 && m;
  });
  await note("drawer-grid", grid);
  const scroll = await check("Drawer content needs no vertical scroll", async () => {
    const m = await drawer.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, bottomGap: Math.round(window.innerHeight - el.getBoundingClientRect().bottom) }));
    return m.scrollHeight <= m.clientHeight && m;
  });
  await note("drawer-scroll", scroll);
  await snap("06-mobile-drawer");

  await step("Open's tile is blocked here; tapping it toasts the reason");
  // Playwright waits for "enabled" and treats aria-disabled as disabled, but a real tap goes through.
  await drawer.getByRole("button", { name: /^Open/ }).click({ force: true });
  await check("Toast gives the reason and the drawer stays", async () => (await page.locator("[data-sonner-toast]").filter({ hasText: /extension|Chrome/ }).count()) > 0 && (await drawer.isVisible()));

  await step("The lens tile opens the picker in place, with a back control");
  await drawer.getByRole("button", { name: /^Lens/ }).click();
  await check("Picker lists Worth reading? and New lens…", async () => (await drawer.getByRole("button", { name: /Worth reading\?/ }).isVisible()) && (await drawer.getByRole("button", { name: "New lens…" }).isVisible()));
  await check("Same dialog, tiles replaced", async () => (await drawer.getByRole("button", { name: /^Copy URLs/ }).count()) === 0);
  await snap("07-mobile-lens-picker");
  await drawer.getByRole("button", { name: "Back to actions" }).click();
  await check("Back returns to the tiles", () => drawer.getByRole("button", { name: /^Extract/ }).isVisible());

  await step("Escape closes the drawer and keeps the selection");
  await page.keyboard.press("Escape");
  await check("Drawer closed", async () => !(await drawer.isVisible()));
  await check("Selection kept", async () => new RegExp(`All ${visible} selected`).test((await bar.textContent()) ?? ""));

  await step("Extract from the drawer: progress shows in the bar");
  await bar.getByRole("button", { name: /^Actions/ }).click();
  await drawer.getByRole("button", { name: /^Extract/ }).click();
  const confirm = page.getByRole("alertdialog", { name: `Extract context for ${visible} links?` });
  await check("The Extract confirm dialog is the same one as on desktop", () => confirm.isVisible());
  await snap("08-mobile-extract-confirm");
  await confirm.getByRole("button", { name: "Extract", exact: true }).click();
  const batch = await check("API: an extract batch started", async () => (await api.library()).batches.find((b) => b.kind === "extract" && b.total === visible));
  await check("The bar reports Extracting n/N", () => bar.getByText(new RegExp(`Extracting \\d+/${visible}`)).isVisible(), { timeout: 5_000 }).catch(() => note("progress-missed", "the batch settled before the bar was polled"));
  await shot("09-mobile-running");
  await check("API: the batch settles with the 3 impossible links failed", async () => {
    const b = (await api.library()).batches.find((x) => x.id === batch.id);
    return b && b.active === 0 && b.failed === 3 && b;
  }, { timeout: 90_000 });

  await step("After the run the bar stays with Details");
  await check("Selection cleared, bar reports the run", async () => (await bar.getByText(`Extract context: 3 of ${visible} failed`).isVisible()) && (await bar.getByRole("button", { name: "Details" }).isVisible()));
  await snap("10-mobile-done");
  await bar.getByRole("button", { name: "Details" }).click();
  const failedJobs = ((await api.get(`/batches/${batch.id}`)).jobs as { status: string; link_id: string; title: string }[]).filter((j) => j.status === "failed");
  const card = page.getByRole("region", { name: "Extract context results" });
  await check("Details lists the three failed links", async () => {
    for (const j of failedJobs) if (!(await card.getByText(j.title, { exact: true }).isVisible())) return false;
    return failedJobs.length === 3;
  });
  await snap("11-mobile-details");
  await card.getByRole("button", { name: "Select failed" }).click();
  const failedIds = new Set(failedJobs.map((j) => j.link_id));
  await check("Select failed selects exactly the failed links", async () => {
    for (const l of links) if ((await rowBox(l.title).isChecked()) !== failedIds.has(l.id)) return false;
    return /3 selected/.test((await bar.textContent()) ?? "");
  });
  await snap("12-mobile-select-failed");
  await bar.getByRole("button", { name: "Clear selection" }).click();
  await check("Bar is gone", async () => !(await bar.isVisible()));
}) satisfies Journey;
