import { describe, expect, test } from "bun:test";
import type { BrowserTab } from "@linklog/browser-protocol";
import { actionForKey, actionState, actionStates, BULK_ACTIONS, bulkProgress, routeKey, type ActionMeta, type BulkContext, type KeyScene } from "../src/bulkActions";
import { TAB_ACTIONS, type TabContext } from "../src/browser/tabActions";
import type { Batch, Link, Tag } from "../src/types";

const link = (id: string, over: Partial<Link> = {}) =>
  ({ id, url: `https://${id}.example`, title: id, content_key: null, content_state: "missing", tags: [], ...over }) as unknown as Link;
const withContent = (id: string) => link(id, { content_key: `c/${id}`, content_state: "ready" });
const extracting = (id: string) => link(id, { content_state: "queued" });
const bare = (id: string) => link(id);

const tag = { id: "t1", name: "reading" } as unknown as Tag;
const ready: BulkContext = { tags: [tag], jevReason: null, running: false, openReason: null, opening: false };
const state = (id: string, selected: Link[], ctx = ready) =>
  actionState(BULK_ACTIONS.find((a) => a.id === id)!, selected, ctx);
const key = (k: string, mods: Partial<Parameters<typeof actionForKey>[0]> = {}) =>
  actionForKey({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods }, BULK_ACTIONS);

// 4 with content (one still extracting), 3 without: the mixed selection a library usually has.
const mixed = [withContent("a"), withContent("b"), withContent("c"), extracting("d"), bare("x"), bare("y"), bare("z")];

