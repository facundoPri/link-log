import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { paintSelection, pickRange, type PaintStroke } from "./paintSelection";

const LONG_PRESS_MS = 400;
const LONG_PRESS_SLOP = 8;
const THUMB_DRAG = 4;
const EDGE = 56;
const MAX_SPEED = 18;
const INTERACTIVE = "button, a, input, textarea, select, [role=button], [role=checkbox], [role=menuitem]";

type Gesture =
  | { kind: "idle" }
  | { kind: "pending"; pointerId: number; id: string; x: number; y: number; touch: boolean; timer: number }
  | { kind: "stroke"; pointerId: number; stroke: PaintStroke; y: number; raf: number };

type SetPicked = (fn: (ids: string[]) => string[]) => void;

const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>("[data-pick-id]")];
const idOf = (el: Element | null) => el?.closest<HTMLElement>("[data-pick-id]")?.dataset.pickId ?? null;
const checkboxOf = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-pick-handle] [role=checkbox]");

function scrollParent(el: HTMLElement) {
  for (let p = el.parentElement; p; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowY)) return p;
  return document.documentElement;
}

/** The part of the scroller that the floating selection bar (and the result cards stacked on it) does not cover. */
function paintArea(scroller: HTMLElement) {
  const r = scroller.getBoundingClientRect();
  const bar = document.querySelector('[role=toolbar][aria-label^="Selected "]');
  const barTop = bar?.closest(".fixed")?.getBoundingClientRect().top ?? Infinity;
  return { top: r.top, bottom: barTop > r.top + 2 * EDGE ? Math.min(r.bottom, barTop) : r.bottom };
}

/**
 * Paint selection over a list whose rows carry `data-pick-id`, with a `data-pick-handle` around the checkbox and
 * an optional `data-pick-thumb`. A stroke starts on the checkbox cell, on the thumbnail after a short vertical
 * drag, or with a long press on touch. Returns the list ref and the handler for a row's own checkbox change.
 */
