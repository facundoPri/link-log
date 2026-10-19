// In-page overlay injected into every recorded page (addInitScript): a caption bar at the bottom with the
// scenario, the current step and its expected result; an animated cursor with a click ripple; assertion
// chips; and a countdown chip for waits. State lives in sessionStorage so it survives navigations.
// The app is shrunk by the bar's height so the bar never hides UI.
export const BAR_HEIGHT = 84;

export type OverlayState = {
  id: string;
  title: string;
  n: number;
  caption: string;
  expected: string;
  status: "running" | "passed" | "failed";
  cursor: { x: number; y: number };
};

/** Runs in the page. Must be self-contained (it is serialized). */
export function overlayScript(bar: number) {
  const KEY = "__qa_overlay";
  const read = (): OverlayState | null => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  };
  const write = (s: OverlayState) => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
  };
  const css = `
  #root > .h-dvh { height: calc(100dvh - ${bar}px) !important; }
  [data-sonner-toaster] { --offset-bottom: ${bar + 16}px !important; bottom: ${bar + 16}px !important; }
  #qa-bar { position: fixed; left: 0; right: 0; bottom: 0; height: ${bar}px; z-index: 2147483646; pointer-events: none;
    display: grid; grid-template-columns: 250px 1fr 430px; gap: 22px; align-items: center; padding: 0 22px; box-sizing: border-box;
    background: #0b1020; color: #e8ecf4; font: 15px/1.3 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    border-top: 3px solid #3b82f6; }
  #qa-bar[data-status=passed] { border-top-color: #22c55e; }
  #qa-bar[data-status=failed] { border-top-color: #ef4444; }
  #qa-bar .qa-id { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  #qa-bar .qa-badge { align-self: flex-start; font-weight: 700; font-size: 13px; letter-spacing: .04em; padding: 3px 9px; border-radius: 6px; background: #1d4ed8; color: white; }
  #qa-bar[data-status=passed] .qa-badge { background: #15803d; }
  #qa-bar[data-status=failed] .qa-badge { background: #b91c1c; }
  #qa-bar .qa-title { font-size: 12.5px; color: #9aa4b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #qa-bar .qa-step { font-size: 19px; font-weight: 600; line-height: 1.25; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  #qa-bar .qa-step b { color: #60a5fa; font-weight: 700; margin-right: 8px; }
  #qa-bar .qa-exp { font-size: 14px; color: #bbf7d0; border-left: 2px solid #334155; padding-left: 16px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  #qa-bar .qa-exp i { font-style: normal; color: #86efac; font-weight: 700; display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; margin-bottom: 2px; }
  #qa-chips { position: fixed; right: 18px; top: 58px; z-index: 2147483646; pointer-events: none; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  #qa-chips .qa-chip.wait { order: -1; }
  .qa-chip { font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; padding: 9px 13px; border-radius: 999px; color: white; box-shadow: 0 6px 20px rgba(0,0,0,.25);
    animation: qa-chip-in .25s ease-out; max-width: 640px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .qa-chip.ok { background: #15803d; } .qa-chip.bad { background: #b91c1c; } .qa-chip.wait { background: #1e293b; font-variant-numeric: tabular-nums; }
  @keyframes qa-chip-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  #qa-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 2147483647; pointer-events: none; will-change: transform; filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
  .qa-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
    border: 3px solid #3b82f6; background: rgba(59,130,246,.25); animation: qa-ripple .6s ease-out forwards; }
  @keyframes qa-ripple { from { transform: scale(.4); opacity: 1; } to { transform: scale(3.4); opacity: 0; } }`;

  let cursor: HTMLElement | null = null;
  const render = () => {
    const s = read();
    if (!s || !document.body) return;
    if (!document.getElementById("qa-style")) {
      const style = document.createElement("style");
      style.id = "qa-style";
      style.textContent = css;
      document.head.appendChild(style);
    }
    let bar = document.getElementById("qa-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "qa-bar";
      bar.innerHTML = `<div class="qa-id"><span class="qa-badge"></span><span class="qa-title"></span></div><div class="qa-step"></div><div class="qa-exp"><i>Expected</i><span></span></div>`;
      document.body.appendChild(bar);
      const chips = document.createElement("div");
      chips.id = "qa-chips";
      document.body.appendChild(chips);
      cursor = document.createElement("div");
      cursor.id = "qa-cursor";
      cursor.innerHTML = `<svg viewBox="0 0 26 26" width="26" height="26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L19 15 Z" fill="#111827" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
      document.body.appendChild(cursor);
    }
    bar.dataset.status = s.status;
    (bar.querySelector(".qa-badge") as HTMLElement).textContent = `${s.id} · ${s.status === "running" ? "RUNNING" : s.status.toUpperCase()}`;
    (bar.querySelector(".qa-title") as HTMLElement).textContent = s.title;
    const step = bar.querySelector(".qa-step") as HTMLElement;
    step.textContent = s.caption;
    if (s.n) {
      const b = document.createElement("b");
      b.textContent = `${s.n}.`;
      step.insertBefore(b, step.firstChild);
    }
    (bar.querySelector(".qa-exp span") as HTMLElement).textContent = s.expected || "—";
    cursor = document.getElementById("qa-cursor");
    if (cursor) cursor.style.transform = `translate(${s.cursor.x - 3}px, ${s.cursor.y - 2}px)`;
  };
  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const api = {
    set(patch: Partial<OverlayState>) {
      const s = { ...(read() ?? { id: "", title: "", n: 0, caption: "", expected: "", status: "running", cursor: { x: 720, y: 400 } }), ...patch } as OverlayState;
      write(s);
      render();
    },
    move(x: number, y: number, ms: number) {
      const s = read()!;
      const from = { ...s.cursor };
      const el = document.getElementById("qa-cursor")!;
      return new Promise<void>((resolve) => {
        const start = performance.now();
        const frame = (now: number) => {
          const t = Math.min(1, (now - start) / ms);
          const k = ease(t);
          // A slight arc makes the glide read as a hand movement.
          const arc = Math.sin(Math.PI * t) * Math.min(40, Math.hypot(x - from.x, y - from.y) * 0.08);
          const cx = from.x + (x - from.x) * k, cy = from.y + (y - from.y) * k - arc;
          el.style.transform = `translate(${cx - 3}px, ${cy - 2}px)`;
          if (t < 1) requestAnimationFrame(frame);
          else {
            write({ ...read()!, cursor: { x, y } });
            resolve();
          }
        };
        requestAnimationFrame(frame);
      });
    },
    ripple(x: number, y: number) {
      const r = document.createElement("div");
      r.className = "qa-ripple";
      r.style.left = `${x}px`;
      r.style.top = `${y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 700);
    },
    chip(text: string, kind: "ok" | "bad" | "wait", ms = 2600) {
      const chips = document.getElementById("qa-chips");
      if (!chips) return null;
      const c = document.createElement("div");
      c.className = `qa-chip ${kind}`;
      c.textContent = text;
      chips.appendChild(c);
      if (ms > 0) setTimeout(() => c.remove(), ms);
      return c;
    },
    countdown(label: string, ms: number) {
      const c = api.chip("", "wait", 0);
      if (!c) return;
      const end = Date.now() + ms;
      const tick = () => {
        const left = Math.max(0, end - Date.now());
        c.textContent = `⏱ ${label} — ${(left / 1000).toFixed(0)} s left`;
        if (left > 0 && c.isConnected) setTimeout(tick, 250);
        else c.remove();
      };
      tick();
    },
  };
  (window as unknown as { __qa: typeof api }).__qa = api;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  else render();
}
