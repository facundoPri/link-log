import { BRIDGE_PORT, LOCAL_BRIDGE_MATCHES, parsePageRequest } from "@linklog/browser-protocol";
import { CONTENT_ORIGINS, EXTENSION_VERSION, LINKLOG_ORIGINS } from "../config";
import { ResultCache } from "./cache";
import { handle, type Services } from "./commands";
import { GroupMetaStore } from "./groups";
import { Hub, type Connection } from "./hub";
import { chromeKV, Mutex } from "./kv";
import { OpenLedger } from "./opens";
import { TabRegistry, type Change } from "./registry";
import { isBridgeSender, isExtensionPage } from "./sender";

// The extension is the only authority on open tabs. Everything below survives
// service-worker suspension through chrome.storage.session; a browser restart or an
// extension reload/update starts a new browserSessionId with an empty cache.

const session = chromeKV(chrome.storage.session, chrome.storage.session.QUOTA_BYTES ?? 10 * 1024 * 1024);
const local = chromeKV(chrome.storage.local, 10 * 1024 * 1024);
const mutex = new Mutex();
const registry = new TabRegistry(session);
const cache = new ResultCache(session, mutex);
const groups = new GroupMetaStore(session, mutex, local);
const hub = new Hub(session, registry, groups);
const opens = new OpenLedger(session);
let services: Services | null = null;

// Bridge content-script matches show up as granted origins; they are for the bridge
// only and never count as access to read a page.
const BRIDGE_PATTERNS = new Set([...LOCAL_BRIDGE_MATCHES, ...LINKLOG_ORIGINS.map((o) => `${o}/*`)]);

async function refreshAccess() {
  hub.grants = ((await chrome.permissions.getAll()).origins ?? []).filter((o) => !BRIDGE_PATTERNS.has(o));
  const granted = await chrome.permissions.contains({ origins: CONTENT_ORIGINS });
  if (granted !== hub.granted) {
    hub.granted = granted;
    hub.broadcast({ event: "access-changed", contentAccess: granted });
  }
}

async function applyChanges(changes: Change[]) {
  for (const change of changes) {
    if (change.kind === "removed") await cache.dropTab(change.instance.tabInstanceId);
    if (change.kind === "navigated")
      await cache.dropStaleRevisions(change.instance.tabInstanceId, change.instance.documentRevision);
  }
  if (changes.some((c) => c.kind !== "created")) hub.broadcast({ event: "results-changed", windowId: -1 });
}

async function init(): Promise<Services> {
  // Session data is for trusted extension contexts only, never content scripts.
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
  let installationId = await local.get<string>("installationId");
  if (!installationId) {
    installationId = crypto.randomUUID();
    await local.set({ installationId });
  }
  let browserSessionId = await session.get<string>("browserSessionId");
  const fresh = !browserSessionId;
  if (!browserSessionId) {
    browserSessionId = crypto.randomUUID();
    await session.set({ browserSessionId });
  }
  await Promise.all([registry.load(), groups.load(), hub.load()]);
  // Chrome restart or extension reload: re-bind pinned groups Chrome kept or restored.
  if (fresh) await groups.beginRestore();
  await refreshAccess();
  // Reconcile anything missed while the worker was asleep.
  await applyChanges(await registry.reconcile(await chrome.tabs.query({})));
  const alive = await chrome.tabGroups.query({}).catch(() => []);
  await groups.prune(new Set(alive.map((g) => g.id)));
  await groups.restoreBindings(alive);
  await groups.syncHints(alive);
  groups.onChange = () => syncGroups();
  return { registry, cache, groups, hub, opens, ids: { installationId, browserSessionId } };
}
const ready = init().then((s) => (services = s));

function run(task: () => Promise<unknown>) {
  void ready
    .then(task)
    .catch((error) => console.warn("Linklog:", error));
}

/** Re-binds restored pinned groups (fresh session only) and refreshes their hints. */
function syncGroups() {
  run(async () => {
    const alive = await chrome.tabGroups.query({}).catch(() => [] as chrome.tabGroups.TabGroup[]);
    if (await groups.restoreBindings(alive)) hub.schedule();
    await groups.syncHints(alive);
  });
}