export function usePaintSelection({ picked, setPicked, count, noun }: { picked: string[]; setPicked: SetPicked; count: number; noun: string }) {
  const [list, setList] = useState<HTMLDivElement | null>(null);
  const latest = useEffectEvent(() => ({ picked, setPicked }));
  const anchor = useRef<{ id: string; mode: boolean } | null>(null);
  // `written` is the selection the key stroke last produced; any other change to the selection starts a new stroke.
  const keyStroke = useRef<{ stroke: PaintStroke; written: string[] } | null>(null);
  // The press that started a stroke or a range already changed the selection. Its click (the next pointer click
  // in the list) must not toggle the checkbox again or open the row. Only the next press clears it: keys can't, since
  // a held Shift repeats keydown on Windows during a slow Shift+click, and keyboard clicks (detail 0) pass anyway.
  const swallowClick = useRef(false);
  const focusId = useRef<string | null>(null);
  const [live, setLive] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setLive(count ? `${count} ${noun}${count === 1 ? "" : "s"} selected` : ""), 300);
    return () => clearTimeout(t);
  }, [count, noun]);

  // Roving tabindex: one checkbox in the list is a tab stop.
  useLayoutEffect(() => {
    if (!list) return;
    const rows = rowsOf(list);
    const current = rows.find((r) => r.dataset.pickId === focusId.current) ?? rows[0];
    for (const r of rows) checkboxOf(r)?.setAttribute("tabindex", r === current ? "0" : "-1");
  });

  useEffect(() => {
    if (!list) return;
    let gesture: Gesture = { kind: "idle" };
    const order = () => rowsOf(list).map((r) => r.dataset.pickId!);
    const set = (fn: (ids: string[]) => string[]) => latest().setPicked(fn);

    const rowAtY = (y: number) => {
      const { top, bottom } = paintArea(scrollParent(list));
      const cy = Math.max(top + 1, Math.min(bottom - 1, y));
      const rows = rowsOf(list);
      return (rows.find((r) => cy < r.getBoundingClientRect().bottom) ?? rows.at(-1))?.dataset.pickId ?? null;
    };

    const paint = (target: string | null) => {
      if (gesture.kind !== "stroke") return;
      const s = gesture.stroke;
      if (!order().includes(s.anchor)) return end();
      set((cur) => paintSelection(cur, order(), s, target));
    };

    let carry = 0;
    let lastScroll = 0;
    const autoscroll = () => {
      if (gesture.kind !== "stroke") return;
      const scroller = scrollParent(list);
      const { top, bottom } = paintArea(scroller);
      const y = gesture.y;
      const depth = y < top + EDGE ? -Math.min(1, (top + EDGE - y) / EDGE) : y > bottom - EDGE ? Math.min(1, (y - bottom + EDGE) / EDGE) : 0;
      carry += Math.sign(depth) * depth * depth * MAX_SPEED;
      const step = Math.trunc(carry);
      if (step) {
        scroller.scrollTop += step;
        carry -= step;
      }
      if (!depth) carry = 0;
      if (scroller.scrollTop !== lastScroll) {
        lastScroll = scroller.scrollTop;
        paint(rowAtY(y));
      }
      if (gesture.kind === "stroke") gesture.raf = requestAnimationFrame(autoscroll);
    };

    const start = (pointerId: number, id: string, y: number) => {
      window.getSelection()?.removeAllRanges();
      const base = new Set(latest().picked);
      const stroke = { anchor: id, mode: !base.has(id), base };
      gesture = { kind: "stroke", pointerId, stroke, y, raf: 0 };
      swallowClick.current = true;
      try {
        list.setPointerCapture(pointerId);
      } catch {
        // The pointer already ended; the stroke still applies to the anchor row.
      }
      list.style.userSelect = "none";
      list.style.webkitUserSelect = "none";
      anchor.current = { id, mode: stroke.mode };
      keyStroke.current = null;
      focusId.current = id;
      carry = 0;
      lastScroll = scrollParent(list).scrollTop;
      paint(id);
      autoscroll();
    };

    const clearPending = () => {
      if (gesture.kind !== "pending") return;
      clearTimeout(gesture.timer);
      gesture = { kind: "idle" };
    };

    const end = () => {
      clearPending();
      if (gesture.kind !== "stroke") return;
      const { pointerId, raf } = gesture;
      gesture = { kind: "idle" };
      cancelAnimationFrame(raf);
      list.style.userSelect = "";
      list.style.webkitUserSelect = "";
      if (list.hasPointerCapture(pointerId)) list.releasePointerCapture(pointerId);
    };

    const range = (id: string, value: boolean) => {
      const from = anchor.current?.id ?? null;
      set((cur) => pickRange(cur, order(), from, id, value));
      anchor.current = { id, mode: value };
      keyStroke.current = null;
      focusId.current = id;
      swallowClick.current = true;
    };

    const onDown = (e: PointerEvent) => {
      clearPending();
      if (e.button > 0 || !e.isPrimary || gesture.kind !== "idle") return;
      const target = e.target as Element;
      const id = idOf(target);
      if (!id) return;
      const onHandle = !!target.closest("[data-pick-handle]");
      const onThumb = e.pointerType !== "touch" && !!target.closest("[data-pick-thumb]");
      if (onHandle || onThumb) {
        e.preventDefault();
        if (e.shiftKey && anchor.current) return range(id, !latest().picked.includes(id));
        if (onHandle) return start(e.pointerId, id, e.clientY);
        gesture = { kind: "pending", pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, touch: false, timer: 0 };
      } else if (e.pointerType === "touch" && !target.closest(INTERACTIVE)) {
        const timer = window.setTimeout(() => {
          if (gesture.kind !== "pending") return;
          const { pointerId, id: pressed, y } = gesture;
          gesture = { kind: "idle" };
          navigator.vibrate?.(10);
          start(pointerId, pressed, y);
        }, LONG_PRESS_MS);
        gesture = { kind: "pending", pointerId: e.pointerId, id, x: e.clientX, y: e.clientY, touch: true, timer };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (gesture.kind === "pending" && e.pointerId === gesture.pointerId) {
        const dx = e.clientX - gesture.x;
        const dy = e.clientY - gesture.y;
        if (gesture.touch) {
          if (Math.hypot(dx, dy) > LONG_PRESS_SLOP) clearPending();
        } else if (e.buttons === 0) clearPending();
        else if (Math.abs(dy) >= THUMB_DRAG) {
          const { pointerId, id } = gesture;
          gesture = { kind: "idle" };
          start(pointerId, id, e.clientY);
          paint(rowAtY(e.clientY));
        }
      } else if (gesture.kind === "stroke" && e.pointerId === gesture.pointerId) {
        gesture.y = e.clientY;
        paint(rowAtY(e.clientY));
      }
    };

    const onUp = (e: PointerEvent) => {
      if ((gesture.kind === "pending" || gesture.kind === "stroke") && e.pointerId === gesture.pointerId) end();
    };
    // Moving capture from the touched row to the list fires lostpointercapture on the row; only the list's own counts.
    const onLost = (e: PointerEvent) => {
      if (e.target === list) onUp(e);
    };

    const onKeyEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || gesture.kind !== "stroke") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      paint(null);
      end();
    };

    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.metaKey || e.ctrlKey || e.altKey) return;
      const box = (e.target as Element).closest("[role=checkbox]");
      const id = idOf(box);
      if (!box || !id || !box.closest("[data-pick-handle]")) return;
      const rows = rowsOf(list);
      const i = rows.findIndex((r) => r.dataset.pickId === id);
      const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      // Arrows on a checkbox move the checkbox focus (and Shift extends); the views' row navigation stays on other targets.
      e.preventDefault();
      e.stopPropagation();
      if (!next) return;
      const nextId = next.dataset.pickId!;
      if (e.shiftKey) {
        const picked = latest().picked;
        if (keyStroke.current?.written !== picked) {
          const from = anchor.current && order().includes(anchor.current.id) ? anchor.current : { id, mode: true };
          keyStroke.current = { stroke: { anchor: from.id, mode: from.mode, base: new Set(picked) }, written: picked };
          anchor.current = from;
        }
        const ks = keyStroke.current;
        const next = paintSelection(latest().picked, order(), ks.stroke, nextId);
        ks.written = next;
        set(() => next);
      } else keyStroke.current = null;
      focusId.current = nextId;
      for (const r of rows) checkboxOf(r)?.setAttribute("tabindex", r === next ? "0" : "-1");
      checkboxOf(next)?.focus();
    };

    const onFocusIn = (e: FocusEvent) => {
      const id = idOf((e.target as Element).closest("[data-pick-handle]"));
      if (id) focusId.current = id;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (gesture.kind === "stroke") e.preventDefault();
    };
    const onContextMenu = (e: Event) => {
      if (gesture.kind !== "idle") e.preventDefault();
    };
    // The press that started a stroke or a range already changed the selection; its click must not toggle the
    // checkbox again or open the row (WebKit can target the row after a capture).
    const onClick = (e: MouseEvent) => {
      if (!swallowClick.current || e.detail === 0 || !list.contains(e.target as Node)) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    };
    const resetSwallow = () => {
      swallowClick.current = false;
    };
    const onDragStart = (e: Event) => e.preventDefault();
    const onBlur = () => end();
    list.style.setProperty("-webkit-touch-callout", "none");

    list.addEventListener("pointerdown", onDown);
    list.addEventListener("pointermove", onMove);
    list.addEventListener("lostpointercapture", onLost);
    list.addEventListener("keydown", onKey);
    list.addEventListener("focusin", onFocusIn);
    list.addEventListener("touchmove", onTouchMove, { passive: false });
    list.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("keydown", onKeyEscape, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerdown", resetSwallow, true);
    window.addEventListener("blur", onBlur);
    list.addEventListener("dragstart", onDragStart);
    return () => {
      end();
      list.removeEventListener("pointerdown", onDown);
      list.removeEventListener("pointermove", onMove);
      list.removeEventListener("lostpointercapture", onLost);
      list.removeEventListener("keydown", onKey);
      list.removeEventListener("focusin", onFocusIn);
      list.removeEventListener("touchmove", onTouchMove);
      list.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("keydown", onKeyEscape, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerdown", resetSwallow, true);
      window.removeEventListener("blur", onBlur);
      list.removeEventListener("dragstart", onDragStart);
    };
  }, [list]);

  /** A row checkbox changed by keyboard (Space): one row, or the range from the anchor with Shift. */
  const toggle = (id: string, value: boolean, shift: boolean) => {
    const order = list ? rowsOf(list).map((r) => r.dataset.pickId!) : [id];
    const from = shift ? (anchor.current?.id ?? null) : null;
    setPicked((cur) => pickRange(cur, order, from, id, value));
    anchor.current = { id, mode: value };
    keyStroke.current = null;
    focusId.current = id;
  };

  return { listRef: setList, toggle, live };
}
