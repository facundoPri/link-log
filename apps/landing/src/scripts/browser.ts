import { flip, reducedMotion, wait, watchVisibility } from "./motion";

type Group = { id: string; name: string; tone: number };
type Tab = { id: number; title: string; group: string; saved: boolean };
type Stage = "start" | "suggested" | "grouped" | "closed";

/**
 * Browser animation: Autogroup suggests a group per tab, Apply moves the tabs
 * into Chrome tab groups, Close saved removes tabs that already live in the
 * library. Loops while on screen; nothing to click.
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
    suggest: q('[data-step="suggest"]'),
    apply: q('[data-step="apply"]'),
    close: q('[data-step="close"]'),
  };

  let stage: Stage = "start";
  const groupOf = (id: string) => groups.find((g) => g.id === id)!;

  /** Shows which bar action is running, like a pressed button. */
  const press = (key: keyof typeof buttons | null) => {
    for (const [k, b] of Object.entries(buttons)) b.classList.toggle("is-active", k === key);
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
    status.textContent = "Autogroup picks one of your groups for each tab.";
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
    status.textContent = "You check the suggestions, then apply.";
  };

  const order = () =>
    groups.flatMap((g) => tabs.filter((t) => t.group === g.id).map((t) => ({ g, t })));

  const apply = async () => {
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
    status.textContent = "Four tab groups, built from your descriptions.";
  };

  const close = async () => {
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
    status.textContent = `Closed ${saved.length} saved tabs. They stay in your library.`;
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
    status.textContent = "Twelve tabs, no groups.";
  };

  setCounts();

  if (reducedMotion()) {
    // Show the sorted end state without movement.
    void (async () => {
      await suggest();
      await apply();
    })();
    status.textContent = "Twelve tabs in four groups.";
    return;
  }

  let visible = false;
  let started = false;
  const step = async (ms: number) => {
    await wait(ms);
    while (!visible) await wait(250);
  };
  const run = async (key: keyof typeof buttons, fn: () => Promise<void>) => {
    press(key);
    await fn();
    await wait(300);
    press(null);
  };
  watchVisibility(root, (v) => {
    visible = v;
    if (!v || started) return;
    started = true;
    (async () => {
      for (;;) {
        await step(1000);
        await run("suggest", suggest);
        await step(1400);
        await run("apply", apply);
        await step(1800);
        await run("close", close);
        await step(3200);
        reset();
      }
    })();
  });
}
