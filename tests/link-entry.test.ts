import { expect, test } from "bun:test";
import { togglePick } from "../src/components/LinkEntryPage";

const a = { id: "a", label: "a" };
const b = { id: "b", label: "b" };

test("tags toggle and keep their order; a group replaces the one picked before", () => {
  expect(togglePick([], a, true)).toEqual([a]);
  expect(togglePick([a], b, true)).toEqual([a, b]);
  expect(togglePick([a, b], a, true)).toEqual([b]);
  expect(togglePick([a], b, false)).toEqual([b]);
  expect(togglePick([b], b, false)).toEqual([]);
});