describe("mixed selection", () => {
  test("auto-tag and lens run on the links with content and say how many were left out", () => {
    for (const id of ["autotag", "lens"]) {
      const s = state(id, mixed);
      expect(s.availability.eligible.map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
      expect(s.availability.skipped.map((x) => x.item.id)).toEqual(["x", "y", "z"]);
      expect(s.badge).toBe("4/7");
      expect(s.disabled).toBe(false);
    }
    expect(state("autotag", mixed).reason).toBe("3 of 7 links have no content yet");
    expect(state("lens", mixed).reason).toBe("3 of 7 links have no content and will be skipped");
  });

  test("every skipped link carries a reason", () => {
    for (const id of ["autotag", "lens"])
      for (const { reason } of state(id, mixed).availability.skipped) expect(reason).not.toBe("");
  });

  test("extract and copy apply to every selected link, with no badge", () => {
    for (const id of ["extract", "copy", "copy-titles"]) {
      const s = state(id, mixed);
      expect(s.availability.eligible).toHaveLength(7);
      expect(s.availability.skipped).toEqual([]);
      expect(s.badge).toBeNull();
      expect(s.reason).toBeNull();
      expect(s.disabled).toBe(false);
    }
  });

  test("a fully eligible selection has no badge or reason", () => {
    const s = state("autotag", [withContent("a"), withContent("b")]);
    expect(s.badge).toBeNull();
    expect(s.reason).toBeNull();
  });
});

describe("blocked actions", () => {
  test("Jev not configured blocks auto-tag and lens with its reason, and leaves extract and copy alone", () => {
    const ctx = { ...ready, jevReason: "Jev is not configured: API key missing." };
    for (const id of ["autotag", "lens"]) {
      const s = state(id, mixed, ctx);
      expect(s.availability.blocked).toBe("Jev is not configured: API key missing.");
      expect(s.disabled).toBe(true);
      expect(s.reason).toBe("Jev is not configured: API key missing.");
      expect(s.badge).toBeNull();
    }
    for (const id of ["extract", "copy", "copy-titles"]) expect(state(id, mixed, ctx).disabled).toBe(false);
  });

  test("no tags blocks auto-tag only", () => {
    const ctx = { ...ready, tags: [] };
    expect(state("autotag", mixed, ctx).availability.blocked).toBe("Create a tag first");
    expect(state("lens", mixed, ctx).disabled).toBe(false);
  });

  test("Jev's reason wins over the missing-tags reason", () => {
    const ctx = { ...ready, tags: [], jevReason: "Jev is not configured." };
    expect(state("autotag", mixed, ctx).availability.blocked).toBe("Jev is not configured.");
  });

  test("a batch in flight blocks auto-tag, lens and extract but not copy", () => {
    const ctx = { ...ready, running: true };
    for (const id of ["autotag", "lens", "extract"]) {
      expect(state(id, mixed, ctx).availability.blocked).toBe("Some links are still processing");
      expect(state(id, mixed, ctx).disabled).toBe(true);
    }
    expect(state("copy", mixed, ctx).disabled).toBe(false);
  });

  test("lens is blocked when no selected link has content; auto-tag still starts so it can offer to extract first", () => {
    const none = [bare("x"), bare("y")];
    expect(state("lens", none).availability.blocked).toBe("2 of 2 links need context first");
    expect(state("lens", none).disabled).toBe(true);
    expect(state("autotag", none).disabled).toBe(false);
    expect(state("autotag", none).badge).toBe("0/2");
  });

  test("a link whose extraction is queued counts as having content", () => {
    expect(state("lens", [extracting("q")]).disabled).toBe(false);
    expect(state("lens", [extracting("q")]).badge).toBeNull();
  });

  test("nothing is runnable with nothing selected", () => {
    for (const s of actionStates(BULK_ACTIONS, [], ready)) expect(s.disabled).toBe(true);
  });
});

describe("open", () => {
  test("opens every selected link, including ones without content", () => {
    const s = state("open", mixed);
    expect(s.availability.eligible).toHaveLength(7);
    expect(s.disabled).toBe(false);
    expect(s.badge).toBeNull();
    expect(s.action.barLabel?.(s.availability.eligible.length)).toBe("Open 7");
  });

  test("the extension's reason blocks it and leaves the other actions alone", () => {
    const ctx = { ...ready, openReason: "Install or enable the Linklog extension to open links" };
    const s = state("open", mixed, ctx);
    expect(s.disabled).toBe(true);
    expect(s.reason).toBe("Install or enable the Linklog extension to open links");
    for (const id of ["autotag", "lens", "extract", "copy"]) expect(state(id, mixed, ctx).disabled).toBe(false);
  });

  test("more than 50 selected links is blocked, 50 is not", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => bare(`m${i}`));
    expect(state("open", many(50)).disabled).toBe(false);
    expect(state("open", many(51)).availability.blocked).toBe("Open up to 50 links at once");
  });

  test("an open in flight blocks a second one, but a batch in flight does not", () => {
    expect(state("open", mixed, { ...ready, opening: true }).disabled).toBe(true);
    expect(state("open", mixed, { ...ready, running: true }).disabled).toBe(false);
  });
});

describe("shortcuts", () => {
  test("letters run their action, case-insensitively", () => {
    expect(key("t")?.id).toBe("autotag");
    expect(key("T")?.id).toBe("autotag");
    expect(key("l")?.id).toBe("lens");
    expect(key("e")?.id).toBe("extract");
    expect(key("c")?.id).toBe("copy");
    expect(key("o")?.id).toBe("open");
  });

  test("shift+C is the copy-with-titles variant, not plain copy", () => {
    expect(key("C", { shiftKey: true })?.id).toBe("copy-titles");
    expect(key("t", { shiftKey: true })).toBeNull();
  });

  test("⌘, Ctrl and Alt combinations never run an action", () => {
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(key("c", mod)).toBeNull();
      expect(key("a", mod)).toBeNull();
    }
  });

  test("other keys run nothing, and every shortcut is unique", () => {
    expect(key("x")).toBeNull();
    expect(key("Escape")).toBeNull();
    const shortcuts = BULK_ACTIONS.map((a) => a.shortcut).filter(Boolean);
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });
});

