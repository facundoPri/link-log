import { describe, expect, test } from "bun:test";
import { paintSelection, pickRange, type PaintStroke } from "../src/lib/paintSelection";

const order = ["a", "b", "c", "d", "e", "f"];
const stroke = (anchor: string, base: string[]): PaintStroke => ({ anchor, mode: !base.includes(anchor), base: new Set(base) });
const sorted = (ids: string[]) => [...ids].sort();

describe("paint selection range model", () => {
  test("the range runs from the anchor to the pointer, down and up", () => {
    const s = stroke("b", []);
    expect(sorted(paintSelection([], order, s, "e"))).toEqual(["b", "c", "d", "e"]);
    expect(sorted(paintSelection([], order, s, "a"))).toEqual(["a", "b"]);
  });

  test("moving back shrinks the range and rows outside it return to their state before the stroke", () => {
    const s = stroke("b", ["d"]);
    const wide = paintSelection(["d"], order, s, "f");
    expect(sorted(wide)).toEqual(["b", "c", "d", "e", "f"]);
    expect(sorted(paintSelection(wide, order, s, "c"))).toEqual(["b", "c", "d"]);
    expect(sorted(paintSelection(wide, order, s, "a"))).toEqual(["a", "b", "d"]);
  });

  test("a stroke that starts on a selected row clears, and moving back restores the rows it cleared", () => {
    const base = ["b", "c", "d", "e"];
    const s = stroke("c", base);
    expect(s.mode).toBe(false);
    const cleared = paintSelection(base, order, s, "e");
    expect(sorted(cleared)).toEqual(["b"]);
    expect(sorted(paintSelection(cleared, order, s, "c"))).toEqual(["b", "d", "e"]);
  });

  test("Escape (no target) restores the selection from before the stroke", () => {
    const s = stroke("a", ["f"]);
    const painted = paintSelection(["f"], order, s, "d");
    expect(sorted(paintSelection(painted, order, s, null))).toEqual(["f"]);
  });

  test("rows hidden by a filter keep their state", () => {
    const s = stroke("b", ["hidden"]);
    expect(sorted(paintSelection(["hidden"], order, s, "c"))).toEqual(["b", "c", "hidden"]);
    expect(paintSelection(["hidden"], order, s, null)).toEqual(["hidden"]);
  });

  test("a row that closes during the stroke is not selected again", () => {
    const s = stroke("a", ["c"]);
    const painted = paintSelection(["c"], order, s, "d");
    const closed = painted.filter((id) => id !== "c");
    expect(sorted(paintSelection(closed, order.filter((id) => id !== "c"), s, "e"))).toEqual(["a", "b", "d", "e"]);
  });

  test("an unchanged selection keeps its array, so React skips the render", () => {
    const s = stroke("b", []);
    const once = paintSelection([], order, s, "c");
    expect(paintSelection(once, order, s, "c")).toBe(once);
  });
});

describe("Shift+click range", () => {
  test("every row between the anchor and the clicked row takes the clicked row's new value", () => {
    expect(sorted(pickRange(["f"], order, "b", "d", true))).toEqual(["b", "c", "d", "f"]);
    expect(sorted(pickRange(order, order, "e", "b", false))).toEqual(["a", "f"]);
  });

  test("without an anchor in the list only the clicked row changes", () => {
    expect(pickRange([], order, null, "c", true)).toEqual(["c"]);
    expect(pickRange([], order, "gone", "c", true)).toEqual(["c"]);
  });
});
