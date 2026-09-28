import type { KV, Mutex } from "./kv";

export type GroupMeta = { description: string; pinnedId: string | null };
/** What Chrome tells us about a native group. */
export type NativeGroup = { id: number; title?: string; color: string };
/** Last known look of a group bound to a pinned definition, kept across restarts. */
type Hint = { groupId: number; pinnedId: string; title: string; color: string; description: string };

const KEY = "groups";
const HINTS = "pinnedHints";
const RESTORE = "pinnedRestore";
/** How long after a fresh session restored groups may still show up and be re-bound. */
export const RESTORE_WINDOW_MS = 2 * 60_000;

const signature = (title: string | undefined, color: string) => `${title ?? ""}\u0000${color}`;

/**
 * Linklog metadata for native tab groups: Chrome has no description, and a pinned
 * binding links one native group to a shared definition. Local to this browser
 * session; closing the group discards it.
 *
 * Bindings live in storage.session, which Chrome clears on restart (and on an
 * extension reload), while Chrome may restore the groups themselves. So the look of
 * each bound group (title, color, description) is also kept in storage.local, and a
 * fresh session re-binds restored groups when the match is unambiguous: same group
 * id (extension reload) or same title + color for exactly one pinned definition.
 * Anything ambiguous stays unbound; names never merge groups on their own.
 */
export class GroupMetaStore {
  private map = new Map<number, GroupMeta>();
  private restore: { until: number; hints: Hint[] } | null = null;
  /** Called after metadata changes so the hints can be refreshed. */
  onChange: (() => void) | null = null;

  constructor(
    private kv: KV,
    private mutex: Mutex,
    private local: KV | null = null,
    private now: () => number = Date.now,
  ) {}

  async load() {
    const saved = (await this.kv.get<Record<string, GroupMeta>>(KEY)) ?? {};
    this.map = new Map(Object.entries(saved).map(([id, m]) => [Number(id), m]));
    this.restore = (await this.kv.get<{ until: number; hints: Hint[] }>(RESTORE)) ?? null;
  }

  /** A new browser session (restart or extension reload): stored hints become restore candidates. */
  async beginRestore() {
    if (!this.local) return;
    const hints = Object.values((await this.local.get<Record<string, Hint>>(HINTS)) ?? {});
    this.restore = hints.length ? { until: this.now() + RESTORE_WINDOW_MS, hints } : null;
    await this.kv.set({ [RESTORE]: this.restore });
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
      this.onChange?.();
    });
  }

  remove(groupId: number) {
    return this.mutex.run(async () => {
      if (this.map.delete(groupId)) {
        await this.save();
        this.onChange?.();
      }
    });
  }

  /** Unpin: bindings go away, the native groups and their descriptions stay. */
  unbindPinned(pinnedId: string) {
    return this.mutex.run(async () => {
      const ids = this.groupsBoundTo(pinnedId);
      for (const id of ids) this.map.set(id, { ...this.get(id), pinnedId: null });
      if (this.restore) this.restore.hints = this.restore.hints.filter((h) => h.pinnedId !== pinnedId);
      if (ids.length) await this.save();
      this.onChange?.();
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

  /**
   * Re-binds groups Chrome restored after a restart/reload. Returns how many were bound.
   * Only runs during the restore window of a fresh session.
   */
  restoreBindings(alive: NativeGroup[]) {
    return this.mutex.run(async () => {
      const restore = this.restore;
      if (!restore) return 0;
      if (this.now() > restore.until || !restore.hints.length) {
        this.restore = null;
        await this.kv.set({ [RESTORE]: null });
        return 0;
      }
      const free = alive.filter((g) => !this.map.get(g.id)?.pinnedId);
      let hints = restore.hints;
      let bound = 0;
      const bind = (g: NativeGroup, h: Hint) => {
        this.map.set(g.id, { description: this.get(g.id).description || h.description, pinnedId: h.pinnedId });
        bound++;
      };
      // Extension reload: Chrome kept the very same group.
      for (const h of [...hints]) {
        const g = free.find((x) => x.id === h.groupId && signature(x.title, x.color) === signature(h.title, h.color));
        if (!g) continue;
        bind(g, h);
        free.splice(free.indexOf(g), 1);
        hints = hints.filter((x) => x !== h);
      }
      // Browser restart: new ids. Title + color must point to a single definition, and
      // there may not be more such groups than were bound before.
      const bySig = new Map<string, Hint[]>();
      for (const h of hints) if (h.title) bySig.set(signature(h.title, h.color), [...(bySig.get(signature(h.title, h.color)) ?? []), h]);
      for (const [sig, group] of bySig) {
        if (new Set(group.map((h) => h.pinnedId)).size !== 1) continue;
        const candidates = free.filter((g) => signature(g.title, g.color) === sig);
        if (!candidates.length || candidates.length > group.length) continue;
        candidates.forEach((g, i) => bind(g, group[i]!));
        const used = new Set(group.slice(0, candidates.length));
        hints = hints.filter((h) => !used.has(h));
      }
      restore.hints = hints;
      await this.kv.set({ [RESTORE]: restore });
      if (bound) await this.save();
      return bound;
    });
  }

  /** Keeps the look of bound groups in storage.local so a restart can re-bind them. */
  syncHints(alive: NativeGroup[]) {
    return this.mutex.run(async () => {
      if (!this.local) return;
      const hints: Record<string, Hint> = {};
      // Candidates still waiting for their group survive a second restart.
      for (const h of this.restore?.hints ?? []) hints[`old:${h.groupId}`] = h;
      for (const g of alive) {
        const m = this.map.get(g.id);
        if (m?.pinnedId) hints[String(g.id)] = { groupId: g.id, pinnedId: m.pinnedId, title: g.title ?? "", color: g.color, description: m.description };
      }
      const before = (await this.local.get<Record<string, Hint>>(HINTS)) ?? {};
      if (JSON.stringify(before) !== JSON.stringify(hints)) await this.local.set({ [HINTS]: hints });
    });
  }
}