// Listeners are registered synchronously so Chrome can wake the worker for them.
chrome.tabs.onCreated.addListener((tab) =>
  run(async () => {
    if (tab.id !== undefined) {
      const change = await registry.observe(tab.id, tab.url);
      if (change) await applyChanges([change]);
    }
    hub.schedule();
  }),
);
chrome.tabs.onUpdated.addListener((tabId, info, tab) =>
  run(async () => {
    if (info.url !== undefined || info.status !== undefined) {
      const change = await registry.observe(tabId, tab.url);
      if (change) {
        await applyChanges([change]);
        hub.scheduleSettle();
      }
      if (info.status === "complete") hub.scheduleSettle();
    }
    hub.schedule();
  }),
);
chrome.tabs.onRemoved.addListener((tabId) =>
  run(async () => {
    const change = await registry.remove(tabId);
    if (change) await applyChanges([change]);
    hub.schedule();
  }),
);
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) =>
  run(async () => {
    const tab = await chrome.tabs.get(addedTabId).catch(() => null);
    await applyChanges(await registry.replace(addedTabId, removedTabId, tab?.url));
    hub.schedule();
  }),
);
for (const event of [
  chrome.tabs.onMoved,
  chrome.tabs.onAttached,
  chrome.tabs.onDetached,
  chrome.tabs.onActivated,
  chrome.tabGroups.onMoved,
  chrome.windows.onRemoved,
] as chrome.events.Event<() => void>[])
  event.addListener(() => run(async () => hub.schedule()));
for (const event of [chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated] as chrome.events.Event<() => void>[])
  event.addListener(() => {
    hub.schedule();
    syncGroups();
  });
chrome.tabGroups.onRemoved.addListener((group) =>
  run(async () => {
    // Closing a Chrome group drops its local association; a pinned definition stays.
    await groups.remove(group.id);
    hub.schedule();
  }),
);
chrome.permissions.onAdded.addListener(() => run(async () => (await refreshAccess(), hub.schedule(0))));
chrome.permissions.onRemoved.addListener(() => run(async () => (await refreshAccess(), hub.schedule(0))));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== BRIDGE_PORT || !isBridgeSender(port.sender ?? {}, chrome.runtime.id, LINKLOG_ORIGINS)) {
    port.disconnect();
    return;
  }
  const c: Connection = {
    id: crypto.randomUUID(),
    port,
    tabId: port.sender!.tab!.id!,
    windowId: null,
    scope: null,
    last: null,
  };
  hub.connections.set(c.id, c);
  // This tab is Linklog: drop it from every list right away, and remember its origin.
  run(async () => {
    await hub.learnOrigin(port.sender?.tab?.url);
    hub.schedule(0);
  });
  port.onDisconnect.addListener(() => {
    hub.connections.delete(c.id);
    hub.schedule();
  });
  port.onMessage.addListener((raw) => {
    if (raw && typeof raw === "object" && (raw as { heartbeat?: unknown }).heartbeat === true) return;
    const request = parsePageRequest(raw);
    if (!request) {
      const id = (raw as { id?: unknown })?.id;
      if (typeof id === "string") hub.send(c, { id, ok: false, error: "Invalid request." });
      return;
    }
    run(async () => {
      try {
        const result = await handle(request, c, services!);
        hub.send(c, { id: request.id, ok: true, result });
      } catch (error) {
        hub.send(c, { id: request.id, ok: false, error: (error as Error).message || "The extension could not do that." });
      }
    });
  });
});

// Popup and connect page status. Content scripts can't use this channel.
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!isExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) return false;
  if (message?.type !== "status") return false;
  ready
    .then(async (s) => {
      reply({
        version: EXTENSION_VERSION,
        installationId: s.ids.installationId,
        browserSessionId: s.ids.browserSessionId,
        contentAccess: hub.granted,
        connectedPages: hub.connections.size,
        linklogTabs: [...new Set([...hub.connections.values()].map((c) => c.tabId))],
        origins: LINKLOG_ORIGINS,
        cache: await cache.usage(),
      });
    })
    .catch(() => reply(null));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") });
});
