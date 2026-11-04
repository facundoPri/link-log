// FAC-193: lens, auto-tag and query jobs run from the Jev queue's consumer, with no Workflow and no lease. The
// queue's max_batch_size × max_concurrency caps simultaneous Jev calls, delivery is at-least-once, and the
// `jev_call` claim keeps every job to one call and one usage row.
import { afterEach, expect, test } from "bun:test";
import { jevConsumer, resetClock, setup } from "./worker-harness";
import { recover } from "../worker/jobs";

afterEach(resetClock);
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

type S = Awaited<ReturnType<typeof setup>>;
// TypeSafe behind a scripted fetch that answers after `ms` and tracks how many calls are in flight at once.
function provider(ms = 2, during?: () => void) {
  const calls = { n: 0, inFlight: 0, peak: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.n++;
    calls.peak = Math.max(calls.peak, ++calls.inFlight);
    during?.();
    await Bun.sleep(ms);
    calls.inFlight--;
    const questions = JSON.parse(String(init?.body)).questions as Record<string, unknown>;
    return Response.json({
      model: "jev-test",
      answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }])),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  }) as typeof fetch;
  return calls;
}
async function ready(n: number) {
  const s = await setup();
  const res = await s.api("/import", "POST", { urls: Array.from({ length: n }, (_, i) => `https://jq.example/${i}`) });
  const ids = (res.data.links as { id: string }[]).map((l) => l.id);
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  return { s, ids };
}
const lensOf = async (s: S) =>
  (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0] as { id: string };
const statuses = (s: S, batch: string) =>
  (s.db.query("SELECT status FROM jobs WHERE batch_id=?").all(batch) as { status: string }[]).map((j) => j.status);
const usage = (s: S, batch?: string) =>
  (s.db.query(`SELECT count(*) n FROM usage_events WHERE service='jev'${batch ? " AND batch_id=?" : ""}`).get(...(batch ? [batch] : [])) as { n: number }).n;
// Links with more than one job running at this moment.
const doubled = (s: S) => s.db.query("SELECT link_id FROM jobs WHERE status='running' GROUP BY link_id HAVING count(*)>1").all();

test("a large batch completes with every result, within the queue's ceiling on simultaneous Jev calls", async () => {
  const { s, ids } = await ready(100);
  const ceiling = jevConsumer.max_batch_size * jevConsumer.max_concurrency;
  const lens = await lensOf(s);
  const overlaps: unknown[] = [];
  const calls = provider(2, () => overlaps.push(...doubled(s)));
  s.steps.splice(0);
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  // A lens over the same links waits behind the auto-tag on each link.
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids, lensId: lens.id })).data.batchId as string;
  expect(s.sent).toEqual([]);
  await s.runQueued();
  expect(statuses(s, tag)).toEqual(Array(100).fill("done"));
  expect(statuses(s, ask)).toEqual(Array(100).fill("done"));
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations").get()).toEqual({ n: 100 });
  expect(s.db.query("SELECT count(*) n FROM lens_results").get()).toEqual({ n: 100 });
  // Messages run in parallel within an invocation and across invocations: the whole ceiling is used, never more.
  expect(calls.peak).toBe(ceiling);
  expect(overlaps).toEqual([]);
  // Usage per batch matches the Jev calls made.
  expect(calls.n).toBe(200);
  expect([usage(s, tag), usage(s, ask)]).toEqual([100, 100]);
  // No Workflow step and no lease for any of them.
  expect(s.steps).toEqual([]);
  expect(s.db.query("SELECT count(*) n FROM provider_leases").get()).toEqual({ n: 0 });
});

test("a redelivered message never sends a second call or writes a second usage row", async () => {
  const { s, ids } = await ready(2);
  const calls = provider(5);
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  const [first, second] = s.jevSent.splice(0);
  // The same message delivered twice at once (in two invocations), then again after its job settled.
  await Promise.all([s.deliver([first!]), s.deliver([{ ...first!, attempts: 2 }])]);
  await s.deliver([{ ...first!, attempts: 3 }]);
  // A resent copy of the other job's message, in the same invocation as the original.
  await s.deliver([second!, { ...second!, id: "resent" }]);
  expect(statuses(s, batch)).toEqual(["done", "done"]);
  expect(calls.n).toBe(2);
  expect(usage(s, batch)).toBe(2);
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations").get()).toEqual({ n: 2 });
});

test("a batch cancelled before its jobs start makes no call; the queued messages are skipped", async () => {
  const { s, ids } = await ready(3);
  const calls = provider();
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  expect(s.jevSent).toHaveLength(3);
  expect((await s.api(`/batches/${batch}`, "DELETE")).data.cancelled).toBe(3);
  await s.runQueued();
  expect(calls.n).toBe(0);
  expect(usage(s)).toBe(0);
  expect(s.deliveries.map((d) => d.outcome)).toEqual(["ack", "ack", "ack"]);
  expect(statuses(s, batch)).toEqual(["failed", "failed", "failed"]);
});

test("periodic recovery resends lost Jev jobs to the Jev queue", async () => {
  const { s, ids } = await ready(2);
  const calls = provider();
  const send = s.env.JEV_JOBS.sendBatch;
  (s.env.JEV_JOBS as any).sendBatch = async () => { throw new Error("Queue send failed"); };
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  expect(statuses(s, batch)).toEqual(["queued", "queued"]);
  expect(s.jevSent).toEqual([]);
  (s.env.JEV_JOBS as any).sendBatch = send;
  await recover(s.env);
  expect(s.sent).toEqual([]);
  expect(s.jevSent).toHaveLength(2);
  await s.runQueued();
  expect(statuses(s, batch)).toEqual(["done", "done"]);
  expect(calls.n).toBe(2);
});

test("a lens on a link still being extracted waits for the extraction, then runs from the Jev queue", async () => {
  const s = await setup();
  Object.assign(s.env as any, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  const lens = await lensOf(s);
  const id = (await s.api("/links", "POST", { url: "https://jq.example/extracting" })).data.id as string;
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId as string;
  expect(statuses(s, ask)).toEqual(["waiting"]);
  expect(s.jevSent).toEqual([]);
  await s.runQueued();
  expect(statuses(s, ask)).toEqual(["done"]);
  expect(s.db.query("SELECT count(*) n FROM lens_results WHERE link_id=?").get(id)).toEqual({ n: 1 });
});

test("a Jev job already inside a Workflow at deploy finishes there; its resent message runs nothing", async () => {
  const { s, ids } = await ready(1);
  const calls = provider();
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  const [message] = s.jevSent.splice(0);
  await s.runWorkflow(message!.body.id);
  expect(statuses(s, batch)).toEqual(["done"]);
  await s.deliver([message!]);
  expect(calls.n).toBe(1);
  expect(usage(s, batch)).toBe(1);
});
