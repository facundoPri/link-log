import type { KV, Mutex } from "./kv";

export type GroupMeta = { description: string; pinnedId: string | null };
const KEY = "groups";

/**
 * Linklog metadata for native tab groups: Chrome has no description, and a pinned
 * binding links one native group to a shared definition. Local to this browser
 * session; closing the group discards it.
 */
export class GroupMetaStore {
  private map = new Map<number, GroupMeta>();
  constructor(
    private kv: KV,
    private mutex: Mutex,
  ) {}

  async load() {
    const saved = (await this.kv.get<Record<string, GroupMeta>>(KEY)) ?? {};
    this.map = new Map(Object.entries(saved).map(([id, m]) => [Number(id), m]));
  }

  private save() {
    return this.kv.set({ [KEY]: Object.fromEntries(this.map) });
  }

  get(groupId: number): GroupMeta {
    return this.map.get(groupId) ?? { description: "", pinnedId: null };
  }

  groupsBoundTo(pinnedId: string): number[] {
    return [...this.map].filter(([, m]) => m.pinnedId === pinnedId).map(([id]) => id);
  }

  set(groupId: number, patch: Partial<GroupMeta>) {
    return this.mutex.run(async () => {
      this.map.set(groupId, { ...this.get(groupId), ...patch });
      await this.save();
    });
  }

  remove(groupId: number) {
    return this.mutex.run(async () => {
      if (this.map.delete(groupId)) await this.save();
    });
  }

  /** Unpin: bindings go away, the native groups and their descriptions stay. */
  unbindPinned(pinnedId: string) {
    return this.mutex.run(async () => {
      const ids = this.groupsBoundTo(pinnedId);
      for (const id of ids) this.map.set(id, { ...this.get(id), pinnedId: null });
      if (ids.length) await this.save();
      return ids.length;
    });
  }

  /** Drops metadata of groups Chrome no longer has (missed onRemoved while suspended). */
  prune(alive: Set<number>) {
    return this.mutex.run(async () => {
      let changed = false;
      for (const id of [...this.map.keys()])
        if (!alive.has(id)) {
          this.map.delete(id);
          changed = true;
        }
      if (changed) await this.save();
    });
  }
}
