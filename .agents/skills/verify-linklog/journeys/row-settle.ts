// row-settle: while an auto-tag batch runs, each row is either "In progress…" or shows its result. A row never
// drops "In progress…" before its new tag appears, which read as a failure (FAC-189 owner test). Each link answers
// after a different delay (jev:slow), so jobs finish one by one across polls, and the page is sampled every 50 ms,
// so a gap of up to one poll (1.8 s) can't slip between two samples.
import type { Journey } from "../scripts/journey";

const TAG = "topic";

export default (async ({ page, api, fixture, step, check, shot, note }) => {
  const urls = Array.from({ length: 10 }, (_, i) => fixture("article-yes", `r${i}`));

  await step("Seed 10 taggable links and a tag, and wait for extraction");
  await api.send("POST", "/tags", { name: TAG });
  for (const url of urls) await api.send("POST", "/links", { url });
  const links = await check(
    "API: all ten links extracted, none tagged yet",
    async () => {
      const found = await Promise.all(urls.map((u) => api.link(u)));
      return found.every((l) => l && !l.processing && l.content_state === "ready" && !l.tags.length) && found;
    },
    { timeout: 120_000 },
  );
  const markdown = links.map((l, i) => `# ${l.title}\n\nA page Jev tags. jev:yes jev:slow=${300 + i * 700}`);
  for (const [i, l] of links.entries()) await api.send("PUT", `/links/${l.id}/content`, { markdown: markdown[i] });
  await check("API: each link stores its edited content, with its own jev:slow delay", async () =>
    (await Promise.all(links.map((l) => api.get(`/links/${l.id}/content`)))).every((c, i) => c.markdown === markdown[i]));
  await page.reload();
  for (const l of links) {
    const box = page.getByRole("checkbox", { name: `Select ${l.title}` }).first();
    await check(`Row "${l.title}" is listed`, () => box.isVisible());
    await box.click();
  }
  await check("Bar shows 10 selected", () => page.getByLabel("Selected link actions").getByRole("button", { name: "10 selected" }).isVisible());

  await step("Record every row's state every 50 ms while auto-tag runs");
  const titles = links.map((l) => l.title as string);
  await page.evaluate(
    ({ titles, tag }) => {
      const w = window as unknown as { __rows: Record<string, string[]>; __at: Record<string, number[]> };
      w.__rows = Object.fromEntries(titles.map((t) => [t, []]));
      w.__at = Object.fromEntries(titles.map((t) => [t, []]));
      const t0 = performance.now();
      const sample = () => {
        for (const t of titles) {
          const row = document.querySelector(`[aria-label="Select ${CSS.escape(t)}"]`)?.closest("article");
          if (!row) continue;
          const text = row.textContent ?? "";
          const chips = [...row.querySelectorAll("span")].some((s) => s.textContent?.trim() === tag);
          const state = `${text.includes("In progress…") ? "progress" : ""}${chips ? "+tag" : ""}` || "none";
          const seen = w.__rows[t]!;
          if (seen.at(-1) !== state) {
            seen.push(state);
            w.__at[t]!.push(Math.round(performance.now() - t0));
          }
        }
      };
      sample();
      setInterval(sample, 50);
    },
    { titles, tag: TAG },
  );
  await page.keyboard.press("t");
  const batch = await check("API: an auto-tag batch of 10 started", async () =>
    (await api.library()).batches.find((b) => b.kind === "autotag" && b.total === 10));
  await shot("01-running");
  await check("API: the batch settled with every link tagged", async () => {
    const b = (await api.library()).batches.find((x) => x.id === batch.id);
    const tagged = (await Promise.all(urls.map((u) => api.link(u)))).every((l) => l.tags.some((t: { name: string }) => t.name === TAG));
    return b && b.active === 0 && b.done === 10 && tagged;
  }, { timeout: 120_000 });
  await check("UI: every row shows the tag and none reads In progress…", async () => {
    const rows = await page.evaluate(() => (window as unknown as { __rows: Record<string, string[]> }).__rows);
    return Object.values(rows).every((seen) => seen.at(-1) === "+tag");
  }, { timeout: 10_000 });
  await shot("02-settled");

  await step("No row ever showed neither In progress… nor its tag after it started");
  const { rows, at } = await page.evaluate(() => {
    const w = window as unknown as { __rows: Record<string, string[]>; __at: Record<string, number[]> };
    return { rows: w.__rows, at: w.__at };
  });
  // Each state with the millisecond it appeared, from the start of sampling.
  await note("row-states", Object.fromEntries(Object.entries(rows).map(([t, seen]) => [t, seen.map((s, i) => `${s}@${at[t]![i]}`)])));
  await check("Each row went through In progress… to its tag, with no state in between that shows neither", () =>
    Object.values(rows).every((seen) => {
      const from = seen.indexOf("progress");
      return from >= 0 && seen.slice(from).every((s) => s !== "none");
    }));
}) satisfies Journey;
