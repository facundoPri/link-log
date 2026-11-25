// extension-version: Browser view against a faked extension bridge (FAC-266). No extension links the
// expected version's release (the latest one when GitHub has none for it); one on another protocol is blocked with both versions named, and the old-shape
// snapshot it keeps pushing never reaches the tab list; one on this protocol but older gets a banner.
// The reload scenario covers the gate's edges: a push before the first handshake, the extension
// reloading as an older build (disconnect, push, protocol-2 hello) and a foreground refresh meanwhile.
import { PROTOCOL_VERSION } from "@linklog/browser-protocol";
import type { Journey } from "../scripts/journey";
import extensionPackage from "../../../../apps/extension/package.json" with { type: "json" };

const expected = extensionPackage.version;

type FakeMode = { protocol: number; version: string; pushOldSnapshot: boolean; reloadToOld?: boolean; oldProtocol?: number };
// The protocol extension 0.1.1 speaks; the "current" one always comes from the package, never a literal.
const OLD_PROTOCOL = 2;

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
  const snap = (tab: Record<string, unknown>, revision: number) => ({ revision, windowId: 1, tabs: [tab], groups: [], linklogTabs: 1, loadRun: null });
  const currentTab = (tabId: number, title: string) => ({ ...oldTab, tabId, tabInstanceId: `t-${tabId}`, title, url: `https://article.qa.example/${tabId}`, status: "complete", discarded: false, content: "available", sleep: null, capturedAt: null, load: null });
  const early = snap({ ...oldTab, tabId: 5, tabInstanceId: "t-5", title: "Pushed before handshake" }, 1);
  const known = snap(currentTab(6, "Current extension tab"), 2);
  const old = snap(oldTab, 3);
  const push = (snapshot: unknown) => {
    if (snapshot === early) document.documentElement.dataset.earlyPushes = String(Number(document.documentElement.dataset.earlyPushes ?? 0) + 1);
    post({ event: { event: "snapshot", snapshot } });
  };
  // Every tab row the page ever renders, so a single-frame flash is recorded too.
  const seen: string[] = [];
  (window as unknown as { __seenRows: string[] }).__seenRows = seen;
  document.addEventListener("DOMContentLoaded", () => {
    const record = () => {
      for (const row of document.querySelectorAll<HTMLElement>("[data-tab-id]")) if (!seen.includes(row.textContent ?? "")) seen.push(row.textContent ?? "");
    };
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
    // From page load until the first hello is answered, so a gate that starts open is caught too.
    if (mode.reloadToOld) earlyPushes = setInterval(() => push(early), 100);
  });
  let earlyPushes: ReturnType<typeof setInterval> | undefined;
  let protocol = mode.protocol;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.channel !== "linklog-bridge" || data.from !== "page") return;
    const { id, command } = data.request;
    if (mode.reloadToOld && command === "hello") {
      const answering = protocol;
      push(answering === mode.protocol ? early : old);
      setTimeout(() => {
        clearInterval(earlyPushes);
        reply(id, { protocol: answering, extensionVersion: answering === mode.protocol ? mode.version : "0.1.1", installationId: "fake", browserSessionId: "fake", windowId: 1, capabilities: ["tabs", "groups"], contentAccess: true });
        if (answering !== mode.protocol) {
          setTimeout(() => push(old), 50);
          setTimeout(() => (document.documentElement.dataset.fakeDone = "1"), 600);
          return;
        }
        setTimeout(() => {
          protocol = mode.oldProtocol!;
          post({ disconnected: true });
          setTimeout(() => push(old), 300);
          setTimeout(() => document.dispatchEvent(new Event("visibilitychange")), 600);
          setTimeout(() => post({ ready: { version: "0.1.1", protocol: mode.oldProtocol! } }), 1200);
        }, 2500);
      }, 1000);
      return;
    }
    if (mode.reloadToOld && command === "snapshot") return reply(id, protocol === mode.protocol ? known : old);
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
    if (command === "previews") return reply(id, { previews: [] });
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
  const tagged = `https://github.com/facundoPri/link-log/releases/tag/extension-v${expected}`;
  const download = page.getByRole("link", { name: `Download extension ${expected}` });
  // GitHub's answer to "does the expected version have a release?", without leaving the machine.
  let release = { status: 200, asked: 0 };
  await page.route("https://api.github.com/**", (route) => {
    release.asked++;
    return route.fulfill({ status: release.status, contentType: "application/json", body: "{}" });
  });

  await step("No extension: Connect links the expected version's release, with a note for source builds");
  release = { status: 200, asked: 0 };
  await openBrowser(null);
  await check("Connect screen asks for the extension", () => page.getByRole("heading", { name: "Connect the Linklog extension" }).isVisible(), { timeout: 10_000 });
  await check("Linklog asked GitHub for the expected release", () => release.asked > 0);
  await check("Download link points at the expected version's release", async () => (await download.getAttribute("href")) === tagged);
  await check("Source-build note is there", () => page.getByText("Working on Linklog?").isVisible());
  await shot("01-missing");
  await aria("01-missing");

  await step("Extension 0.1.1 on protocol 2, pushing an old-shape snapshot: blocked, versions named, no crash; the expected release is missing");
  release = { status: 404, asked: 0 };
  await openBrowser({ protocol: OLD_PROTOCOL, version: "0.1.1", pushOldSnapshot: true });
  await check("Update screen shows", () => page.getByRole("heading", { name: "Update the Linklog extension" }).isVisible(), { timeout: 10_000 });
  await check("Names installed 0.1.1 and needed version", () => page.getByText(`The installed extension (0.1.1) can't talk to this version of Linklog. Browser view needs extension ${expected}.`).isVisible());
  await check("Linklog asked GitHub for the expected release", () => release.asked > 0);
  await check("Without that release, the download link falls back to the latest release", async () => (await download.getAttribute("href")) === latest);
  await check("The fake bridge delivered the old snapshot", async () => (await page.evaluate(() => document.documentElement.dataset.fakePushed)) === "1");
  await check("The pushed old tab never renders", async () => !(await page.getByText("Discarded by Chrome").isVisible()));
  await check("Still on the update screen after the push", () => page.getByRole("heading", { name: "Update the Linklog extension" }).isVisible());
  await check("No page errors", () => errors.length === 0, { timeout: 1000 });
  await shot("02-outdated-protocol");
  await aria("02-outdated-protocol");

  await step("Gate edges: push before the first hello, reload as protocol 2 with a push and a foreground refresh before its hello");
  await openBrowser({ protocol: PROTOCOL_VERSION, version: expected, pushOldSnapshot: false, reloadToOld: true, oldProtocol: OLD_PROTOCOL });
  const seenRows = async () => (await page.evaluate(() => (window as unknown as { __seenRows: string[] }).__seenRows)).map((t) => t.replace(/\s+/g, " "));
  await check("Snapshots were pushed before the first handshake completed", async () => Number(await page.evaluate(() => document.documentElement.dataset.earlyPushes ?? 0)) > 1);
  await check("The current extension's tab shows after its handshake", async () => (await seenRows()).some((t) => t.includes("Current extension tab")), { timeout: 10_000 });
  await check("After the reload as 0.1.1, the update screen replaces the tabs", () => page.getByRole("heading", { name: "Update the Linklog extension" }).isVisible(), { timeout: 15_000 });
  await check("The fake bridge finished its pushes", async () => (await page.evaluate(() => document.documentElement.dataset.fakeDone)) === "1");
  const seen = await seenRows();
  await note("seen-rows", seen);
  await check("No row ever rendered from an unconfirmed push", () => !seen.some((t) => t.includes("Pushed before handshake") || t.includes("Discarded by Chrome")), { timeout: 1000 });
  await check("No tab rows remain", async () => (await page.locator("[data-tab-id]").count()) === 0);
  await check("No page errors", () => errors.length === 0, { timeout: 1000 });
  await shot("02b-reloaded-as-old");

  await step("Extension 0.1.1 on this protocol: tabs show, with a non-blocking update banner");
  release = { status: 200, asked: 0 };
  await openBrowser({ protocol: PROTOCOL_VERSION, version: "0.1.1", pushOldSnapshot: false });
  const get = page.getByRole("link", { name: "Download update" });
  await check("Update banner names both versions", () => page.getByText(`Linklog extension 0.1.1 is older than this Linklog expects (${expected}).`).isVisible(), { timeout: 10_000 });
  await check("Banner links the expected version's release", async () => (await get.getAttribute("href")) === tagged);

  await step("Same banner when GitHub has no release for the expected version: it links the latest release");
  release = { status: 404, asked: 0 };
  await openBrowser({ protocol: PROTOCOL_VERSION, version: "0.1.1", pushOldSnapshot: false });
  await check("Update banner shows", () => get.isVisible(), { timeout: 10_000 });
  await check("Linklog asked GitHub for the expected release", () => release.asked > 0);
  await check("Banner falls back to the latest release", async () => (await get.getAttribute("href")) === latest);
  await check("Browser view shows the connected window (its empty state)", () => page.getByRole("heading", { name: "No other tabs in this window" }).isVisible());
  await shot("03-older-same-protocol");

  await step(`Extension ${expected}: no banner`);
  await openBrowser({ protocol: PROTOCOL_VERSION, version: expected, pushOldSnapshot: false });
  await check("Connected: the window's empty state shows", () => page.getByRole("heading", { name: "No other tabs in this window" }).isVisible(), { timeout: 10_000 });
  await check("No update banner", async () => !(await page.getByText(/is older than this Linklog expects/).isVisible()));
  await shot("04-current");
  await note("page-errors", errors);
  await check("No page errors in the whole run", () => errors.length === 0, { timeout: 1000 });
}) satisfies Journey;
