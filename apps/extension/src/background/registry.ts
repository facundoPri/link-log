import { documentKey } from "@linklog/browser-protocol";
import type { KV } from "./kv";

export type Instance = {
  tabInstanceId: string;
  documentRevision: number;
  docKey: string;
  openedAt: number;
  /** Last document change; SPA navigations settle before they are read. */
  changedAt: number;
};

export type Change =
  | { kind: "created"; tabId: number; instance: Instance }
  | { kind: "navigated"; tabId: number; instance: Instance; previousRevision: number }
  | { kind: "removed"; tabId: number; instance: Instance };

const KEY = "instances";

/**
 * Local identity of open tabs. A tabInstanceId is one concrete opening bound to a
 * native tabId; the documentRevision bumps when the document changes. Persisted in
 * storage.session so it survives service-worker suspension, not a browser restart.
 */
export class TabRegistry {
  private map = new Map<number, Instance>();
  constructor(
    private kv: KV,
    private uuid: () => string = () => crypto.randomUUID(),
    private now: () => number = Date.now,
  ) {}

  async load() {
    const saved = (await this.kv.get<Record<string, Instance>>(KEY)) ?? {};
    this.map = new Map(Object.entries(saved).map(([id, i]) => [Number(id), i]));
  }

  private async save() {
    await this.kv.set({ [KEY]: Object.fromEntries(this.map) });
  }

  get(tabId: number) {
    return this.map.get(tabId);
  }

  tabIdOf(tabInstanceId: string): number | undefined {
    for (const [tabId, i] of this.map) if (i.tabInstanceId === tabInstanceId) return tabId;
    return undefined;
  }

  instances() {
    return [...this.map.entries()];
  }

  /** Records a tab's committed URL; creates its instance or bumps its revision. */
  async observe(tabId: number, url: string | undefined): Promise<Change | null> {
    const docKey = url ? documentKey(url) : "";
    const current = this.map.get(tabId);
    if (!current) {
      const instance: Instance = {
        tabInstanceId: this.uuid(),
        documentRevision: 0,
        docKey,
        openedAt: this.now(),
        changedAt: this.now(),
      };
      this.map.set(tabId, instance);
      await this.save();
      return { kind: "created", tabId, instance };
    }
    if (!docKey || docKey === current.docKey) return null;
    const previousRevision = current.documentRevision;
    // First committed URL of a fresh tab is not a navigation away from anything.
    const instance: Instance = {
      ...current,
      docKey,
      documentRevision: current.docKey ? current.documentRevision + 1 : current.documentRevision,
      changedAt: this.now(),
    };
    this.map.set(tabId, instance);
    await this.save();
    return instance.documentRevision === previousRevision
      ? null
      : { kind: "navigated", tabId, instance, previousRevision };
  }

  async remove(tabId: number): Promise<Change | null> {
    const instance = this.map.get(tabId);
    if (!instance) return null;
    this.map.delete(tabId);
    await this.save();
    return { kind: "removed", tabId, instance };
  }

  /**
   * Chrome swapped a tab (prerender/instant). The replacement keeps the opening's
   * identity; its document is new only if the URL changed.
   */
  async replace(addedTabId: number, removedTabId: number, url: string | undefined): Promise<Change[]> {
    const old = this.map.get(removedTabId);
    if (!old) return this.observe(addedTabId, url).then((c) => (c ? [c] : []));
    this.map.delete(removedTabId);
    this.map.set(addedTabId, old);
    await this.save();
    const change = await this.observe(addedTabId, url);
    return change ? [change] : [];
  }

  /** Full reconciliation against Chrome after start-up or a missed event. */
  async reconcile(tabs: { id?: number; url?: string }[]): Promise<Change[]> {
    const changes: Change[] = [];
    const alive = new Set<number>();
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      alive.add(tab.id);
      const change = await this.observe(tab.id, tab.url);
      if (change) changes.push(change);
    }
    for (const [tabId, instance] of [...this.map]) {
      if (alive.has(tabId)) continue;
      this.map.delete(tabId);
      changes.push({ kind: "removed", tabId, instance });
    }
    if (changes.some((c) => c.kind === "removed")) await this.save();
    return changes;
  }
}
