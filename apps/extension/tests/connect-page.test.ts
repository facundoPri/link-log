import { expect, test } from "bun:test";
import { fakeChrome } from "./fake-chrome";
import { openConnectPage } from "../src/background/commands";

test("Connect opens next to the Linklog tab, or in the current window when that window is gone", async () => {
  const fake = fakeChrome();
  const create = chrome.tabs.create;
  chrome.tabs.create = (async (props: chrome.tabs.CreateProperties) => {
    if (props.windowId === 7) throw new Error("No window with id: 7.");
    return create(props);
  }) as typeof chrome.tabs.create;
  await openConnectPage({ windowId: 1, index: 0 });
  await openConnectPage({ windowId: 7, index: 3 });
  const opened = [...fake.tabs.values()].filter((t) => t.pendingUrl === "chrome-extension://ext/connect.html");
  expect(opened.map((t) => t.windowId)).toEqual([1, 1]);
});
