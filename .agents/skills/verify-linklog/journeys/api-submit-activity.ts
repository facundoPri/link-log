// api-submit-activity (FAC-155): an integration submits URLs with a Bearer API key to POST
// /api/v1/links; Activity lists the batch as "Extract context · API · <key name>" and the user
// cancels it from the sheet. Also checks that the key cannot read the library and that Demo B sees
// nothing. Launch with `V up --var BROWSER_CONCURRENCY=1` so the pool links stay queued.
import type { Journey } from "../scripts/journey";

export default (async ({ page, api, apiAs, fixture, step, check, shot, aria, note }) => {
  const name = `Shortcuts ${Date.now() % 100000}`;
  const origin = new URL(page.url()).origin;
  const urls = [fixture("pool", "1"), fixture("pool", "2"), fixture("pool", "3")];

  await step("Set up: create an API key (Settings owns this; see api-keys-settings.ts)");
  const { key: secret } = await api.send("POST", "/auth/api-key/create", { name });

  await step("Integration: submit three URLs with the key, no cookie or Origin");
  const submit = (key: string | null, path = "/api/v1/links", body: unknown = { urls }) =>
    fetch(origin + path, {
      method: path === "/api/v1/links" ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: path === "/api/v1/links" ? JSON.stringify(body) : undefined,
    });
  const res = await submit(secret);
  const accepted = await res.json();
  await check("API: 202 with three created results and a batchId", () => res.status === 202 && accepted.results.length === 3 && accepted.results.every((r: { status: string }) => r.status === "created") && accepted.batchId);
  await note("01-submit-response", { status: res.status, headers: Object.fromEntries(res.headers), body: accepted });
  await check("API: no CORS headers on the response", () => ![...res.headers.keys()].some((h) => h.startsWith("access-control-")));

  await step("The key cannot reach private routes; a missing key is 401");
  const library = await submit(secret, "/api/library");
  const missing = await submit(null);
  await check("API: GET /api/library with the key is 401", () => library.status === 401);
  await check("API: a request without a key is 401", () => missing.status === 401);
  await note("02-rejections", { library: library.status, missingKey: missing.status });

  await step("Resending the same URL is a Duplicate with no batch");
  const again = await (await submit(secret, "/api/v1/links", { urls: [urls[0]] })).json();
  await check("API: duplicate, no batchId", () => again.results[0].status === "duplicate" && !("batchId" in again));
  await note("03-duplicate-response", again);

  await step("Activity lists the batch with the key name");
  const batch = await check("API: Demo A's library has the batch with the API source", async () => {
    const b = (await api.library()).batches.find((x: { id: string }) => x.id === accepted.batchId);
    return b && JSON.parse(b.config).apiKeyName === name && b;
  });
  await page.reload();
  // The sidebar footer button reads "Extracting" while a batch runs.
  await page.getByRole("button", { name: /^(Activity|Extracting)/ }).click();
  const sheet = page.getByRole("dialog", { name: "Activity" });
  const label = `Extract context · API · ${name}`;
  await check(`Activity shows "${label}"`, () => sheet.getByText(label, { exact: true }).isVisible());
  await check("Markup: no nested buttons", async () => (await page.locator("button button").count()) === 0);
  await page.waitForTimeout(600); // let the sheet finish sliding in before the screenshot
  await shot("04-activity-api-batch");
  await aria("04-activity-api-batch");

  await step("Cancel the API batch from Activity");
  // The API batch is the only active one in this fresh account.
  const cancel = sheet.getByRole("button", { name: "Cancel batch" });
  await check("Exactly one batch can be cancelled", async () => (await cancel.count()) === 1);
  await cancel.click();
  const after = await check(
    "API: the batch has no active jobs and some were cancelled",
    async () => {
      const b = (await api.library()).batches.find((x: { id: string }) => x.id === batch.id);
      return b && b.active === 0 && b.cancelled > 0 && b;
    },
    { timeout: 30_000 },
  );
  await check("Activity no longer offers Cancel batch", async () => (await cancel.count()) === 0, { timeout: 30_000 });
  await check(`Activity still labels the batch "${label}"`, () => sheet.getByText(label, { exact: true }).isVisible());
  await shot("05-activity-cancelled");
  await note("05-batch-after-cancel", after);

  await step("Demo B sees none of it");
  const other = await apiAs(1).library();
  await check("API: Demo B has no links or batches from the key", () => !other.batches.some((b: { id: string }) => b.id === batch.id) && !other.links.some((l: { url: string }) => urls.includes(l.url)));
}) satisfies Journey;
