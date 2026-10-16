import { describe, expect, test } from "bun:test";
import { GroupMetaStore, RESTORE_WINDOW_MS, type NativeGroup } from "../src/background/groups";
import { memoryKV, Mutex } from "../src/background/kv";

const A = "local:library-a";
const B = "local:library-b";

/** A browser session: session storage is new each time, local storage survives. */
function session(local = memoryKV(), now = () => 1000) {
  const store = new GroupMetaStore(memoryKV(), new Mutex(), local, now);
  return { store, local };
}

describe("pinned bindings across restarts", () => {
  test("a restored group with the same title and color is re-bound once", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(7, { pinnedId: "p1", description: "Papers" }, A);
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
    expect(next.store.view(31, A)).toEqual({ pinnedId: "p1", description: "Papers" });
    expect(next.store.view(32, A).pinnedId).toBeNull();
    // Hints are consumed: a later group with the same name is not bound.
    expect(await next.store.restoreBindings([...restored, { id: 33, title: "Research", color: "blue" }])).toBe(0);
    expect(next.store.view(33, A).pinnedId).toBeNull();
  });

  test("extension reload keeps group ids: matched by id", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(5, { pinnedId: "p1", description: "" }, A);
    await store.syncHints([{ id: 5, title: "Research", color: "red" }]);
    const next = session(local);
    await next.store.load();
    await next.store.beginRestore();
    expect(await next.store.restoreBindings([{ id: 5, title: "Research", color: "red" }])).toBe(1);
    expect(next.store.groupsBoundTo("p1", A)).toEqual([5]);
  });

  test("ambiguous matches stay unbound (names never merge groups)", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(1, { pinnedId: "p1", description: "" }, A);
    await store.set(2, { pinnedId: "p2", description: "" }, A);
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
    await one.store.set(1, { pinnedId: "p1", description: "" }, A);
    await one.store.syncHints([{ id: 1, title: "Work", color: "green" }]);
    const after = session(one.local);
    await after.store.load();
    await after.store.beginRestore();
    expect(await after.store.restoreBindings([{ id: 8, title: "Work", color: "green" }, { id: 9, title: "Work", color: "green" }])).toBe(0);
  });

  test("restoring stops after the restore window", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(1, { pinnedId: "p1", description: "" }, A);
    await store.syncHints([{ id: 1, title: "Work", color: "green" }]);
    let now = 1000;
    const next = session(local, () => now);
    await next.store.load();
    await next.store.beginRestore();
    now += RESTORE_WINDOW_MS + 1;
    expect(await next.store.restoreBindings([{ id: 3, title: "Work", color: "green" }])).toBe(0);
  });
});

describe("Linklog group metadata is private to the account (library scope) that wrote it", () => {
  test("another account in the same profile sees no description or binding", async () => {
    const { store } = session();
    await store.load();
    await store.set(7, { pinnedId: "pin-a", description: "A's private notes" }, A);
    expect(store.view(7, A)).toEqual({ pinnedId: "pin-a", description: "A's private notes" });
    expect(store.view(7, B)).toEqual({ pinnedId: null, description: "" });
    expect(store.view(7, null)).toEqual({ pinnedId: null, description: "" });
    expect(store.groupsBoundTo("pin-a", B)).toEqual([]);
    expect(await store.unbindPinned("pin-a", B)).toBe(0);
    // B editing the group replaces A's metadata instead of merging into it.
    await store.set(7, { pinnedId: "pin-b" }, B);
    expect(store.view(7, B)).toEqual({ pinnedId: "pin-b", description: "" });
    expect(store.view(7, A)).toEqual({ pinnedId: null, description: "" });
  });

  test("restart hints keep their account; B never inherits A's restored binding", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(7, { pinnedId: "pin-a", description: "A's private notes" }, A);
    await store.syncHints([{ id: 7, title: "Research", color: "blue" }]);
    const next = session(local);
    await next.store.load();
    await next.store.beginRestore();
    expect(await next.store.restoreBindings([{ id: 31, title: "Research", color: "blue" }])).toBe(1);
    expect(next.store.view(31, A).description).toBe("A's private notes");
    expect(next.store.view(31, B)).toEqual({ pinnedId: null, description: "" });
  });

  test("hints and metadata from before scopes are never shown or re-bound", async () => {
    const kv = memoryKV();
    const local = memoryKV();
    await kv.set({ groups: { "5": { description: "old", pinnedId: "p-old" } } });
    await local.set({ pinnedHints: { "5": { groupId: 5, pinnedId: "p-old", title: "Old", color: "red", description: "old" } } });
    const store = new GroupMetaStore(kv, new Mutex(), local, () => 1000);
    await store.load();
    expect(store.view(5, A)).toEqual({ pinnedId: null, description: "" });
    await store.beginRestore();
    expect(await store.restoreBindings([{ id: 9, title: "Old", color: "red" }])).toBe(0);
  });

  test("forget removes the account's metadata and restart hints, keeping other accounts'", async () => {
    const { store, local } = session();
    await store.load();
    await store.set(1, { pinnedId: "pin-a", description: "a" }, A);
    await store.set(2, { pinnedId: "pin-b", description: "b" }, B);
    await store.syncHints([
      { id: 1, title: "A", color: "blue" },
      { id: 2, title: "B", color: "red" },
    ]);
    await store.forget(A);
    expect(store.view(1, A)).toEqual({ pinnedId: null, description: "" });
    expect(store.view(2, B)).toEqual({ pinnedId: "pin-b", description: "b" });
    const hints = (await local.get<Record<string, { scope: string }>>("pinnedHints"))!;
    expect(Object.values(hints).map((h) => h.scope)).toEqual([B]);
  });
});
