// command-palette: ⌘K opens one Commands palette in All links and Browser, with 0, 1 and 2 selected, on desktop
// and phone; links pasted anywhere, or into its input, open its links page (All links: save with tags; Browser:
// open as tabs, never saved).
// Browser here has no extension: real tabs are proven by `bun run test:browser`.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  const snap = async (name: string) => {
    await page.waitForTimeout(500);
    await shot(name);
  };
  const urls = ["one", "two", "three"].map((p) => fixture("article", p));
  for (const url of urls) await api.send("POST", "/links", { url });
  const links = await check(
    "API: three links ready",
    async () => {
      const found = await Promise.all(urls.map((u) => api.link(u)));
      return found.every((l) => l && !l.processing) && found;
    },
    { timeout: 60_000 },
  );
  await page.reload();
  const box = (t: string) => page.getByRole("checkbox", { name: `Select ${t}` }).first();
  const palette = page.getByRole("dialog", { name: "Commands" });
  const dialogNames = () =>
    page.getByRole("dialog").evaluateAll((els) => els.map((e) => e.querySelector("h2")?.textContent ?? e.getAttribute("aria-label") ?? "?"));
  const onlyPalette = async () => {
    const names = await dialogNames();
    return names.length === 1 && (await palette.isVisible()) && names;
  };
  const option = (name: RegExp) => palette.getByRole("option", { name });

  await step("All links, nothing selected: ⌘K opens the palette with Add links, not the Add link dialog");
  await check("Rows listed", () => box(links[0].title).isVisible());
  await page.keyboard.press("ControlOrMeta+k");
  await note("library-none-dialogs", await check("Exactly one dialog: Commands", onlyPalette));
  await check("Only the view's commands: Add links… and Select all", async () => (await option(/^Add links…/).isVisible()) && (await option(/^Select all \d+ visible/).isVisible()) && (await option(/^Auto-tag/).count()) === 0);
  await check("Add links says it saves to the Library", async () => /Save to your Library/.test((await option(/^Add links…/).textContent()) ?? ""));
  await snap("after-01-library-none-cmdk-palette");
  await page.keyboard.press("ControlOrMeta+k");
  await check("⌘K again closes it", async () => !(await palette.isVisible()));

  await step("All links, one and two selected: the same palette, with the actions first");
  await box(links[0].title).click();
  await page.keyboard.press("ControlOrMeta+k");
  await check("One selected: exactly one dialog", onlyPalette);
  await check("Actions and commands are listed", async () => (await option(/^Auto-tag/).isVisible()) && (await option(/^Add links…/).isVisible()));
  await snap("after-02-library-one-cmdk-palette");
  await page.keyboard.press("Escape");
  await check("Escape closes the palette and keeps the selection", async () => !(await palette.isVisible()) && (await box(links[0].title).isChecked()));
  await box(links[1].title).click();
  await page.keyboard.press("ControlOrMeta+k");
  await check("Two selected: exactly one dialog", onlyPalette);
  await check("Header says 2 selected", async () => /Acting on 2 selected/.test((await palette.textContent()) ?? ""));
  await snap("after-03-library-two-cmdk-palette");
  await page.keyboard.press("Escape");

  await step("Guards: ⌘K from the search field opens it; a paste into its input opens the links page; keys type there");
  await page.getByPlaceholder("Search").first().focus();
  await page.keyboard.press("ControlOrMeta+k");
  await check("From a field, while the last palette was still closing: the palette, with its filter focused", async () =>
    (await onlyPalette()) && (await palette.getByRole("combobox").evaluate((el) => el === document.activeElement)));
  const tagged = [fixture("article", "tagged-1"), fixture("article", "tagged-2")];
  await palette.getByRole("combobox").evaluate((el, list) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", list.join("\n"));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, tagged);
  const save = option(/^Save 2 links to Library/);
  await check("Pasting two links into the palette: still one dialog, now its links page with Save first", async () =>
    (await onlyPalette()) && (await save.isVisible()) && (await save.getAttribute("aria-selected")) === "true" && /2 links/.test((await palette.textContent()) ?? ""));
  await page.keyboard.type("t");
  await page.waitForTimeout(300);
  await check("T types into the tag filter instead of running Auto-tag", async () => (await palette.getByRole("combobox").inputValue()) === "t" && (await onlyPalette()));
  await page.keyboard.press("Backspace");
  await page.keyboard.type("someday");
  await check("A new tag name offers Create tag", () => option(/^Create tag “someday”/).isVisible());
  await page.keyboard.press("Enter");
  await check("Picked: the Save row names it", async () => /someday/.test((await save.textContent()) ?? ""));
  await snap("after-04-links-page-tagged");
  await page.keyboard.press("Enter");
  await check("Enter saves and closes", async () => (await dialogNames()).length === 0);
  await check(
    "API: both links saved with the new tag",
    async () => {
      const found = await Promise.all(tagged.map((u) => api.link(u)));
      return found.every((l) => l?.tags?.some((t: { name: string }) => t.name === "someday")) && found.map((l) => l.tags.map((t: { name: string }) => t.name));
    },
    { timeout: 15_000 },
  );

  await step("Select all from the palette keeps it open on the new selection");
  await page.keyboard.press("Escape");
  await check("Selection cleared", async () => !(await box(links[0].title).isChecked()));
  await page.keyboard.press("ControlOrMeta+k");
  await check("Palette with no selection", onlyPalette);
  await option(/^Select all \d+ visible/).click();
  await check("Still open, now acting on every visible link", async () => (await onlyPalette()) && /Acting on \d+ selected/.test((await palette.textContent()) ?? "") && (await option(/^Extract context/).isVisible()));
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await step("Phone 390: none selected opens the palette, a selection opens the drawer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await check("Phone rows listed", () => page.getByText(links[0].title).first().isVisible());
  await page.keyboard.press("ControlOrMeta+k");
  await check("Phone, none: the palette", onlyPalette);
  await snap("after-05-phone-none-palette");
  await page.keyboard.press("Escape");
  await box(links[0].title).click({ force: true });
  await box(links[1].title).click({ force: true });
  await page.keyboard.press("ControlOrMeta+k");
  await check("Phone, two: the drawer, not the palette", async () => {
    const names = await dialogNames();
    return names.length === 1 && !(await palette.isVisible()) && (await page.getByRole("dialog", { name: "2 selected" }).isVisible()) && names;
  });
  const drawer = page.getByRole("dialog", { name: "2 selected" });
  await check("Phone drawer lists the view's commands: Add links…", () => drawer.getByRole("button", { name: /^Add links…/ }).isVisible());
  await snap("after-06-phone-two-drawer");
  await drawer.getByRole("button", { name: /^Add links…/ }).click();
  await check("Add links from the drawer: the palette's links page replaces the drawer", async () =>
    (await onlyPalette()) && (await palette.getByPlaceholder("Paste or type links…").isVisible()));
  await page.keyboard.press("Escape");
  await check("Links page closed", async () => (await dialogNames()).length === 0);
  await page.setViewportSize({ width: 1280, height: 820 });

  await step("Browser without the extension: ⌘K opens the same palette with Open links");
  await page.reload();
  await check("Desktop rows listed", () => box(links[0].title).isVisible());
  await page.getByRole("button", { name: /^Browser/ }).first().click();
  await check("Browser view", () => page.getByRole("heading", { name: /^Browser/ }).isVisible());
  await page.keyboard.press("ControlOrMeta+k");
  await note("browser-none-dialogs", await check("Browser: exactly one dialog, Commands", onlyPalette));
  const open = option(/^Open links…/);
  await check("Open links is listed and disabled with the extension's reason", async () => (await open.isVisible()) && (await open.getAttribute("aria-disabled")) === "true" && /extension/i.test((await open.textContent()) ?? ""));
  await check("No Library save command in Browser", async () => (await option(/^Add links…/).count()) === 0);
  await snap("after-07-browser-none-palette");
  await page.keyboard.press("Escape");

  await step("Browser: pasting a URL opens the links page with Open, and saves nothing");
  const pasted = fixture("article", "pasted-in-browser");
  const before = (await api.library()).links.length;
  const paste = (url: string) =>
    page.evaluate((u) => {
      const dt = new DataTransfer();
      dt.setData("text/plain", u);
      window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    }, url);
  await paste(pasted);
  const openRow = option(/^Open 1 tab/);
  await check("The palette's links page with the URL and Open 1 tab", async () => (await onlyPalette()) && (await openRow.isVisible()) && ((await palette.textContent()) ?? "").includes(pasted));
  await check("It says nothing is saved", async () => /Nothing is saved to your Library/.test((await palette.textContent()) ?? ""));
  await check("Open is disabled with the extension's reason", async () => (await openRow.getAttribute("aria-disabled")) === "true" && /extension/i.test((await palette.getByRole("alert").textContent()) ?? ""));
  await snap("after-08-browser-paste-links-page");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  const after = (await api.library()).links.length;
  await check("API: nothing was saved to the Library, even after Enter", async () => after === before && !(await api.link(pasted)));
  await note("browser-paste", { before, after });

  await step("Browser: a paste or drop outside the open palette doesn't replace its links");
  await paste(fixture("article", "second-paste"));
  await page.waitForTimeout(500);
  const keepsFirst = async () => (await onlyPalette()) && ((await palette.textContent()) ?? "").includes(pasted) && !/2 links/.test((await palette.textContent()) ?? "");
  await check("A window paste keeps the first URL", keepsFirst);
  const drop = (selector: string, url: string) =>
    page.evaluate(
      ([sel, u]) => {
        const dt = new DataTransfer();
        dt.setData("text/uri-list", u);
        dt.setData("text/plain", u);
        const target = document.querySelector(sel)!;
        target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
        const ev = new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true });
        target.dispatchEvent(ev);
        return ev.defaultPrevented;
      },
      [selector, url] as const,
    );
  const outside = await drop("h1, h2", fixture("article", "dropped-outside"));
  await page.waitForTimeout(500);
  await check("A drop outside the palette keeps the first URL, and the page doesn't navigate", async () => outside && (await keepsFirst()));
  await page.keyboard.press("Escape");
  await check("Palette closed", async () => (await dialogNames()).length === 0);
  const dropped = fixture("article", "dropped-no-dialog");
  await drop("h1, h2", dropped);
  await check("With nothing open, a drop opens the links page with it", async () => (await onlyPalette()) && ((await palette.textContent()) ?? "").includes(dropped));
  await page.keyboard.press("Escape");
}) satisfies Journey;
