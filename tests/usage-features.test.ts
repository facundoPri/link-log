// Usage by feature, from real runs: a Link saved over HTTP, run through the Worker's workflow with the
// Browser Rendering call faked (it answers with the browser time it used), then read back from
// GET /api/usage/summary. No feature is capped; every run is counted, retries included.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";

let spy: ReturnType<typeof spyOn>;
beforeEach(() => void (spy = spyOn(console, "log").mockImplementation(() => {})));
afterEach(() => { spy.mockRestore(); resetClock(); });

type S = Awaited<ReturnType<typeof setup>>;
type Row = { key: string; runs: number; inputTokens: number; outputTokens: number; browserMs: number; usd: number; unknownCostCalls: number };
// A public IP literal skips DNS in validateDestination, so the real web adapter runs offline.
const URL_1 = "https://93.184.216.34/page";
const ARTICLE = `# Transit plan approved\n\n${"The city council approved the new transit plan after a long public hearing. ".repeat(40)}`;
/** Browser Rendering answers Markdown and says how long the page kept the browser. */
const renders = (ms: number) => () => new Response(JSON.stringify({ success: true, result: ARTICLE }), { status: 200, headers: { "content-type": "application/json", "x-browser-ms-used": String(ms) } });

const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const runAll = async (s: S) => { while (s.sent.length) await s.runQueued(); };
const features = async (s: S) => {
  const { data } = await s.api("/usage/summary");
  return { rows: Object.fromEntries((data.month.features as Row[]).map((f) => [f.key, f])) as Record<string, Row>, total: data.month.total as { usd: number; unknownCostCalls: number } };
};

test("an extraction is one extract run and one browser call, priced by browser time", async () => {
  const s = await setup();
  fakes.browser = renders(36_000); // 0.01 browser hour
  await save(s, URL_1);
  await runAll(s);
  const { rows, total } = await features(s);
  expect(rows.extract).toMatchObject({ runs: 1, usd: 0 });
  expect(rows.content).toMatchObject({ runs: 1, browserMs: 36_000, unknownCostCalls: 0 });
  expect(rows.content!.usd).toBeCloseTo(0.0009, 10); // 0.01 h at $0.09 per browser hour
  expect(total.usd).toBeCloseTo(0.0009, 10);
});

test("a re-extraction is another extract run and another browser call", async () => {
  const s = await setup();
  fakes.browser = renders(18_000);
  const id = await save(s, URL_1);
  await runAll(s);
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).status).toBe(200);
  await runAll(s);
  const { rows } = await features(s);
  expect(rows.extract).toMatchObject({ runs: 2 });
  expect(rows.content).toMatchObject({ runs: 2, browserMs: 36_000 });
});

test("lens and autotag runs on a Link are counted with their tokens; an unpriced provider's calls are unknown, not free", async () => {
  const s = await setup();
  Object.assign(s.env as any, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  fakes.browser = renders(1000);
  const id = await save(s, URL_1);
  await runAll(s);
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0] as { id: string };
  await s.api("/tags", "POST", { name: "news", description: "News articles" });
  expect((await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).status).toBe(200);
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
  await runAll(s);
  const { rows, total } = await features(s);
  expect(rows.lens).toMatchObject({ runs: 1, unknownCostCalls: 1 });
  expect(rows.autotag).toMatchObject({ runs: 1, unknownCostCalls: 1 });
  expect(rows.lens!.inputTokens).toBeGreaterThan(0);
  expect(rows.autotag!.inputTokens).toBeGreaterThan(0);
  expect(total.unknownCostCalls).toBe(2); // the fixture provider has no price
});
