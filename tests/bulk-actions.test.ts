import { describe, expect, test } from "bun:test";
import { actionForKey, actionState, actionStates, BULK_ACTIONS, type BulkContext } from "../src/bulkActions";
import type { Link, Tag } from "../src/types";

const link = (id: string, over: Partial<Link> = {}) =>
  ({ id, url: `https://${id}.example`, title: id, content_key: null, content_state: "missing", tags: [], ...over }) as unknown as Link;
const withContent = (id: string) => link(id, { content_key: `c/${id}`, content_state: "ready" });
const extracting = (id: string) => link(id, { content_state: "queued" });
const bare = (id: string) => link(id);

const tag = { id: "t1", name: "reading" } as unknown as Tag;
const ready: BulkContext = { tags: [tag], jevReason: null, running: false };
const state = (id: string, selected: Link[], ctx = ready) =>
  actionState(BULK_ACTIONS.find((a) => a.id === id)!, selected, ctx);
const key = (k: string, mods: Partial<Parameters<typeof actionForKey>[0]> = {}) =>
  actionForKey({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods });

// 4 with content (one still extracting), 3 without: the mixed selection a library usually has.
const mixed = [withContent("a"), withContent("b"), withContent("c"), extracting("d"), bare("x"), bare("y"), bare("z")];

describe("mixed selection", () => {
  test("auto-tag and lens run on the links with content and say how many were left out", () => {
    for (const id of ["autotag", "lens"]) {
      const s = state(id, mixed);
      expect(s.availability.eligible.map((l) => l.id)).toEqual(["a", "b", "c", "d"]);
      expect(s.availability.skipped.map((x) => x.link.id)).toEqual(["x", "y", "z"]);
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
    const ctx = { tags: [], jevReason: "Jev is not configured.", running: false };
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
    for (const s of actionStates([], ready)) expect(s.disabled).toBe(true);
  });
});

describe("shortcuts", () => {
  test("letters run their action, case-insensitively", () => {
    expect(key("t")?.id).toBe("autotag");
    expect(key("T")?.id).toBe("autotag");
    expect(key("l")?.id).toBe("lens");
    expect(key("e")?.id).toBe("extract");
    expect(key("c")?.id).toBe("copy");
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
    expect(BULK_ACTIONS.map((a) => a.id)).toEqual(["autotag", "lens", "extract", "copy", "copy-titles"]);
    expect(BULK_ACTIONS.filter((a) => a.promoted).map((a) => a.id)).toEqual(["autotag", "lens", "extract"]);
    expect(BULK_ACTIONS.find((a) => a.id === "lens")?.picker).toBe("lens");
  });

  test("lens runs only once a lens is chosen", () => {
    const calls: string[] = [];
    const runners = { autotag: () => calls.push("autotag"), lens: (id: string) => calls.push(`lens:${id}`), extract: () => calls.push("extract"), copy: () => calls.push("copy") };
    const lens = BULK_ACTIONS.find((a) => a.id === "lens")!;
    void lens.run(runners, mixed);
    expect(calls).toEqual([]);
    void lens.run(runners, mixed, "l1");
    expect(calls).toEqual(["lens:l1"]);
  });
});
