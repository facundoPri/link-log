// usage-settings (FAC-157, FAC-44): seeds this month's Links through the real paths (two API keys with
// their Bearer secrets, the Web import, a Duplicate, a Revoked API key, and Demo B's own key), lets
// the extractions run and runs Auto-tag and a lens on one Link, then checks Settings > Usage (the
// links hour, month total, Web and per key, and the per-feature table of runs, units and cost) and
// the monthly count on each API key row. Rerunnable: keys and URLs are unique per run and the checks use deltas for
// the account totals, so earlier journeys on the same instance do not matter.
import type { Journey } from "../scripts/journey";

type Feature = { key: string; runs: number; inputTokens: number; outputTokens: number; browserMs: number; usd: number; unknownCostCalls: number };
type Usage = {
  quotas: { links: { used: number; max: number; windowSeconds: number; resetsAt: string } };
  month: {
    start: string;
    links: number;
    web: number;
    apiKeys: { id: string; name: string; links: number; status: "active" | "revoked" | "deleted" }[];
    features: Feature[];
    total: { usd: number; unknownCostCalls: number };
  };
};
const feature = (u: Usage, key: string) => u.month.features.find((f) => f.key === key)!;

export default (async ({ page, api, apiAs, ui, fixture, step, check, shot, aria, note }) => {
  const stamp = Date.now() % 100000;
  const shortcuts = `Shortcuts ${stamp}`, zapier = `Zapier ${stamp}`;
  const before = (await api.get("/usage/summary")) as Usage;

  await step("Seed: two API keys, submissions with each secret, a Duplicate, two Web imports");
  const keyA = await api.send("POST", "/auth/api-key/create", { name: shortcuts });
  const keyZ = await api.send("POST", "/auth/api-key/create", { name: zapier });
  const submit = (secret: string, urls: string[]) =>
    fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify({ urls }) });
  const urlsA = [fixture("article", "a1"), fixture("article", "a2"), fixture("article", "a3")];
  const urlsZ = [fixture("article", "z1"), fixture("article", "z2")];
  await check("API: Shortcuts key creates three Links", async () => (await submit(keyA.key, urlsA)).status === 202);
  await check("API: Zapier key creates two Links", async () => (await submit(keyZ.key, urlsZ)).status === 202);
  const again = await (await submit(keyZ.key, [urlsA[0]!])).json();
  await check("API: a resubmitted URL is a Duplicate", () => again.results[0].status === "duplicate");
  await api.send("POST", "/import", { urls: [fixture("article", "w1"), fixture("article", "w2"), urlsZ[0]!] });
  await api.send("POST", "/auth/api-key/update", { keyId: keyZ.id, enabled: false });
  await check("API: the Revoked API key no longer authenticates", async () => (await submit(keyZ.key, [fixture("article", "late")])).status === 401);

  await step("Demo B adds Links of their own: never in Demo A's usage");
  const keyB = await apiAs(1).send("POST", "/auth/api-key/create", { name: `Other ${stamp}` });
  await fetch(`${ui}/api/v1/links`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${keyB.key}` }, body: JSON.stringify({ urls: [fixture("article", "b1")] }) });

  await step("API: the usage summary");
  const usage = await check("Month: +7 total, +2 Web, 3 for Shortcuts, 2 for the Revoked API key Zapier", async () => {
    const u = (await api.get("/usage/summary")) as Usage;
    const count = (id: string) => u.month.apiKeys.find((k) => k.id === id)?.links;
    return u.month.links - before.month.links === 7 && u.month.web - before.month.web === 2 && count(keyA.id) === 3 && count(keyZ.id) === 2 && u;
  });
  await check("Month total excludes Demo B's key", () => !usage.month.apiKeys.some((k) => k.id === keyB.id));
  await note("01-usage-summary", usage);

  await step("The extractions run; Auto-tag and a lens run on one Link: every run lands in its feature");
  await check("Links quota: only Links count (+7), there is no jobs quota", () => usage.quotas.links.used - before.quotas.links.used === 7 && !("jobs" in usage.quotas));
  await api.send("POST", "/tags", { name: `qa-topic ${stamp}`, description: "Anything about transit." });
  const lens = (await api.send("POST", "/lenses", { name: `Useful ${stamp}`, type: "noul", question: "Is it useful?", threshold: 0.8 })).lenses.find((l: { name: string }) => l.name === `Useful ${stamp}`);
  await check("API: the seven extractions finish and bill Browser time", async () => {
    const u = (await api.get("/usage/summary")) as Usage;
    return feature(u, "extract").runs - feature(before, "extract").runs >= 7 && feature(u, "content").runs - feature(before, "content").runs >= 7 && u;
  }, { timeout: 90_000 });
  const target = await api.link(urlsA[0]!);
  await api.send("POST", "/batches", { kind: "autotag", ids: [target.id] });
  await api.send("POST", "/batches", { kind: "lens", ids: [target.id], lensId: lens.id });
  const after = await check("API: Autotag +1 run, Lenses +1 run, with tokens, and Content bills Browser time", async () => {
    const u = (await api.get("/usage/summary")) as Usage;
    return feature(u, "autotag").runs - feature(before, "autotag").runs === 1 && feature(u, "lens").runs - feature(before, "lens").runs === 1 && u;
  }, { timeout: 60_000 });
  await check("Tokens for Autotag and Lenses; Browser time and a cost for Content; the fixture Jev has no price", () =>
    feature(after, "autotag").inputTokens > feature(before, "autotag").inputTokens && feature(after, "lens").inputTokens > feature(before, "lens").inputTokens &&
    feature(after, "content").browserMs > feature(before, "content").browserMs && feature(after, "content").usd > feature(before, "content").usd &&
    feature(after, "autotag").unknownCostCalls > feature(before, "autotag").unknownCostCalls && after.month.total.unknownCostCalls > 0);
  await note("01b-usage-by-feature", after.month);

  await step("Settings shows the Usage section and the per-key counts");
  await page.goto(`${ui}/settings`);
  const section = page.getByRole("region", { name: "Usage" });
  await check("Usage shows the links hour with a reset time, and no Jobs row", async () => {
    const text = (await section.textContent()) ?? "";
    return new RegExp(`Links saved this hour\\s*${after.quotas.links.used} / 500\\s*· resets in \\d+ min`).test(text) && !/\bJobs\b/.test(text);
  });
  await check("Usage lists each feature with its runs, and a Total", async () => {
    const table = section.getByRole("table", { name: "Usage by feature" });
    const row = (name: string) => table.getByRole("row").filter({ hasText: name });
    return (
      (await row("Autotag").textContent())?.includes(String(feature(after, "autotag").runs)) &&
      (await row("Lenses").textContent())?.includes(String(feature(after, "lens").runs)) &&
      (await row("Content").textContent())?.includes(" s") &&
      (await row("Total").isVisible())
    );
  });
  await check("Usage lists Web and both keys (the Revoked one marked) with this month's counts", async () => {
    const by = section.getByRole("list", { name: "Links saved by source" });
    return (
      (await by.getByRole("listitem").filter({ hasText: "Web" }).textContent())?.includes(String(usage.month.web)) &&
      (await by.getByRole("listitem").filter({ hasText: shortcuts }).textContent())?.endsWith("3") &&
      (await by.getByRole("listitem").filter({ hasText: zapier }).textContent())?.endsWith("2")
    );
  });
  const keys = page.getByRole("region", { name: "API keys" });
  await check("Shortcuts row: 3 links this month", () => keys.getByRole("listitem").filter({ hasText: shortcuts }).getByText("3 links this month").isVisible());
  await check("Zapier row (Revoked, in the closed Revoked keys section): 2 links this month", async () => {
    await keys.getByText(/^Revoked keys \(\d+\)$/).click();
    const row = keys.getByRole("listitem").filter({ hasText: zapier });
    return (await row.getByText("Revoked").isVisible()) && (await row.getByText("2 links this month").isVisible());
  });
  await page.waitForTimeout(400);
  await shot("02-settings-usage");
  await aria("02-settings-usage");

  await step("A key that added nothing reads 0 links; Demo B's page shows only their own usage");
  const fresh = await api.send("POST", "/auth/api-key/create", { name: `Idle ${stamp}` });
  await page.reload();
  await check("Idle key: 0 links this month", () => keys.getByRole("listitem").filter({ hasText: `Idle ${stamp}` }).getByText("0 links this month").isVisible());
  const other = await apiAs(1).get("/usage/summary");
  const mine = [keyA, keyZ, fresh].map((k) => k.id);
  await check("API: Demo B counts their own key and none of Demo A's", () => other.month.apiKeys.find((k: { id: string }) => k.id === keyB.id)?.links === 1 && !other.month.apiKeys.some((k: { id: string }) => mine.includes(k.id)));
  await note("03-demo-b-summary", other);
}) satisfies Journey;