describe("registry", () => {
  test("holds exactly the actions that exist today, in bar order", () => {
    expect(BULK_ACTIONS.map((a) => a.id)).toEqual(["autotag", "lens", "extract", "open", "copy", "copy-titles"]);
    expect(BULK_ACTIONS.filter((a) => a.promoted).map((a) => a.id)).toEqual(["autotag", "lens", "open"]);
    expect(BULK_ACTIONS.find((a) => a.id === "lens")?.picker).toBe("lens");
  });

  test("lens runs only once a lens is chosen", () => {
    const calls: string[] = [];
    const runners = { autotag: () => calls.push("autotag"), lens: (id: string) => calls.push(`lens:${id}`), extract: () => calls.push("extract"), copy: () => calls.push("copy"), open: () => calls.push("open") };
    const lens = BULK_ACTIONS.find((a) => a.id === "lens")!;
    void lens.run(runners, mixed);
    expect(calls).toEqual([]);
    void lens.run(runners, mixed, "l1");
    expect(calls).toEqual(["lens:l1"]);
  });
});

describe("progress of a run started from the selection", () => {
  const batch = (id: string, kind: Batch["kind"], total: number, active: number) => ({ id, kind, total, active }) as Batch;

  test("reports done over total for the active batch, and nothing once it settles", () => {
    const started = new Set(["b1"]);
    expect(bulkProgress([batch("b1", "extract", 12, 10)], started)).toEqual({ label: "Extracting", done: 2, total: 12 });
    expect(bulkProgress([batch("b1", "extract", 12, 0)], started)).toBeNull();
  });

  test("sums the chunks of one run and ignores batches the selection did not start", () => {
    const started = new Set(["b1", "b2"]);
    const batches = [batch("b1", "autotag", 100, 40), batch("b2", "autotag", 20, 20), batch("other", "extract", 5, 5)];
    expect(bulkProgress(batches, started)).toEqual({ label: "Auto-tagging", done: 60, total: 120 });
  });

  test("the drawer shortens only the label that would not fit", () => {
    expect(BULK_ACTIONS.filter((a) => a.tileLabel).map((a) => [a.id, a.tileLabel])).toEqual([["extract", "Extract"]]);
  });
});

const press = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, repeat: false, ...mods });
const scene = (over: Partial<KeyScene> = {}): KeyScene => ({ selected: 0, paletteOpen: false, typing: false, overlay: false, ...over });
const cmdK = press("k", { metaKey: true });

