// Just enough of the chrome.* API for command tests. Tabs live in one window unless moved.
type Tab = chrome.tabs.Tab & { frozen?: boolean };

/** How a reload of one tab plays out. Default: completes after `loadMs`. */
export type LoadPlan = { ms?: number; hang?: boolean; redirectTo?: string };

export function fakeChrome() {
  const tabs = new Map<number, Tab>();
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  /** What the injected extractor returns per tab (page content). */
  const pages = new Map<number, { url: string; markdown: string; title?: string }>();
  const createErrors = new Map<string, string>();
  const loadPlans = new Map<number, LoadPlan>();
  /** Tabs Chrome refuses to discard, with the error it throws. */
  const discardErrors = new Map<number, string>();
  /** Every lifecycle mutation in order, e.g. "reload:3", "discard:3", "group:4". */
  const ops: string[] = [];
  let scripts = 0;
  let nextTabId = 1000;
  let nextGroupId = 1;
  const asleep = (t: Tab) => !!t.discarded || t.status === "unloaded" || !!t.frozen;
  const api = {
    tabs: {
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        return { ...t };
      },
      query: async (q: { windowId?: number }) => [...tabs.values()].filter((t) => q.windowId === undefined || t.windowId === q.windowId).map((t) => ({ ...t })),
      update: async () => ({}),
      remove: async (id: number) => void tabs.delete(id),
      group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
        const id = groupId ?? nextGroupId++;
        for (const tabId of tabIds) {
          const t = tabs.get(tabId);
          if (!t) continue;
          ops.push(`group:${tabId}`);
          // Chrome unpins a pinned tab it groups: the thing Linklog must never do.
          t.pinned = false;
          t.groupId = id;
        }
        return id;
      },
      ungroup: async () => {},
      create: async ({ url, windowId = 1 }: { url?: string; windowId?: number; active?: boolean }) => {
        const error = createErrors.get(url ?? "");
        if (error) throw new Error(error);
        const tab = { id: nextTabId++, pendingUrl: url, url: "", windowId, index: tabs.size, status: "loading", active: false, pinned: false, discarded: false, groupId: -1, title: "" } as Tab;
        tabs.set(tab.id!, tab);
        return { ...tab };
      },
      reload: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        ops.push(`reload:${id}`);
        t.discarded = false;
        t.frozen = false;
        t.status = "loading";
        const plan = loadPlans.get(id) ?? {};
        if (plan.hang) return;
        setTimeout(() => {
          const now = tabs.get(id);
          if (!now || now.status !== "loading") return;
          if (plan.redirectTo) {
            now.url = plan.redirectTo;
            pages.get(id)!.url = plan.redirectTo;
          }
          now.status = "complete";
        }, plan.ms ?? fake.loadMs);
      },
      discard: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw new Error(`No tab with id: ${id}`);
        const error = discardErrors.get(id);
        if (error) throw new Error(error);
        ops.push(`discard:${id}`);
        t.discarded = true;
        t.frozen = false;
        t.status = "unloaded";
        return { ...t };
      },
    },
    tabGroups: {
      get: async (id: number) => groups.get(id) ?? Promise.reject(new Error("no group")),
      query: async () => [...groups.values()],
      update: async () => ({}),
    },
    scripting: {
      executeScript: async ({ target, files }: { target: { tabId: number }; files?: string[] }) => {
        const tab = tabs.get(target.tabId);
        // A frozen page never runs the injected script, as in Chrome.
        if (tab?.frozen) return new Promise(() => {});
        if (tab && asleep(tab)) throw new Error("Frame with ID 0 is showing error page");
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
  const fake = {
    tabs,
    groups,
    pages,
    createErrors,
    loadPlans,
    discardErrors,
    ops,
    /** Default time a reload takes to complete. */
    loadMs: 5,
    get scripts() {
      return scripts;
    },
    addTab(id: number, url: string, windowId = 1, extra: Partial<Tab> = {}) {
      const tab = { id, url, windowId, index: tabs.size, status: "complete", active: false, pinned: false, discarded: false, groupId: -1, title: `Tab ${id}`, ...extra } as Tab;
      tabs.set(id, tab);
      pages.set(id, { url, markdown: `# Tab ${id}\n\nText.` });
      return tab;
    },
    /** A Sleeping tab: discarded, frozen, or restored at startup and never loaded. */
    addSleeping(id: number, url: string, reason: "unloaded" | "frozen" | "not-loaded" = "unloaded", extra: Partial<Tab> = {}) {
      const lifecycle =
        reason === "unloaded"
          ? { status: "unloaded", discarded: true }
          : reason === "frozen"
            ? { status: "complete", frozen: true }
            : { status: "unloaded", discarded: false };
      return fake.addTab(id, url, 1, { ...lifecycle, ...extra } as Partial<Tab>);
    },
    /** Most tabs awake at once that a reload woke and no discard put back yet. */
    maxAwakeByReload() {
      const awake = new Set<string>();
      let max = 0;
      for (const op of ops) {
        const [kind, id] = op.split(":") as [string, string];
        if (kind === "reload") awake.add(id);
        if (kind === "discard") awake.delete(id);
        max = Math.max(max, awake.size);
      }
      return max;
    },
    count(kind: string, id?: number) {
      return ops.filter((o) => (id === undefined ? o.startsWith(`${kind}:`) : o === `${kind}:${id}`)).length;
    },
  };
  return fake;
}
