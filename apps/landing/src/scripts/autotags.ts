import { onceInView, reducedMotion, wait } from "./motion";

type Sample = {
  title: string;
  domain: string;
  letter: string;
  tone: number;
  words: string;
  scores: Record<string, number>;
};

/**
 * Interactive auto tag demo: pick a sample link, watch every tag get a score,
 * and drag the threshold to see which tags are applied.
 */
export function initAutoTags() {
  const root = document.querySelector<HTMLElement>("[data-autotags]");
  if (!root) return;
  const samples: Sample[] = JSON.parse(root.dataset.samples!);
  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...root.querySelectorAll<T>(s)];

  const tabs = $$<HTMLButtonElement>("[data-sample]");
  const rows = $$("[data-score-row]");
  const rules = $$("[data-rule]");
  const range = $<HTMLInputElement>("[data-threshold]");
  const thresholdLabel = $("[data-threshold-label]");
  const status = $("[data-eval-status]");
  const applied = $("[data-applied]");
  const discarded = $("[data-discarded]");
  const template = document.getElementById("chip-template") as HTMLTemplateElement;

  let current = 0;
  let evaluated = false;
  let token = 0;

  const threshold = () => Number(range.value);
  const toneOf = (name: string) => [...(rows.find((r) => r.dataset.scoreRow === name)?.classList ?? [])].find((c) => /^t\d$/.test(c)) ?? "t4";

  const chip = (name: string, pct: number, kept: boolean) => {
    const node = template.content.firstElementChild!.cloneNode(true) as HTMLElement;
    node.classList.add(toneOf(name));
    if (!kept) node.classList.add("is-discarded");
    node.querySelector("[data-name]")!.textContent = name;
    node.querySelector("[data-chip-pct]")!.textContent = `${pct}%`;
    return node;
  };

  /** Applies the threshold to the scores already shown. */
  const classify = (animateChips: boolean) => {
    if (!evaluated) return;
    const t = threshold();
    const scores = samples[current]!.scores;
    const order = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    applied.replaceChildren();
    discarded.replaceChildren();
    for (const [name, pct] of order) {
      const pass = pct >= t;
      rows.find((r) => r.dataset.scoreRow === name)?.classList.toggle("is-pass", pass);
      rules.find((r) => r.dataset.rule === name)?.classList.toggle("is-pass", pass);
      const c = chip(name, pct, pass);
      (pass ? applied : discarded).append(c);
    }
    const chips = [...applied.children, ...discarded.children] as HTMLElement[];
    if (!animateChips || reducedMotion()) {
      chips.forEach((c) => c.classList.remove("pop-enter"));
      return;
    }
    chips.forEach((c, i) => setTimeout(() => c.classList.remove("pop-enter"), 60 * i + 30));
  };

  const setThresholdUi = () => {
    const t = threshold();
    thresholdLabel.textContent = `${t}%`;
    for (const track of $$("[data-threshold-track]")) track.style.transform = `translateX(${t}%)`;
  };

  /** Animates a percentage label from its current value to `to`. */
  const countTo = (el: HTMLElement, to: number, ms: number) => {
    const from = Number.parseInt(el.textContent ?? "0", 10) || 0;
    if (reducedMotion() || from === to) {
      el.textContent = `${to}%`;
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = `${Math.round(from + (to - from) * eased)}%`;
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /**
   * The first run shows a short "scoring" moment and fills the bars from zero.
   * Switching links afterwards morphs each bar straight to its new score.
   */
  const evaluate = async (index: number) => {
    const my = ++token;
    const firstRun = !root.dataset.ran;
    root.dataset.ran = "1";
    current = index;
    const s = samples[index]!;
    tabs.forEach((t, i) => t.setAttribute("aria-selected", String(i === index)));
    const fav = $("[data-s-favicon]");
    fav.className = `favicon t${s.tone} mt-0.5`;
    fav.textContent = s.letter;
    $("[data-s-title]").textContent = s.title;
    $("[data-s-domain]").textContent = s.domain;
    $("[data-s-words]").textContent = s.words;

    const ms = reducedMotion() ? 0 : firstRun ? 700 : 450;
    if (firstRun) {
      status.style.opacity = "1";
      await wait(reducedMotion() ? 0 : 400);
      if (my !== token) return;
    }
    rows.forEach((r, i) => {
      const pct = s.scores[r.dataset.scoreRow!] ?? 0;
      const fill = r.querySelector("[data-fill]") as HTMLElement;
      setTimeout(() => {
        if (my !== token) return;
        fill.style.transitionDuration = `${ms}ms`;
        fill.style.transform = `scaleX(${Math.max(pct, 1) / 100})`;
        countTo(r.querySelector("[data-pct]") as HTMLElement, pct, ms);
      }, firstRun && !reducedMotion() ? i * 60 : 0);
    });
    await wait(ms + (firstRun ? rows.length * 60 : 0));
    if (my !== token) return;
    status.style.opacity = "0";
    evaluated = true;
    classify(firstRun);
  };

  tabs.forEach((tab, i) => tab.addEventListener("click", () => evaluate(i)));
  root.querySelector('[role="tablist"]')?.addEventListener("keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== "ArrowRight" && k !== "ArrowLeft") return;
    const next = (current + (k === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next]!.focus();
    evaluate(next);
  });
  range.addEventListener("input", () => {
    setThresholdUi();
    classify(false);
  });

  setThresholdUi();
  onceInView(root, () => evaluate(0), 0.3);
}
