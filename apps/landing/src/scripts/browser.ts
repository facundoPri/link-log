import { flip, onceInView, reducedMotion, wait } from "./motion";

type Group = { id: string; name: string; tone: number };
type Tab = { id: number; title: string; group: string; saved: boolean };
type Stage = "start" | "suggested" | "grouped" | "closed";

/**
 * Browser demo: Autogroup suggests a group per tab, Apply moves the tabs into
 * Chrome tab groups, Close saved removes tabs that already live in the library.
 * Plays once on its own when first seen; any click takes over.
 */
export function initBrowserDemo() {
  const root = document.querySelector<HTMLElement>("[data-browser]");
  if (!root) return;
  const { groups, tabs } = JSON.parse(root.dataset.browserData!) as { groups: Group[]; tabs: Tab[] };
  const q = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const qa = <T extends Element = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];

  const strip = q("[data-strip]");
  const list = q("[data-tab-rows]");
  const status = q("[data-browser-status]");
  const selected = q("[data-selected]");
  const tabEls = new Map(qa("[data-tab]").map((el) => [Number(el.dataset.tab), el]));
  const rowEls = new Map(qa("[data-row]").map((el) => [Number(el.dataset.row), el]));
  const labels = new Map(qa("[data-glabel]").map((el) => [el.dataset.glabel!, el]));
  const activeTab = strip.querySelector<HTMLElement>(".ctab-active")!;
  const buttons = {
    suggest: q<HTMLButtonElement>('[data-step="suggest"]'),
    apply: q<HTMLButtonElement>('[data-step="apply"]'),
    close: q<HTMLButtonElement>('[data-step="close"]'),
    reset: q<HTMLButtonElement>('[data-step="reset"]'),
  };

  let stage: Stage = "start";
  let busy = false;
  let autoplay = true;
  const groupOf = (id: string) => groups.find((g) => g.id === id)!;

  const setButtons = () => {
    buttons.suggest.disabled = busy || stage !== "start";
    buttons.apply.disabled = busy || stage !== "suggested";
    buttons.close.disabled = busy || stage !== "grouped";
    buttons.reset.disabled = busy || stage === "start";
    const next = { start: "suggest", suggested: "apply", grouped: "close", closed: "reset" }[stage];
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle("is-next", k === next && !busy);
  };

  const setCounts = () => {
    const open = tabs.filter((t) => !tabEls.get(t.id)!.hidden);
    q("[data-tab-count]").textContent = String(open.length);
    const grouped = stage === "grouped" || stage === "closed";
    q("[data-ungrouped-count]").textContent = String(grouped ? 0 : open.length);
    for (const g of groups) {
      q(`[data-group-count="${g.id}"]`).textContent = String(
        grouped ? open.filter((t) => t.group === g.id).length : 0,
      );
    }
    selected.textContent = `${open.length} selected`;
  };

  const destChip = (t: Tab) => {
    const g = groupOf(t.group);
    const el = document.createElement("span");
    el.className = `dest chip t${g.tone}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    el.append(dot, g.name);
    return el;
  };

  const suggest = async () => {
    busy = true;
    setButtons();
    status.textContent = "Autogroup reads each tab and picks one of your groups, or none.";
    for (const t of tabs) {
      const cell = rowEls.get(t.id)!.querySelector<HTMLElement>("[data-dest]")!;
      const sk = document.createElement("span");
      sk.className = "skeleton h-5 w-20 rounded-md";
      cell.replaceChildren(sk);
    }
    await wait(reducedMotion() ? 0 : 500);
    for (const t of tabs) {
      const cell = rowEls.get(t.id)!.querySelector<HTMLElement>("[data-dest]")!;
      const chip = destChip(t);
      if (!reducedMotion()) chip.classList.add("is-new");
      cell.replaceChildren(chip);
      requestAnimationFrame(() => requestAnimationFrame(() => chip.classList.remove("is-new")));
      if (!reducedMotion()) await wait(110);
    }
    stage = "suggested";
    busy = false;
    status.textContent = "Twelve suggestions to review. Change any of them, then apply.";
    setButtons();
  };

  const order = () =>
    groups.flatMap((g) => tabs.filter((t) => t.group === g.id).map((t) => ({ g, t })));

  const apply = async () => {
    busy = true;
    setButtons();
    const movers = [...tabEls.values(), ...rowEls.values()];
    flip(movers, () => {
      for (const g of groups) {
        const label = labels.get(g.id)!;
        label.hidden = false;
        label.classList.add("pop-in");
        strip.insertBefore(label, activeTab);
        for (const t of tabs.filter((x) => x.group === g.id)) {
          const tabEl = tabEls.get(t.id)!;
          tabEl.classList.add("is-grouped");
          strip.insertBefore(tabEl, activeTab);
        }
      }
      for (const { t } of order()) list.append(rowEls.get(t.id)!);
    }, 700);
    stage = "grouped";
    setCounts();
    await wait(reducedMotion() ? 0 : 700);
    busy = false;
    status.textContent = "Four Chrome tab groups, built from the groups you described.";
    setButtons();
  };

  const close = async () => {
    busy = true;
    setButtons();
    const saved = tabs.filter((t) => t.saved);
    for (const t of saved) {
      tabEls.get(t.id)!.classList.add("is-closing");
      rowEls.get(t.id)!.classList.add("is-closing");
    }
    await wait(reducedMotion() ? 0 : 320);
    flip([...tabEls.values(), ...rowEls.values(), ...labels.values()], () => {
      for (const t of saved) {
        tabEls.get(t.id)!.hidden = true;
        rowEls.get(t.id)!.hidden = true;
      }
    });
    stage = "closed";
    setCounts();
    busy = false;
    status.textContent = `Closed the ${saved.length} tabs marked Saved. They are still in your library.`;
    setButtons();
  };

  const reset = () => {
    const movers = [...tabEls.values(), ...rowEls.values()];
    flip(movers, () => {
      for (const t of tabs) {
        const tabEl = tabEls.get(t.id)!;
        tabEl.hidden = false;
        tabEl.classList.remove("is-grouped", "is-closing");
        strip.insertBefore(tabEl, activeTab);
        const row = rowEls.get(t.id)!;
        row.hidden = false;
        row.classList.remove("is-closing");
        row.querySelector("[data-dest]")!.replaceChildren();
        list.append(row);
      }
      for (const l of labels.values()) {
        l.hidden = true;
        l.classList.remove("pop-in");
      }
    });
    stage = "start";
    setCounts();
    status.textContent = "Twelve tabs, no groups. Press Autogroup to sort them.";
    setButtons();
  };

  const take = (fn: () => unknown) => () => {
    autoplay = false;
    if (!busy) fn();
  };
  // Any interaction with the demo hands the remaining steps to the visitor.
  root.addEventListener("pointerdown", () => (autoplay = false));
  buttons.suggest.addEventListener("click", take(suggest));
  buttons.apply.addEventListener("click", take(apply));
  buttons.close.addEventListener("click", take(close));
  buttons.reset.addEventListener("click", take(reset));

  setButtons();
  setCounts();

  onceInView(
    root,
    async () => {
      await wait(1200);
      if (!autoplay) return;
      await suggest();
      await wait(1800);
      if (!autoplay) return;
      await apply();
      await wait(2200);
      if (!autoplay) return;
      await close();
    },
    0.4,
  );
}
