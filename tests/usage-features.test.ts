// Usage by feature, from real runs: a Link saved over HTTP, run through the Worker's workflow or Jev queue with the
// Browser Rendering call faked (it answers with the browser time it used), then read back from
// GET /api/usage/summary. No feature is capped; every run is counted, retries included.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";
import { recover } from "../worker/jobs";

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
const runAll = async (s: S) => { while (s.sent.length || s.jevSent.length) await s.runQueued(); };
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

const activityUsage = async (s: S) => (await s.api("/usage")).data.totals as { usd: number | null; unknown_cost_calls: number };

test("a Jev call refused for its token window costs nothing, in Settings and in Activity", async () => {
  const s = await setup();
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  const jev = spyOn(globalThis, "fetch").mockImplementation((async () =>
    Response.json({ detail: "state exceeds maximum context length of 32000 tokens" }, { status: 422 })) as unknown as typeof fetch);
  try {
    fakes.browser = renders(0);
    const id = await save(s, URL_1);
    await runAll(s);
    await s.api("/tags", "POST", { name: "news", description: "News articles" });
    expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
    await runAll(s);
  } finally {
    jev.mockRestore();
  }
  const { rows, total } = await features(s);
  expect(rows.autotag).toMatchObject({ runs: 1, usd: 0, unknownCostCalls: 0 });
  expect(total.unknownCostCalls).toBe(0);
  expect(await activityUsage(s)).toMatchObject({ unknown_cost_calls: 0 });
});

test("a browser call stored before its rate existed is priced by the backfill, in Settings and in Activity", async () => {
  const s = await setup();
  fakes.browser = renders(36_000);
  await save(s, URL_1);
  await runAll(s);
  s.db.exec("UPDATE usage_events SET estimated_usd=NULL");
  s.db.exec(await Bun.file("migrations/0027_usage_backfill.sql").text());
  const { rows, total } = await features(s);
  expect(rows.content).toMatchObject({ runs: 1, unknownCostCalls: 0 });
  expect(rows.content!.usd).toBeCloseTo(0.0009, 10);
  expect(total.unknownCostCalls).toBe(0);
  const activity = await activityUsage(s);
  expect(activity.unknown_cost_calls).toBe(0);
  expect(activity.usd).toBeCloseTo(0.0009, 10);
});

test("an interrupted browser call stored without browser time is priced by the backfill at the service's average", async () => {
  const s = await setup();
  fakes.browser = renders(36_000);
  const id = await save(s, URL_1);
  await runAll(s);
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).status).toBe(200);
  await runAll(s);
  s.db.exec("UPDATE usage_events SET status='failed',error='Provider call interrupted before completion',browser_ms=NULL,estimated_usd=NULL WHERE rowid=(SELECT max(rowid) FROM usage_events WHERE service='browser-markdown')");
  s.db.exec(await Bun.file("migrations/0027_usage_backfill.sql").text());
  const { rows } = await features(s);
  expect(rows.content).toMatchObject({ runs: 2, unknownCostCalls: 0 });
  expect(rows.content!.usd).toBeCloseTo(0.0018, 10);
  expect((await activityUsage(s)).unknown_cost_calls).toBe(0);
});

test("a browser call cut short by a cancel is priced at the service's average, not left unpriced", async () => {
  const s = await setup();
  fakes.browser = renders(36_000);
  const id = await save(s, URL_1);
  await runAll(s);
  let reached = false;
  fakes.browser = () => ((reached = true), new Promise<Response>(() => {}));
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).status).toBe(200);
  const job = s.sent.splice(0)[0]!.body.id;
  void s.runJob(job);
  while (!reached) await Bun.sleep(1);
  expect((await s.api(`/jobs/${job}`, "DELETE")).status).toBe(200);
  const { rows } = await features(s);
  expect(rows.content).toMatchObject({ unknownCostCalls: 0 });
  expect(rows.content!.usd).toBeCloseTo(0.0018, 10);
  const activity = await activityUsage(s);
  expect(activity.unknown_cost_calls).toBe(0);
  expect(activity.usd).toBeCloseTo(0.0018, 10);
});

test("a browser call left started when its job settled is priced by recovery at the owner's recent average", async () => {
  const s = await setup();
  fakes.browser = renders(36_000);
  const id = await save(s, URL_1);
  await runAll(s);
  fakes.browser = renders(72_000);
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).status).toBe(200);
  await runAll(s);
  fakes.browser = renders(18_000);
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).status).toBe(200);
  await runAll(s);
  s.db.exec("UPDATE usage_events SET status='started',browser_ms=NULL,estimated_usd=NULL WHERE rowid=(SELECT max(rowid) FROM usage_events WHERE service='browser-markdown')");
  await recover(s.env);
  const { rows } = await features(s);
  expect(rows.content).toMatchObject({ runs: 3, unknownCostCalls: 0 });
  // 0.0009 + 0.0018 for the two finished calls, plus their average for the interrupted one.
  expect(rows.content!.usd).toBeCloseTo(0.0027 + 0.00135, 10);
  const activity = await activityUsage(s);
  expect(activity.unknown_cost_calls).toBe(0);
  expect(activity.usd).toBeCloseTo(0.00405, 10);
});

test("a call that finishes without a price is logged as an error", async () => {
  const s = await setup();
  Object.assign(s.env as any, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  const errors = spyOn(console, "error").mockImplementation(() => {});
  try {
    fakes.browser = renders(1000);
    const id = await save(s, URL_1);
    await runAll(s);
    await s.api("/tags", "POST", { name: "news", description: "News articles" });
    expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
    await runAll(s);
    const logged = errors.mock.calls.map(([line]) => JSON.parse(String(line))).filter((e) => e.event === "usage_unpriced");
    expect(logged).toEqual([expect.objectContaining({ provider: "fixture", status: "done" })]);
  } finally {
    errors.mockRestore();
  }
});
