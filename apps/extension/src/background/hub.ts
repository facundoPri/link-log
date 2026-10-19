import {
  diffSnapshots,
  originOf,
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
  /** Origins where a Linklog page connected the bridge during this browser session. */
  private linklogOrigins = new Set<string>(LINKLOG_ORIGINS);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private kv: KV,
    private registry: TabRegistry,
    private groups: GroupMetaStore,
  ) {}

  async load() {
    this.revision = (await this.kv.get<number>("revision")) ?? 0;
    for (const o of (await this.kv.get<string[]>("linklogOrigins")) ?? []) this.linklogOrigins.add(o);
  }

  /** Monotonic across service-worker restarts within the browser session. */
  nextRevision() {
    this.revision++;
    this.kv.set({ revision: this.revision }).catch((e) => console.warn("Linklog: could not persist the revision", e));
    return this.revision;
  }

  /**
   * Linklog pages are never listed, read or closed: a tab with a bridge connection, or
   * one on an origin where Linklog connected before in this session (covers a Linklog
   * page that is still loading, before its bridge is up).
   */
  isLinklog(tab: { id?: number; url?: string; pendingUrl?: string }) {
    if (tab.id !== undefined && [...this.connections.values()].some((c) => c.tabId === tab.id)) return true;
    const origin = originOf(tab.url || tab.pendingUrl || "");
    return !!origin && this.linklogOrigins.has(origin);
  }

  /** A bridge connected from this origin: remember it so its pages stay out of the lists. */
  async learnOrigin(url: string | undefined) {
    const origin = originOf(url ?? "");
    if (!origin || this.linklogOrigins.has(origin)) return;
    this.linklogOrigins.add(origin);
    await this.kv.set({ linklogOrigins: [...this.linklogOrigins] });
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
      firstSeenAt: instance.openedAt,
    };
  }

  /** Window snapshot as one library scope sees it (Linklog group metadata is per scope). */
  async snapshot(windowId: number, scope: string | null): Promise<Omit<WindowSnapshot, "revision">> {
    const [tabs, groups] = await Promise.all([
      chrome.tabs.query({ windowId }),
      chrome.tabGroups.query({ windowId }).catch(() => [] as chrome.tabGroups.TabGroup[]),
    ]);
    const now = Date.now();
    const listed: BrowserTab[] = [];
    let linklogTabs = 0;
    for (const tab of tabs.sort((a, b) => a.index - b.index)) {
      if (this.isLinklog(tab)) {
        linklogTabs++;
        continue;
      }
      const dto = await this.tabDto(tab, now);
      if (dto) listed.push(dto);
    }
    const groupDtos: BrowserGroup[] = groups.map((g) => {
      const meta = this.groups.view(g.id, scope);
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
    const snap = { ...(await this.snapshot(tab.windowId, c.scope)), revision: this.nextRevision() };
    c.last = snap;
    return snap;
  }

  /** Coalesces event bursts into one reconciliation per window; a shorter delay pulls it forward. */
  schedule(delay = 120) {
    const due = Date.now() + delay;
    if (this.timer) {
      if (due >= this.due) return;
      clearTimeout(this.timer);
    }
    this.due = due;
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
    const byView = new Map<string, Omit<WindowSnapshot, "revision">>();
    // The revision only moves when something is actually sent.
    let bumped: number | null = null;
    const revision = () => (bumped ??= this.nextRevision());
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
      const view = `${tab.windowId}\u0000${c.scope}`;
      let next = byView.get(view);
      if (!next) byView.set(view, (next = await this.snapshot(tab.windowId, c.scope)));
      if (!c.last) {
        c.last = { ...next, revision: revision() };
        this.send(c, { event: { event: "snapshot", snapshot: c.last } });
        continue;
      }
      const patch = diffSnapshots(c.last, next, 0);
      if (!patch) continue;
      patch.revision = revision();
      c.last = { ...next, revision: patch.revision };
      this.send(c, { event: { event: "patch", patch } });
    }
  }
}
