// extension-version: Browser view against a faked extension bridge (FAC-266). No extension links the
// latest release; one on another protocol is blocked with both versions named, and the old-shape
// snapshot it keeps pushing never reaches the tab list; one on this protocol but older gets a banner.
import type { Journey } from "../scripts/journey";
import extensionPackage from "../../../../apps/extension/package.json" with { type: "json" };

const expected = extensionPackage.version;

type FakeMode = { protocol: number; version: string; pushOldSnapshot: boolean };

function fakeBridge() {
  const raw = sessionStorage.getItem("fakeBridge");
  if (!raw) return;
  const mode: FakeMode = JSON.parse(raw);
  const mark = () => (document.documentElement.dataset.linklogBridge = String(mode.protocol));
  if (document.documentElement) mark();
  else document.addEventListener("DOMContentLoaded", mark);
  const post = (body: Record<string, unknown>) => window.postMessage({ channel: "linklog-bridge", from: "extension", ...body }, location.origin);
  const reply = (id: string, result: unknown) => post({ response: { id, ok: true, result } });
  // What extension 0.1.1 (protocol 2) sends: no sleep/load/capturedAt, a content value protocol 3 dropped.
  const oldTab = {
    tabId: 7, tabInstanceId: "old-7", documentRevision: 1, windowId: 1, index: 0, groupId: null,
    title: "Discarded by Chrome", url: "https://article.qa.example/old", favIconUrl: null, status: "unloaded",
    active: false, pinned: false, audible: false, discarded: true, frozen: false, content: "discarded", firstSeenAt: 1,
  };
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.channel !== "linklog-bridge" || data.from !== "page") return;
    const { id, command } = data.request;
    if (command === "hello") {
      reply(id, { protocol: mode.protocol, extensionVersion: mode.version, installationId: "fake", browserSessionId: "fake", windowId: 1, capabilities: ["tabs", "groups"], contentAccess: true });
      if (mode.pushOldSnapshot)
        setTimeout(() => {
          post({ event: { event: "snapshot", snapshot: { revision: 1, windowId: 1, tabs: [oldTab], groups: [], linklogTabs: 1 } } });
          // Set after the page's message listener ran (a later task), so the check below follows delivery.
          setTimeout(() => (document.documentElement.dataset.fakePushed = "1"), 0);
        }, 50);
      return;
    }
    if (command === "snapshot") return reply(id, { revision: 1, windowId: 1, tabs: [], groups: [], linklogTabs: 1, loadRun: null });
    if (command === "results") return reply(id, { results: {} });
    if (command === "pending") return reply(id, { requests: [] });
    reply(id, {});
  });
}

export default (async ({ page, step, check, shot, aria, note }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(fakeBridge);
  const openBrowser = async (mode: FakeMode | null) => {
    await page.evaluate((m) => (m ? sessionStorage.setItem("fakeBridge", JSON.stringify(m)) : sessionStorage.removeItem("fakeBridge")), mode);
    await page.reload();
    await page.getByRole("button", { name: /^Browser/ }).click();
  };
  const latest = "https://github.com/facundoPri/link-log/releases/latest";
  const download = page.getByRole("link", { name: "Download the latest release" });

  await step("No extension: Connect links the latest release, with a note for source builds");
  await openBrowser(null);
  await check("Connect screen asks for the extension", () => page.getByRole("heading", { name: "Connect the Linklog extension" }).isVisible(), { timeout: 10_000 });
  await check("Download link points at the latest release", async () => (await download.getAttribute("href")) === latest);
  await check("Source-build note is there", () => page.getByText("Working on Linklog?").isVisible());
  await shot("01-missing");
  await aria("01-missing");

  await step("Extension 0.1.1 on protocol 2, pushing an old-shape snapshot: blocked, versions named, no crash");
  await openBrowser({ protocol: 2, version: "0.1.1", pushOldSnapshot: true });
  await check("Update screen shows", () => page.getByRole("heading", { name: "Update the Linklog extension" }).isVisible(), { timeout: 10_000 });
  await check("Names installed 0.1.1 and needed version", () => page.getByText(`The installed extension (0.1.1) can't talk to this version of Linklog. Browser view needs extension ${expected}.`).isVisible());
  await check("Download link points at the latest release", async () => (await download.getAttribute("href")) === latest);
  await check("The fake bridge delivered the old snapshot", async () => (await page.evaluate(() => document.documentElement.dataset.fakePushed)) === "1");
  await check("The pushed old tab never renders", async () => !(await page.getByText("Discarded by Chrome").isVisible()));
  await check("Still on the update screen after the push", () => page.getByRole("heading", { name: "Update the Linklog extension" }).isVisible());
  await check("No page errors", () => errors.length === 0, { timeout: 1000 });
  await shot("02-outdated-protocol");
  await aria("02-outdated-protocol");

  await step("Extension 0.1.1 on this protocol: tabs show, with a non-blocking update banner");
  await openBrowser({ protocol: 3, version: "0.1.1", pushOldSnapshot: false });
  const get = page.getByRole("link", { name: "Download update" });
  await check("Update banner names both versions", () => page.getByText(`Linklog extension 0.1.1 is older than this Linklog expects (${expected}).`).isVisible(), { timeout: 10_000 });
  await check("Banner links the latest release", async () => (await get.getAttribute("href")) === latest);
  await check("Browser view is usable (no Connect/Update screen)", async () => !(await page.getByRole("heading", { name: /Update the Linklog extension|Connect the Linklog extension/ }).isVisible()));
  await shot("03-older-same-protocol");

  await step(`Extension ${expected}: no banner`);
  await openBrowser({ protocol: 3, version: expected, pushOldSnapshot: false });
  await check("Open links button shows (connected)", () => page.getByRole("button", { name: "Open links" }).isVisible(), { timeout: 10_000 });
  await check("No update banner", async () => !(await page.getByText(/is older than this Linklog expects/).isVisible()));
  await shot("04-current");
  await note("page-errors", errors);
  await check("No page errors in the whole run", () => errors.length === 0, { timeout: 1000 });
}) satisfies Journey;
