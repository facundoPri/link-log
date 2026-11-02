import { flip, reducedMotion, wait, watchVisibility } from "./motion";

const URLS = [
  "https://inkandswitch.com/local-first",
  "https://seriouseats.com/lemon-orzo",
  "https://developer.chrome.com/docs/extensions/mv3",
];

/**
 * Loops the hero story: links are pasted, each row fetches a preview, reads the
 * page and receives the tags whose rules it matches. Pauses off screen.
 */
export function initHeroDemo() {
  const root = document.querySelector<HTMLElement>("[data-hero-demo]");
  if (!root) return;

  const $ = <T extends Element = HTMLElement>(sel: string, el: ParentNode = root) => el.querySelector<T>(sel)!;
  const $$ = <T extends Element = HTMLElement>(sel: string, el: ParentNode = root) => [
    ...el.querySelectorAll<T>(sel),
  ];

  const incoming = $$("[data-incoming]");
  const allRows = $$(".hero-row");
  const dialog = $("[data-dialog]");
  const typed = $("[data-typed]");
  const linkCount = $("[data-link-count]");
  const save = $("[data-save]");
  const counts = $$("[data-count]");

  const setCount = (key: string, delta: number, bump = false) => {
    const el = counts.find((c) => c.dataset.count === key);
    if (!el) return;
    el.textContent = String(Number(el.dataset.base) + delta);
    if (bump) {
      el.classList.remove("bumped");
      void el.offsetWidth;
      el.classList.add("bumped");
    }
  };

  const showFinal = () => {
    for (const row of incoming) {
      row.hidden = false;
      $("[data-skel]", row).style.opacity = "0";
      $("[data-title]", row).style.opacity = "1";
      $("[data-status]", row).style.opacity = "0";
      $$("[data-chip]", row).forEach((c) => c.classList.remove("pop-enter"));
      $$("[data-chip]", row).forEach((c) => setCount(c.dataset.chip!, 1));
    }
    setCount("all", 3);
  };

  if (reducedMotion()) {
    showFinal();
    return;
  }

  let visible = false;
  let started = false;
  const step = async (ms: number) => {
    await wait(ms);
    while (!visible) await wait(250);
  };

  // Tags added during the current cycle, to update the sidebar counts.
  const added = new Map<string, number>();

  const reset = () => {
    added.clear();
    for (const row of incoming) {
      row.hidden = true;
      row.style.opacity = "";
      row.classList.remove("is-fresh");
      $("[data-skel]", row).style.opacity = "1";
      $("[data-title]", row).style.opacity = "0";
      const status = $("[data-status]", row);
      status.style.opacity = "1";
      $("[data-status-text]", row).textContent = "Fetching preview";
      $$("[data-chip]", row).forEach((c) => c.classList.add("pop-enter"));
    }
    counts.forEach((c) => (c.textContent = c.dataset.base!));
    typed.textContent = "";
    linkCount.textContent = "0 links";
  };

  const typeUrls = async () => {
    dialog.classList.add("is-open");
    await step(500);
    for (const [i, url] of URLS.entries()) {
      for (const ch of url) {
        typed.textContent += ch;
        await wait(18);
      }
      linkCount.textContent = `${i + 1} link${i ? "s" : ""}`;
      if (i < URLS.length - 1) typed.textContent += "\n";
      await wait(220);
    }
    await step(500);
    save.style.transform = "scale(0.94)";
    await wait(160);
    save.style.transform = "";
    await wait(200);
    dialog.classList.remove("is-open");
  };

  const processRow = async (row: HTMLElement, delay: number) => {
    const status = $("[data-status]", row);
    const statusText = $("[data-status-text]", row);
    await step(delay);
    await step(500);
    $("[data-skel]", row).style.opacity = "0";
    $("[data-title]", row).style.opacity = "1";
    statusText.textContent = "Reading page";
    await step(650);
    statusText.textContent = "Auto tagging";
    await step(650);
    status.style.opacity = "0";
    for (const chip of $$("[data-chip]", row)) {
      chip.classList.remove("pop-enter");
      const tag = chip.dataset.chip!;
      added.set(tag, (added.get(tag) ?? 0) + 1);
      setCount(tag, added.get(tag)!, true);
      await wait(120);
    }
    await wait(250);
    row.classList.remove("is-fresh");
  };

  const cycle = async () => {
    reset();
    await step(900);
    await typeUrls();
    await step(200);
    flip(allRows, () => {
      for (const row of incoming) {
        row.hidden = false;
        row.classList.add("is-fresh");
      }
    });
    setCount("all", 3, true);
    await Promise.all(incoming.map((row, i) => processRow(row, i * 220)));
    await step(4000);
    for (const row of incoming) row.style.opacity = "0";
    await wait(400);
    flip(allRows, () => incoming.forEach((r) => (r.hidden = true)));
    await wait(600);
  };

  watchVisibility(root, (v) => {
    visible = v;
    if (v && !started) {
      started = true;
      (async () => {
        for (;;) await cycle();
      })();
    }
  });
}
