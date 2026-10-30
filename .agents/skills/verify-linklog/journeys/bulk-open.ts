import type { Page } from "playwright-core";
import type { Journey } from "../scripts/journey";

type FakeMode = { caps: string[]; open: "partial" | "disconnect-once" };

function fakeBridge() {
  const raw = sessionStorage.getItem("fakeBridge");
  if (!raw) return;
  const mode: FakeMode = JSON.parse(raw);
  const log: { operationId: string; urls: string[] }[] = JSON.parse(sessionStorage.getItem("fakeOpenLog") || "[]");
  const opened = new Set(log.flatMap((l) => l.urls));
  // Init scripts can run before <html> exists.
  const mark = () => (document.documentElement.dataset.linklogBridge = "1");
  if (document.documentElement) mark();
  else document.addEventListener("DOMContentLoaded", mark);
  const post = (body: Record<string, unknown>) => window.postMessage({ channel: "linklog-bridge", from: "extension", ...body }, location.origin);
  const reply = (id: string, result: unknown) => post({ response: { id, ok: true, result } });
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.channel !== "linklog-bridge" || data.from !== "page") return;
    const { id, command, args } = data.request;
    if (command === "hello")
      return reply(id, { protocol: 2, extensionVersion: "fake", installationId: "fake", browserSessionId: "fake", windowId: 1, capabilities: mode.caps, contentAccess: true });
    if (command === "snapshot") return reply(id, { revision: 1, windowId: 1, tabs: [], groups: [], linklogTabs: 1 });
    if (command === "results") return reply(id, { results: {} });
    if (command === "pending") return reply(id, { requests: [] });
    if (command !== "openTabs") return reply(id, {});
    log.push(args);
    sessionStorage.setItem("fakeOpenLog", JSON.stringify(log));
    if (mode.open === "disconnect-once" && log.length === 1) {
      for (const url of args.urls) opened.add(url);
      return post({ disconnected: true });
    }
    reply(id, {
      items: args.urls.map((url: string, i: number) =>
        opened.has(url) || mode.open === "disconnect-once" || i === 0
          ? (opened.add(url), { url, outcome: "opened" })
          : { url, outcome: "failed", error: "Chrome refused the URL." },
      ),
    });
  });
}

