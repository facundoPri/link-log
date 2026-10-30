// Just enough of the chrome.* API for command tests. Tabs live in one window unless moved.
type Tab = chrome.tabs.Tab;

export function fakeChrome() {
  const tabs = new Map<number, Tab>();
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  /** What the injected extractor returns per tab (page content). */
  const pages = new Map<number, { url: string; markdown: string; title?: string }>();
  const createErrors = new Map<string, string>();
  let scripts = 0;
  let nextTabId = 1000;
  const api = {
    tabs: {
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      query: async (q: { windowId?: number }) => [...tabs.values()].filter((t) => q.windowId === undefined || t.windowId === q.windowId),
      update: async () => ({}),
      remove: async (id: number) => void tabs.delete(id),
      group: async () => 1,
      ungroup: async () => {},
      create: async ({ url, windowId = 1 }: { url?: string; windowId?: number; active?: boolean }) => {
        const error = createErrors.get(url ?? "");
        if (error) throw new Error(error);
        const tab = { id: nextTabId++, pendingUrl: url, url: "", windowId, index: tabs.size, status: "loading", active: false, pinned: false, discarded: false, groupId: -1, title: "" } as Tab;
        tabs.set(tab.id!, tab);
        return { ...tab };
      },
    },
    tabGroups: {
      get: async (id: number) => groups.get(id) ?? Promise.reject(new Error("no group")),
      query: async () => [...groups.values()],
      update: async () => ({}),
    },
    scripting: {
      executeScript: async ({ target, files }: { target: { tabId: number }; files?: string[] }) => {
        scripts++;
        if (files) return [{ result: undefined }];
        const page = pages.get(target.tabId);
        if (!page) throw new Error("Cannot access contents of the page");
        return [
          {
            result: {
              ok: true,
              url: page.url,
              title: page.title ?? "T",
              description: "desc",
              siteName: "",
              image: "",
              markdown: page.markdown,
              completeness: "complete",
              reasons: [],
              facts: [],
            },
          },
        ];
      },
    },
    runtime: { getURL: (p: string) => `chrome-extension://ext/${p}` },
  };
  (globalThis as { chrome?: unknown }).chrome = api;
  return {
    tabs,
    groups,
    pages,
    createErrors,
    get scripts() {
      return scripts;
    },
    addTab(id: number, url: string, windowId = 1, extra: Partial<Tab> = {}) {
      const tab = { id, url, windowId, index: tabs.size, status: "complete", active: false, pinned: false, discarded: false, groupId: -1, title: `Tab ${id}`, ...extra } as Tab;
      tabs.set(id, tab);
      pages.set(id, { url, markdown: `# Tab ${id}\n\nText.` });
      return tab;
    },
  };
}
