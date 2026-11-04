// command-palette: ⌘K opens one Commands palette in All links and Browser, with 0, 1 and 2 selected, on desktop
// and phone; dialogs and fields don't stack a second one; Browser's paste opens tabs instead of saving.
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

  await step("Guards: ⌘K right after Escape and from the search field opens it; ⌘K inside the Add link dialog does nothing");
  await page.getByPlaceholder("Search").first().focus();
  await page.keyboard.press("ControlOrMeta+k");
  await check("From a field, while the last palette was still closing: the palette, with its filter focused", async () =>
    (await onlyPalette()) && (await palette.getByRole("combobox").evaluate((el) => el === document.activeElement)));
  await page.keyboard.type("add");
  await page.keyboard.press("Enter");
  const add = page.getByRole("dialog", { name: "Add link" });
  await check("Enter on Add links: only the Add link dialog", async () => (await add.isVisible()) && (await dialogNames()).length === 1);
  await check("Add link's primary button says Save to Library", () => add.getByRole("button", { name: /^Save to Library/ }).isVisible());
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("t");
  await page.waitForTimeout(400);
  await check("⌘K and T inside the dialog: still only Add link, the T typed into it", async () => {
    const names = await dialogNames();
    return names.length === 1 && names[0] === "Add link" && (await add.getByRole("textbox").inputValue()) === "t" && names;
  });
  await snap("after-04-add-link-guards");
  await page.keyboard.press("Escape");
  await check("Escape closes Add link", async () => !(await add.isVisible()));

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
  await snap("after-06-phone-two-drawer");
  await page.keyboard.press("Escape");
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

  await step("Browser: pasting a URL opens Open links prefilled and saves nothing");
  const pasted = fixture("article", "pasted-in-browser");
  const before = (await api.library()).links.length;
  await page.evaluate((url) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", url);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, pasted);
  const dialog = page.getByRole("dialog", { name: "Open links" });
  await check("Open links dialog with the URL", async () => (await dialog.isVisible()) && (await dialog.getByRole("textbox", { name: "Links to open" }).inputValue()) === pasted);
  await check("It says nothing is saved", async () => /Nothing is saved to your Library/.test((await dialog.textContent()) ?? ""));
  await check("Open is disabled with the extension's reason", async () => (await dialog.getByRole("button", { name: /^Open/ }).isDisabled()) && /extension/i.test((await dialog.getByRole("alert").textContent()) ?? ""));
  await snap("after-08-browser-paste-open-links");
  await page.waitForTimeout(1500);
  const after = (await api.library()).links.length;
  await check("API: nothing was saved to the Library", async () => after === before && !(await api.link(pasted)));
  await note("browser-paste", { before, after });
  await step("Browser: a paste while a Browser dialog is open doesn't replace it");
  await page.getByRole("button", { name: "Close" }).focus();
  await page.evaluate((url) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", url);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, fixture("article", "second-paste"));
  await page.waitForTimeout(500);
  await check("The dialog keeps the first URL", async () => (await dialog.isVisible()) && (await dialog.getByRole("textbox", { name: "Links to open" }).inputValue()) === pasted);
  await page.keyboard.press("Escape");
}) satisfies Journey;
