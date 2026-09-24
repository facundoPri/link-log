import {
  diffSnapshots,
  isLinklogUrl,
  patternCovers,
  urlAccess,
  type BrowserGroup,
  type BrowserTab,
  type ContentAccess,
  type ExtensionEvent,
  type ExtensionResponse,
  type GroupColor,
  type WindowSnapshot,
} from "@linklog/browser-protocol";
import { LINKLOG_ORIGINS } from "../config";
import type { GroupMetaStore } from "./groups";
import type { KV } from "./kv";
import type { Instance, TabRegistry } from "./registry";

/** SPA navigations keep status "complete"; give the new view time to render. */
export const SETTLE_MS = 1500;

export type Connection = {
  id: string;
  port: chrome.runtime.Port;
  tabId: number;
  windowId: number | null;
  scope: string | null;
  last: WindowSnapshot | null;
};

export function contentAccess(tab: chrome.tabs.Tab, instance: Instance | undefined, grants: readonly string[], now: number): ContentAccess {
  const base = urlAccess(tab.url || tab.pendingUrl || "");
  if (base !== "available") return base;
  if (tab.discarded) return "discarded";
  if ((tab as { frozen?: boolean }).frozen) return "frozen";
  const url = tab.url || tab.pendingUrl || "";
  if (!grants.some((p) => patternCovers(p, url))) return "no-permission";
  if (tab.status !== "complete" || (instance && now - instance.changedAt < SETTLE_MS)) return "loading";
  return "available";
}

/** Owns bridge connections and pushes window snapshots/patches, batching bursts. */
export class Hub {
  connections = new Map<string, Connection>();
  revision = 0;
  /** Broad http/https content access granted from the connect page. */
  granted = false;
  /** Every host permission Chrome currently grants (broad or per site). */
  grants: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private kv: KV,
    private registry: TabRegistry,
    private groups: GroupMetaStore,
  ) {}

  async loadRevision() {
    this.revision = (await this.kv.get<number>("revision")) ?? 0;
  }

  /** Monotonic across service-worker restarts within the browser session. */
  nextRevision() {
    this.revision++;
    void this.kv.set({ revision: this.revision });
    return this.revision;
  }

  isLinklog(url: string | undefined) {
    return !!url && isLinklogUrl(url, LINKLOG_ORIGINS);
  }

  async tabDto(tab: chrome.tabs.Tab, now: number): Promise<BrowserTab | null> {
    if (tab.id === undefined || tab.id < 0) return null;
    let instance = this.registry.get(tab.id);
    if (!instance) {
      await this.registry.observe(tab.id, tab.url);
      instance = this.registry.get(tab.id)!;
    }
    return {
      tabId: tab.id,
      tabInstanceId: instance.tabInstanceId,
      documentRevision: instance.documentRevision,
      windowId: tab.windowId,
      index: tab.index,
      groupId: tab.groupId === undefined || tab.groupId < 0 ? null : tab.groupId,
      title: tab.title || tab.url || "",
      url: tab.url || tab.pendingUrl || "",
      favIconUrl: tab.favIconUrl && /^(https?:|data:image\/)/.test(tab.favIconUrl) ? tab.favIconUrl : null,
      status: tab.discarded ? "unloaded" : tab.status === "loading" ? "loading" : "complete",
      active: tab.active,
      pinned: tab.pinned,
      audible: !!tab.audible,
      discarded: !!tab.discarded,
      frozen: !!(tab as { frozen?: boolean }).frozen,
      content: contentAccess(tab, instance, this.grants, now),
      openedAt: instance.openedAt,
    };
  }

  async snapshot(windowId: number): Promise<Omit<WindowSnapshot, "revision">> {
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId }),
      chrome.tabGroups.query({ windowId }).catch(() => [] as chrome.tabGroups.TabGroup[]),
    ]);
    const now = Date.now();
    const listed: BrowserTab[] = [];
    let linklogTabs = 0;
    for (const tab of tabs.sort((a, b) => a.index - b.index)) {
      if (this.isLinklog(tab.url || tab.pendingUrl)) {
        linklogTabs++;
        continue;
      }
      const dto = await this.tabDto(tab, now);
      if (dto) listed.push(dto);
    }
    const groupDtos: BrowserGroup[] = groups.map((g) => {
      const meta = this.groups.get(g.id);
      return {
        groupId: g.id,
        windowId: g.windowId,
        title: g.title ?? "",
        color: g.color as GroupColor,
        collapsed: g.collapsed,
        description: meta.description,
        pinnedId: meta.pinnedId,
      };
    });
    return { windowId, tabs: listed, groups: groupDtos, linklogTabs };
  }

  send(c: Connection, message: ExtensionResponse | { event: ExtensionEvent }) {
    try {
      c.port.postMessage(message);
    } catch {
      this.connections.delete(c.id);
    }
  }

  broadcast(event: ExtensionEvent, windowId?: number) {
    for (const c of this.connections.values())
      if (windowId === undefined || c.windowId === windowId) this.send(c, { event });
  }

  async fullSnapshot(c: Connection): Promise<WindowSnapshot> {
    const tab = await chrome.tabs.get(c.tabId);
    c.windowId = tab.windowId;
    const snap = { ...(await this.snapshot(tab.windowId)), revision: this.nextRevision() };
    c.last = snap;
    return snap;
  }

  /** Coalesces event bursts into one reconciliation per window. */
  schedule(delay = 120) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch((e) => console.warn("Linklog: flush failed", e));
    }, delay);
  }

  /** Re-check after a navigation settles so the tab becomes readable. */
  scheduleSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.schedule(0);
    }, SETTLE_MS + 100);
  }

  async flush() {
    if (!this.connections.size) return;
    const byWindow = new Map<number, Omit<WindowSnapshot, "revision">>();
    const revision = this.nextRevision();
    for (const c of [...this.connections.values()]) {
      if (!c.scope) continue;
      const tab = await chrome.tabs.get(c.tabId).catch(() => null);
      if (!tab) continue;
      if (c.windowId !== null && c.windowId !== tab.windowId) {
        // The Linklog page moved: switch its scope to the destination window.
        c.last = null;
        this.send(c, { event: { event: "scope-changed", windowId: tab.windowId } });
      }
      c.windowId = tab.windowId;
      let next = byWindow.get(tab.windowId);
      if (!next) byWindow.set(tab.windowId, (next = await this.snapshot(tab.windowId)));
      if (!c.last) {
        c.last = { ...next, revision };
        this.send(c, { event: { event: "snapshot", snapshot: c.last } });
        continue;
      }
      const patch = diffSnapshots(c.last, next, revision);
      if (!patch) continue;
      c.last = { ...next, revision };
      this.send(c, { event: { event: "patch", patch } });
    }
  }
}
