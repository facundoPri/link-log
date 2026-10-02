import { describe, expect, test } from "bun:test";
import { GroupMetaStore, RESTORE_WINDOW_MS, type NativeGroup } from "../src/background/groups";
import { memoryKV, Mutex } from "../src/background/kv";

/** A browser session: session storage is new each time, local storage survives. */
function session(local = memoryKV(), now = () => 1000) {
  const store = new GroupMetaStore(memoryKV(), new Mutex(), local, now);
  return { store, local };
}

describe("pinned bindings across restarts", () => {
  test("a restored group with the same title and color is re-bound once", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(7, { pinnedId: "p1", description: "Papers" });
    await store.syncHints([{ id: 7, title: "Research", color: "blue" }]);

    // Chrome restarts: new ids, empty session storage.
    const next = session(local);
    await next.store.load();
    await next.store.beginRestore();
    const restored: NativeGroup[] = [
      { id: 31, title: "Research", color: "blue" },
      { id: 32, title: "Other", color: "blue" },
    ];
    expect(await next.store.restoreBindings(restored)).toBe(1);
    expect(next.store.get(31)).toEqual({ pinnedId: "p1", description: "Papers" });
    expect(next.store.get(32).pinnedId).toBeNull();
    // Hints are consumed: a later group with the same name is not bound.
    expect(await next.store.restoreBindings([...restored, { id: 33, title: "Research", color: "blue" }])).toBe(0);
    expect(next.store.get(33).pinnedId).toBeNull();
  });

  test("extension reload keeps group ids: matched by id", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(5, { pinnedId: "p1", description: "" });
    await store.syncHints([{ id: 5, title: "Research", color: "red" }]);
    const next = session(local);
    await next.store.load();
    await next.store.beginRestore();
    expect(await next.store.restoreBindings([{ id: 5, title: "Research", color: "red" }])).toBe(1);
    expect(next.store.groupsBoundTo("p1")).toEqual([5]);
  });

  test("ambiguous matches stay unbound (names never merge groups)", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(1, { pinnedId: "p1", description: "" });
    await store.set(2, { pinnedId: "p2", description: "" });
    // Two definitions whose groups looked the same.
    await store.syncHints([
      { id: 1, title: "Research", color: "blue" },
      { id: 2, title: "Research", color: "blue" },
    ]);
    const next = session(local);
    await next.store.load();
    await next.store.beginRestore();
    expect(await next.store.restoreBindings([{ id: 40, title: "Research", color: "blue" }])).toBe(0);

    // More candidates than groups that were bound: also ambiguous.
    const one = session();
    await one.store.load();
    await one.store.set(1, { pinnedId: "p1", description: "" });
    await one.store.syncHints([{ id: 1, title: "Work", color: "green" }]);
    const after = session(one.local);
    await after.store.load();
    await after.store.beginRestore();
    expect(await after.store.restoreBindings([{ id: 8, title: "Work", color: "green" }, { id: 9, title: "Work", color: "green" }])).toBe(0);
  });

  test("restoring stops after the restore window", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(1, { pinnedId: "p1", description: "" });
    await store.syncHints([{ id: 1, title: "Work", color: "green" }]);
    let now = 1000;
    const next = session(local, () => now);
    await next.store.load();
    await next.store.beginRestore();
    now += RESTORE_WINDOW_MS + 1;
    expect(await next.store.restoreBindings([{ id: 3, title: "Work", color: "green" }])).toBe(0);
  });
});
