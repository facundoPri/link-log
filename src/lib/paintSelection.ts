/** A paint stroke: rows between `anchor` and the pointer take `mode`; every other row goes back to `base`. */
export type PaintStroke = { anchor: string; mode: boolean; base: ReadonlySet<string> };

function withChanges(current: string[], changes: Map<string, boolean>): string[] {
  const has = new Set(current);
  if ([...changes].every(([id, want]) => has.has(id) === want)) return current;
  return [...current.filter((id) => changes.get(id) !== false), ...[...changes].filter(([id, want]) => want && !has.has(id)).map(([id]) => id)];
}

/**
 * The selection during a stroke over the visible rows `order`. Rows outside the range return to their state when
 * the stroke began, so moving back shrinks it. A null target, or an anchor that left the list, restores every
 * visible row. Rows not in `order` (filtered out) keep their current state.
 */
export function paintSelection(current: string[], order: readonly string[], stroke: PaintStroke, target: string | null): string[] {
  const a = order.indexOf(stroke.anchor);
  const t = target === null ? -1 : order.indexOf(target);
  const lo = a < 0 || t < 0 ? Infinity : Math.min(a, t);
  const hi = a < 0 || t < 0 ? -Infinity : Math.max(a, t);
  return withChanges(current, new Map(order.map((id, i) => [id, i >= lo && i <= hi ? stroke.mode : stroke.base.has(id)])));
}

/** Shift+click: every visible row from `from` to `to` takes `value`. Without `from` in the list, only `to` changes. */
export function pickRange(current: string[], order: readonly string[], from: string | null, to: string, value: boolean): string[] {
  const a = from === null ? -1 : order.indexOf(from);
  const b = order.indexOf(to);
  const ids = a < 0 || b < 0 ? [to] : order.slice(Math.min(a, b), Math.max(a, b) + 1);
  return withChanges(current, new Map(ids.map((id) => [id, value])));
}
