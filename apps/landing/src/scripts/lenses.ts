import { flip, onceInView, reducedMotion, wait } from "./motion";

type Lens = { id: string; question: string; kind: "yesno" | "choice"; options: string[] };
type Link = { title: string; answers: Record<string, [string, number]> };

/**
 * Lens demo: choose a question, answers arrive per link, then filter by answer.
 * A lens already evaluated renders straight from its saved results.
 */
export function initLenses() {
  const root = document.querySelector<HTMLElement>("[data-lenses]");
  if (!root) return;
  const { lenses, links } = JSON.parse(root.dataset.lensData!) as { lenses: Lens[]; links: Link[] };
  const pills = [...root.querySelectorAll<HTMLButtonElement>("[data-lens]")];
  const rows = [...root.querySelectorAll<HTMLElement>("[data-lens-row]")];
  const filters = root.querySelector<HTMLElement>("[data-filters]")!;
  const status = root.querySelector<HTMLElement>("[data-lens-status]")!;

  const evaluated = new Set<string>();
  let lens = lenses[0]!;
  let filter = "all";
  let token = 0;
  let ready = false;

  const verdict = (l: Lens, [answer, pct]: [string, number]) => {
    const el = document.createElement("span");
    const base = "verdict caption-4 tabular inline-flex items-center gap-1 rounded-md px-2 py-0.5";
    const tone =
      l.kind === "choice"
        ? "bg-subtle text-ink-2"
        : answer === "Yes"
          ? "bg-brand-soft text-brand-strong"
          : answer === "Unsure"
            ? "text-warning"
            : "text-muted";
    el.className = `${base} ${tone}`;
    el.append(answer);
    const p = document.createElement("span");
    p.className = "font-normal opacity-60";
    p.textContent = `${pct}%`;
    el.append(p);
    return el;
  };

  const skeleton = () => {
    const el = document.createElement("span");
    el.className = "skeleton h-5 w-20 rounded-md";
    return el;
  };

  const setStatus = (text: string, busy: boolean) => {
    status.replaceChildren();
    if (busy) {
      const dot = document.createElement("span");
      dot.className = "pulse-dot size-1.5 rounded-full bg-brand";
      status.append(dot);
    }
    status.append(text);
  };

  const renderFilters = () => {
    const counts = new Map<string, number>();
    for (const l of links) {
      const a = l.answers[lens.id]![0];
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    const opts = ["all", ...lens.options];
    filters.replaceChildren(
      ...opts.map((o) => {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.filter = o;
        b.disabled = !ready;
        b.setAttribute("aria-pressed", String(filter === o));
        b.className =
          "filter-btn caption-4 tabular inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors duration-300 ease-base disabled:opacity-40 " +
          (filter === o ? "bg-ink text-white" : "bg-white text-ink-2 shadow-[0_0_0_1px_var(--color-line)] hover:bg-subtle");
        b.append(o === "all" ? "All" : o);
        const c = document.createElement("span");
        c.className = "opacity-60";
        c.textContent = String(o === "all" ? links.length : (counts.get(o) ?? 0));
        b.append(c);
        b.addEventListener("click", () => applyFilter(o));
        return b;
      }),
    );
  };

  const applyFilter = async (next: string) => {
    filter = next;
    renderFilters();
    const keep = (i: number) => next === "all" || links[i]!.answers[lens.id]![0] === next;
    const leaving = rows.filter((r, i) => !r.hidden && !keep(i));
    leaving.forEach((r) => r.classList.add("is-leaving"));
    if (leaving.length && !reducedMotion()) await wait(220);
    flip(rows, () => {
      rows.forEach((r, i) => {
        r.hidden = !keep(i);
        r.classList.remove("is-leaving");
      });
    });
  };

  const run = async (next: Lens) => {
    const my = ++token;
    lens = next;
    pills.forEach((p) => p.setAttribute("aria-checked", String(p.dataset.lens === next.id)));
    const cached = evaluated.has(next.id);
    ready = false;
    filter = "all";
    rows.forEach((r) => (r.hidden = false));
    renderFilters();

    const cells = rows.map((r) => r.querySelector<HTMLElement>("[data-verdict]")!);
    const instant = cached || reducedMotion();
    if (!instant) cells.forEach((c) => c.replaceChildren(skeleton()));

    for (const [i, cell] of cells.entries()) {
      if (!instant) {
        setStatus(`Evaluating ${i + 1} of ${links.length}`, true);
        await wait(i === 0 ? 600 : 260);
        if (my !== token) return;
      }
      const v = verdict(next, links[i]!.answers[next.id]!);
      if (!reducedMotion()) v.classList.add("is-new");
      cell.replaceChildren(v);
      requestAnimationFrame(() => requestAnimationFrame(() => v.classList.remove("is-new")));
      if (instant && !reducedMotion()) await wait(40);
    }
    if (my !== token) return;
    evaluated.add(next.id);
    ready = true;
    setStatus(cached ? "Saved results, no new calls" : `${links.length} answers`, false);
    renderFilters();
  };

  pills.forEach((p) =>
    p.addEventListener("click", () => {
      const next = lenses.find((l) => l.id === p.dataset.lens)!;
      if (next.id !== lens.id) run(next);
    }),
  );

  renderFilters();
  setStatus("Pick a lens to run it", false);
  onceInView(root, () => run(lens), 0.3);
}
