// usage-no-unpriced (FAC-168): a priced extraction, an Auto-tag with the fixture Jev (no rate), and a Browser
// call cancelled while it hangs. The cancelled call is priced at the owner's recent average on the real local
// D1; Settings > Usage and Activity show costs and never "unpriced" or "costs unknown", while the API still
// counts the fixture Jev's calls as unpriced (the Worker logs them as `usage_unpriced`).
import type { Journey } from "../scripts/journey";

type Feature = { key: string; runs: number; browserMs: number; usd: number; unknownCostCalls: number };
type Summary = { month: { features: Feature[]; total: { usd: number; unknownCostCalls: number } } };
type UsageEvent = { id: string; link_id: string | null; service: string; status: string; browser_ms: number | null; estimated_usd: number | null; error: string | null };
const feature = (u: Summary, key: string) => u.month.features.find((f) => f.key === key)!;
const HIDDEN = /unpriced|costs? unknown|known subtotal/i;

export default (async ({ page, api, ui, fixture, step, check, shot, aria, note }) => {
  const before = (await api.get("/usage/summary")) as Summary;

  await step("An article is extracted: its Browser call is priced by browser time");
  const articleUrl = fixture("article", "priced");
  await api.send("POST", "/import", { urls: [articleUrl] });
  const article = await check("API: the article has content", async () => {
    const l = await api.link(articleUrl);
    return l && !l.processing && l.content_state === "ready" && l;
  }, { timeout: 60_000 });

  await step("Auto-tag runs with the fixture Jev, which has no rate");
  await api.send("POST", "/tags", { name: `qa-transit ${Date.now() % 100000}`, description: "Anything about transit." });
  await api.send("POST", "/batches", { kind: "autotag", ids: [article.id] });
  const tagged = await check("API: Autotag +1 run, counted as unpriced in the API only", async () => {
    const u = (await api.get("/usage/summary")) as Summary;
    return feature(u, "autotag").runs > feature(before, "autotag").runs && feature(u, "autotag").unknownCostCalls > feature(before, "autotag").unknownCostCalls && u;
  }, { timeout: 60_000 });

  await step("A page whose Browser call hangs is cancelled from Activity while the call runs");
  const hangUrl = fixture("browser-hang", "cancelled");
  await api.send("POST", "/import", { urls: [hangUrl] });
  const hang = await check("API: the hanging page has a Browser call in flight", async () => {
    const l = await api.link(hangUrl);
    const events = ((await api.get("/usage")).events as UsageEvent[]).filter((e) => l && e.link_id === l.id && e.service === "browser-markdown");
    return l && events.some((e) => e.status === "started") && l;
  }, { timeout: 30_000 });
  await page.reload();
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  // "Cancel batch" skips a job whose provider call is running: the running job has its own Cancel.
  await check("Exactly one batch is still running", async () => (await sheet.getByRole("button", { name: "Cancel batch" }).count()) === 1);
  // Newest first: the running extraction is the top Extract context batch.
  await sheet.getByRole("button", { name: /^Extract context/ }).first().click();
  const cancel = sheet.getByRole("button", { name: "Cancel", exact: true });
  await check("The running job offers Cancel", () => cancel.isVisible());
  await shot("01-activity-running-job");
  await cancel.click();
  const interrupted = await check("API: the cancelled call is failed, interrupted, and priced", async () => {
    const e = ((await api.get("/usage")).events as UsageEvent[]).find((x) => x.link_id === hang.id && x.service === "browser-markdown");
    return e && e.status === "failed" && e.error === "Provider call interrupted before completion" && e.browser_ms === null && e.estimated_usd !== null && e.estimated_usd > 0 && e;
  }, { timeout: 30_000 });
  const after = (await api.get("/usage/summary")) as Summary;
  await check("API: Content has no unpriced calls, and its cost grew by the priced and the estimated call", () =>
    feature(after, "content").unknownCostCalls === feature(before, "content").unknownCostCalls && feature(after, "content").usd > feature(before, "content").usd + interrupted.estimated_usd! - 1e-12);
  await note("01-usage", { interrupted, content: feature(after, "content"), autotag: feature(after, "autotag"), total: after.month.total, autotagBefore: feature(tagged, "autotag") });

  await step("Activity shows a cost and nothing about unknown costs");
  await page.reload();
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  await check("Activity header shows a dollar total", () => sheet.getByText(/^<?\$\d/).first().isVisible());
  await check("Activity never says unpriced, costs unknown or known subtotal", async () => !HIDDEN.test((await sheet.textContent()) ?? ""));
  await page.waitForTimeout(600); // let the sheet finish sliding in before the screenshot
  await shot("02-activity");
  await aria("02-activity");

  await step("Settings > Usage shows each feature's cost and never 'unpriced'");
  await page.goto(`${ui}/settings`);
  const section = page.getByRole("region", { name: "Usage" });
  const table = section.getByRole("table", { name: "Usage by feature" });
  await check("Content row shows a cost that is not $0.00", async () => {
    const text = (await table.getByRole("row").filter({ hasText: "Content" }).textContent()) ?? "";
    return /\$\d/.test(text) && !/\$0\.00(?!\d)/.test(text);
  });
  await check("Autotag row shows a dash, not 'unpriced'", async () => /—/.test((await table.getByRole("row").filter({ hasText: "Autotag" }).textContent()) ?? ""));
  await check("Usage never says unpriced", async () => !HIDDEN.test((await section.textContent()) ?? ""));
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot("03-settings-usage");
  await aria("03-settings-usage");
}) satisfies Journey;