describe("one ⌘K: the command palette in every view and selection", () => {
  test("⌘K opens the palette with nothing, one or several selected, in Library and in Browser", () => {
    for (const actions of [BULK_ACTIONS, TAB_ACTIONS] as ActionMeta[][])
      for (const selected of [0, 1, 3]) expect(routeKey(cmdK, actions, scene({ selected }))).toEqual({ kind: "palette" });
    expect(routeKey(press("K", { ctrlKey: true }), TAB_ACTIONS, scene())).toEqual({ kind: "palette" });
  });

  test("⌘K toggles the open palette closed, also while its filter has focus", () => {
    expect(routeKey(cmdK, BULK_ACTIONS, scene({ paletteOpen: true, overlay: true, typing: true }))).toEqual({ kind: "palette" });
  });

  test("⌘K from a text field still opens the palette; another dialog or menu swallows it", () => {
    expect(routeKey(cmdK, BULK_ACTIONS, scene({ typing: true }))).toEqual({ kind: "palette" });
    expect(routeKey(cmdK, BULK_ACTIONS, scene({ overlay: true }))).toEqual({ kind: "ignore" });
    expect(routeKey(cmdK, TAB_ACTIONS, scene({ selected: 2, overlay: true }))).toEqual({ kind: "ignore" });
  });

  test("letters run the view's own actions, only with a selection and nothing in the way", () => {
    expect(routeKey(press("t"), BULK_ACTIONS, scene({ selected: 1 }))).toMatchObject({ kind: "action", action: { id: "autotag" } });
    expect(routeKey(press("s"), TAB_ACTIONS, scene({ selected: 1 }))).toMatchObject({ kind: "action", action: { id: "save" } });
    expect(routeKey(press("g"), TAB_ACTIONS, scene({ selected: 2 }))).toMatchObject({ kind: "action", action: { id: "group" } });
    expect(routeKey(press("C", { shiftKey: true }), TAB_ACTIONS, scene({ selected: 2 }))).toMatchObject({ action: { id: "copy-titles" } });
    expect(routeKey(press("t"), TAB_ACTIONS, scene({ selected: 2 }))).toBeNull();
    expect(routeKey(press("s"), TAB_ACTIONS, scene())).toBeNull();
    expect(routeKey(press("s"), TAB_ACTIONS, scene({ selected: 1, typing: true }))).toBeNull();
    expect(routeKey(press("s"), TAB_ACTIONS, scene({ selected: 1, overlay: true }))).toBeNull();
    expect(routeKey(press("s", { repeat: true }), TAB_ACTIONS, scene({ selected: 1 }))).toBeNull();
    expect(routeKey(press("a", { metaKey: true }), TAB_ACTIONS, scene({ selected: 1 }))).toBeNull();
  });

  test("closing tabs has no key: it is destructive and runs from the palette or the drawer", () => {
    const close = TAB_ACTIONS.find((a) => a.id === "close")!;
    expect(close.group).toBe("Danger");
    expect(close.shortcut).toBeUndefined();
  });

  test("every shortcut is unique within its registry", () => {
    for (const actions of [BULK_ACTIONS, TAB_ACTIONS] as ActionMeta[][]) {
      const keys = actions.flatMap((a) => (a.shortcut ? [a.shortcut.toLowerCase()] : []));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

const tab = (tabId: number, groupId: number | null = null) =>
  ({ tabId, tabInstanceId: `i${tabId}`, documentRevision: 0, url: `https://t${tabId}.dev/`, title: `Tab ${tabId}`, groupId }) as unknown as BrowserTab;
const tabCtx: TabContext = { busy: false, jevReason: null, destinations: 2 };
const tabState = (id: string, tabs: BrowserTab[], ctx = tabCtx) => actionState(TAB_ACTIONS.find((a) => a.id === id)!, tabs, ctx);

describe("tab actions", () => {
  const mixed = [tab(1), tab(2, 7), tab(3)];

  test("autogroup places only ungrouped tabs and says how many keep their group", () => {
    const s = tabState("autogroup", mixed);
    expect(s.availability.eligible.map((t) => t.tabId)).toEqual([1, 3]);
    expect(s.availability.skipped.map((x) => [x.item.tabId, x.reason])).toEqual([[2, "Already in a group"]]);
    expect(s.badge).toBe("2/3");
    expect(s.reason).toBe("1 of 3 already have a group and stay there");
  });

  test("autogroup is blocked with the reason the old bar showed", () => {
    expect(tabState("autogroup", mixed, { ...tabCtx, jevReason: "Jev is not configured." }).reason).toBe("Jev is not configured.");
    expect(tabState("autogroup", mixed, { ...tabCtx, destinations: 0 }).reason).toBe("Create or pin a group with a description first");
    expect(tabState("autogroup", [tab(2, 7)]).reason).toBe("Autogroup only places tabs that have no group");
  });

  test("remove from group skips ungrouped tabs and is blocked when none is grouped", () => {
    expect(tabState("ungroup", mixed).availability.eligible.map((t) => t.tabId)).toEqual([2]);
    expect(tabState("ungroup", [tab(1)]).disabled).toBe(true);
  });

  test("a running tab action blocks the others that change tabs, not copying", () => {
    const busy = { ...tabCtx, busy: true };
    for (const id of ["save", "group", "autogroup", "ungroup", "close"]) expect(tabState(id, mixed, busy).disabled).toBe(true);
    for (const id of ["copy", "copy-titles"]) expect(tabState(id, mixed, busy).disabled).toBe(false);
  });

  test("the bar promotes Save, Move to group and Autogroup, like Library promotes three", () => {
    expect(TAB_ACTIONS.filter((a) => a.promoted).map((a) => a.id)).toEqual(["save", "group", "autogroup"]);
  });
});