export default (async ({ page, api, fixture, step, check, shot, aria, note }) => {
  const urls = [fixture("article", "one"), fixture("article", "two")];
  await page.addInitScript(fakeBridge);
  const setMode = async (mode: FakeMode | null) => {
    await page.evaluate((m) => {
      sessionStorage.removeItem("fakeOpenLog");
      if (m) sessionStorage.setItem("fakeBridge", JSON.stringify(m));
      else sessionStorage.removeItem("fakeBridge");
    }, mode);
    await page.reload();
    await note(`bridge-${mode ? mode.open : "none"}`, await page.evaluate(() => ({ marker: document.documentElement.dataset.linklogBridge ?? null, mode: sessionStorage.getItem("fakeBridge") })));
  };
  const bar = page.locator('[aria-label="Selected link actions"]');
  const open = bar.getByRole("button", { name: "Open", exact: true });
  const selectBoth = async (p: Page) => {
    for (const link of links) await p.getByRole("checkbox", { name: `Select ${link.title}` }).check();
    await check("Selection bar shows 2 selected", () => bar.getByText("2 selected").isVisible());
  };
  const tooltipFor = async (text: RegExp) => {
    await open.locator("xpath=..").hover();
    return check(`Tooltip explains: ${text}`, () => page.getByRole("tooltip").filter({ hasText: text }).first().isVisible());
  };

  await step("Seed two saved links");
  for (const url of urls) await api.send("POST", "/links", { url });
  const links = await check(
    "API: both links are ready",
    async () => {
      const all = await Promise.all(urls.map((u) => api.link(u)));
      return all.every((l) => l && !l.processing && l.status === "ready") && all;
    },
    { timeout: 60_000 },
  );

  await step("No extension: Open is disabled and says why; other bulk actions are unchanged");
  await page.reload();
  await selectBoth(page);
  await check("Open is disabled once the missing extension is detected", () => open.isDisabled(), { timeout: 10_000 });
  await tooltipFor(/Install or enable the Linklog extension/);
  for (const name of ["Auto-tag", "Lens", "More"])
    await check(`"${name}" is still in the bar`, () => bar.getByRole("button", { name: new RegExp(`^${name}`) }).isVisible());
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Bulk actions" });
  await check("Palette rows Extract context and Copy URLs are still enabled", async () => {
    const enabled = async (name: string) => (await palette.getByRole("option", { name: new RegExp(`^${name}`) }).first().getAttribute("aria-disabled")) !== "true";
    return (await enabled("Extract context")) && (await enabled("Copy URLs"));
  });
  await check("Palette row Open is disabled with the reason", async () => {
    const row = palette.getByRole("option", { name: /^Open/ }).first();
    return (await row.getAttribute("aria-disabled")) === "true" && /Install or enable the Linklog extension/.test((await row.textContent()) ?? "");
  });
  await page.keyboard.press("Escape");
  await shot("01-no-extension");
  await aria("01-no-extension");

  await step("Extension without the open capability (older build): Open asks for an update");
  await setMode({ caps: ["tabs", "groups", "lenses", "capture", "save", "close", "forget"], open: "partial" });
  await selectBoth(page);
  await tooltipFor(/Update the Linklog extension/);
  await check("Open is disabled", () => open.isDisabled());
  await shot("02-outdated");

  await step("Partial failure: one opens, one fails, the toast names the failure, selection is kept");
  await setMode({ caps: ["tabs", "open"], open: "partial" });
  await selectBoth(page);
  await check("Open is enabled", () => open.isEnabled(), { timeout: 10_000 });
  await open.click();
  const partial = page.getByText(/Opened 1 of 2 links/);
  await check("Toast reports 1 of 2 opened", () => partial.isVisible());
  await check("Toast names the failed link and reason", () => page.getByText(new RegExp(`(${links.map((l) => l.title).join("|")}): Chrome refused the URL`)).isVisible());
  const failedText = (await page.getByText(/Chrome refused the URL/).first().textContent()) ?? "";
  await check("Selection is kept after opening", () => bar.getByText("2 selected").isVisible());
  await shot("03-partial-failure");
  await page.getByRole("button", { name: "Retry" }).click();
  const partialLog = await check("Retry resent the same operation and URLs", async () => {
    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem("fakeOpenLog") || "[]"));
    return log.length === 2 && log[0].operationId === log[1].operationId && JSON.stringify(log[0].urls) === JSON.stringify(log[1].urls) && log;
  });
  await note("partial-log", partialLog);
  await check("Retry's toast fails the same link again", () => partial.isVisible());
  const failedTitle = links.find((l) => new RegExp(`${l.title}: Chrome refused the URL`).test(failedText))!.title;
  const other = links.find((l) => l.title !== failedTitle)!;

  await step("Select failed selects exactly the link that failed, without retrying");
  await page.getByRole("checkbox", { name: `Select ${failedTitle}` }).uncheck();
  await check("Only the link that opened is selected now", () => bar.getByText("1 selected").isVisible());
  await page.getByRole("button", { name: "Select failed" }).click();
  await check("The failed link is selected and the other is not", async () => (await page.getByRole("checkbox", { name: `Select ${failedTitle}` }).isChecked()) && !(await page.getByRole("checkbox", { name: `Select ${other.title}` }).isChecked()));
  await check("Select failed did not send another open", async () => (await page.evaluate(() => JSON.parse(sessionStorage.getItem("fakeOpenLog") || "[]"))).length === 2);
  await shot("03b-select-failed");

  await step("Ambiguous outcome: the extension disconnects mid-request after the O key; Retry replays the same operation");
  await setMode({ caps: ["tabs", "open"], open: "disconnect-once" });
  await selectBoth(page);
  await check("Open is enabled", () => open.isEnabled(), { timeout: 10_000 });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("o");
  await check("Toast says the outcome could not be confirmed", () => page.getByText(/Couldn't confirm which links opened/).isVisible());
  await shot("04-unconfirmed");
  await check("Open is usable again after reconnecting", () => open.isEnabled(), { timeout: 10_000 });
  await page.getByRole("button", { name: "Retry" }).click();
  await check("Retry reports both opened", () => page.getByText(/Opened 2 links/).isVisible());
  const retryLog = await check("Retry reused the operation id", async () => {
    const log = await page.evaluate(() => JSON.parse(sessionStorage.getItem("fakeOpenLog") || "[]"));
    return log.length === 2 && log[0].operationId === log[1].operationId && log;
  });
  await note("ambiguous-log", retryLog);
  await shot("05-retry-opened");

  await step("Clear selection still works");
  await bar.getByRole("button", { name: "Clear selection" }).click();
  await check("Selection bar is gone", async () => !(await bar.isVisible()));
  await setMode(null);
}) satisfies Journey;
