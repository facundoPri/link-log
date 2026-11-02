export const reducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Calls `onEnter` once, the first time `el` is at least `threshold` visible. */
export function onceInView(el: Element, onEnter: () => void, threshold = 0.35) {
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        onEnter();
      }
    },
    { threshold },
  );
  io.observe(el);
}

/** Reports visibility changes, so looping demos can pause off screen. */
export function watchVisibility(el: Element, onChange: (visible: boolean) => void) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) onChange(e.isIntersecting);
  });
  io.observe(el);
  return () => io.disconnect();
}

/**
 * FLIP: measure, let `mutate` move nodes in the DOM, then animate each node
 * from its old position with a transform only.
 */
export function flip(nodes: HTMLElement[], mutate: () => void, duration = 600) {
  const before = new Map(nodes.map((n) => [n, n.getBoundingClientRect()]));
  mutate();
  if (reducedMotion()) return;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";
  const hiddenRect = (r: DOMRect) => r.width === 0 && r.height === 0;
  let entering = 0;
  for (const n of nodes) {
    const a = before.get(n);
    if (!a || !n.isConnected) continue;
    const b = n.getBoundingClientRect();
    if (hiddenRect(b)) continue;
    // A node that was hidden has no old position (its rect sits at 0,0), so
    // sliding it from there would fly it in from the top of the page. Fade it
    // in where it lands instead, staggered with the other new nodes.
    if (hiddenRect(a)) {
      n.animate(
        [
          { opacity: 0, transform: "translateY(8px) scale(0.98)" },
          { opacity: 1, transform: "none" },
        ],
        { duration, easing, delay: 80 * entering++, fill: "backwards" },
      );
      continue;
    }
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (!dx && !dy) continue;
    n.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
      { duration, easing },
    );
  }
}

