import type {
  BrowserGroup,
  BrowserTab,
  WindowPatch,
  WindowSnapshot,
} from "./browser.ts";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Small change set between two snapshots of the same window; null if nothing changed. */
export function diffSnapshots(
  prev: WindowSnapshot,
  next: Omit<WindowSnapshot, "revision">,
  revision: number,
): WindowPatch | null {
  const before = new Map(prev.tabs.map((t) => [t.tabId, t]));
  const after = new Map(next.tabs.map((t) => [t.tabId, t]));
  const upsertTabs: BrowserTab[] = [];
  for (const [id, tab] of after) {
    const old = before.get(id);
    // index changes are carried by `order`
    if (!old || !same({ ...old, index: 0 }, { ...tab, index: 0 })) upsertTabs.push(tab);
  }
  const removeTabs = [...before.keys()].filter((id) => !after.has(id));
  const beforeGroups = new Map(prev.groups.map((g) => [g.groupId, g]));
  const afterGroups = new Map(next.groups.map((g) => [g.groupId, g]));
  const upsertGroups: BrowserGroup[] = [];
  for (const [id, group] of afterGroups)
    if (!same(beforeGroups.get(id), group)) upsertGroups.push(group);
  const removeGroups = [...beforeGroups.keys()].filter((id) => !afterGroups.has(id));
  const order = next.tabs.map((t) => t.tabId);
  const orderChanged = !same(order, prev.tabs.map((t) => t.tabId));
  if (
    !upsertTabs.length &&
    !removeTabs.length &&
    !upsertGroups.length &&
    !removeGroups.length &&
    !orderChanged &&
    prev.linklogTabs === next.linklogTabs
  )
    return null;
  return {
    baseRevision: prev.revision,
    revision,
    windowId: next.windowId,
    upsertTabs,
    removeTabs,
    order,
    upsertGroups,
    removeGroups,
    linklogTabs: next.linklogTabs,
  };
}

/** Returns null when the patch does not apply to this revision; the caller must request a snapshot. */
export function applyPatch(
  snapshot: WindowSnapshot,
  patch: WindowPatch,
): WindowSnapshot | null {
  if (patch.baseRevision !== snapshot.revision || patch.windowId !== snapshot.windowId)
    return null;
  const tabs = new Map(snapshot.tabs.map((t) => [t.tabId, t]));
  for (const id of patch.removeTabs) tabs.delete(id);
  for (const t of patch.upsertTabs) tabs.set(t.tabId, t);
  const ordered: BrowserTab[] = [];
  for (const [index, id] of patch.order.entries()) {
    const tab = tabs.get(id);
    if (!tab) return null;
    ordered.push({ ...tab, index });
  }
  if (ordered.length !== tabs.size) return null;
  const groups = new Map(snapshot.groups.map((g) => [g.groupId, g]));
  for (const id of patch.removeGroups) groups.delete(id);
  for (const g of patch.upsertGroups) groups.set(g.groupId, g);
  return {
    revision: patch.revision,
    windowId: patch.windowId,
    tabs: ordered,
    groups: [...groups.values()],
    linklogTabs: patch.linklogTabs,
  };
}
