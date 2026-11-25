// FAC-194: Browser lens and autogroup evaluations run from the Jev queue's consumer, like library lenses and
// auto-tags (FAC-193): no Workflow and no lease, one Jev call and one usage row per job whatever the delivery
// count, and one ceiling on simultaneous Jev calls across every Jev kind.
import { afterEach, expect, test } from "bun:test";
import { lensFingerprint } from "@linklog/browser-protocol";
import { jevConsumer, resetClock, setup } from "./worker-harness";
import { recover } from "../worker/jobs";

afterEach(resetClock);
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

type S = Awaited<ReturnType<typeof setup>>;
// TypeSafe behind a scripted fetch that answers after `ms`, tracking how many calls are in flight at once.
// A noul question gets 0.9, a choice question picks its first option.
function provider(ms = 2) {
  const calls = { n: 0, inFlight: 0, peak: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.n++;
    calls.peak = Math.max(calls.peak, ++calls.inFlight);
    await Bun.sleep(ms);
    calls.inFlight--;
    const questions = JSON.parse(String(init?.body)).questions as Record<string, { type: string; criteria: Record<string, string> }>;
    const answer = (q: { type: string; criteria: Record<string, string> }) => {
      if (q.type !== "choice") return { type: "noul", noul: 0.9 };
      const keys = Object.keys(q.criteria);
      return { type: "choice", choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.9 : 0.1 / (keys.length - 1)])) };
    };
    return Response.json({
      model: "jev-test",
      answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, answer(q)])),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  }) as typeof fetch;
  return calls;
}

const capture = (key: string) => ({ source: "dom", capturedAt: new Date().toISOString(), completeness: "complete", reasons: [], facts: [], markdown: `page ${key}` });
const targets = (keys: string[]) => keys.map((k) => ({ targetKey: k, url: `https://x.dev/${k}`, title: k, capture: capture(k) }));
const keys = (n: number, prefix = "t") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

async function browserSetup() {
  const s = await setup();
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  const lens = { type: "noul", question: "Relevant?", options: [], levels: [], criteria: { yes: "", no: "" } };
  s.db.query("INSERT INTO lenses(id,user_id,name,type,question,options,created_at,scope) VALUES('bl',?,'Relevant','noul','Relevant?','{}','t','browser')").run(s.userId);
  const libraryId = (await s.api("/browser/catalog")).data.libraryId as string;
  const lensEvaluation = async (requestId: string, tabs: string[]) =>
    (await s.api("/browser/evaluations", "POST", {
      requestId, libraryId, sessionId: "s", kind: "lens", lens: { id: "bl", fingerprint: lensFingerprint(lens as never) }, targets: targets(tabs),
    })).data as { batchId: string; targets: { targetKey: string; jobId: string }[] };
  const autogroup = async (requestId: string, tabs: string[]) =>
    (await s.api("/browser/evaluations", "POST", {
      requestId, libraryId, sessionId: "s", kind: "autogroup", catalogVersion: "v1",
      destinations: [{ key: "group-news", name: "News", description: "News articles" }, { key: "group-dev", name: "Dev", description: "Code" }],
      targets: targets(tabs),
    })).data as { batchId: string; targets: { targetKey: string; jobId: string }[] };
  const status = async (requestId: string) => (await s.api(`/browser/evaluations/${requestId}`)).data as { targets: { targetKey: string; state: string; answer?: any; error?: string }[] };
  return { s, lensEvaluation, autogroup, status };
}
const jobStates = (s: S, batch: string) =>
  (s.db.query("SELECT status FROM jobs WHERE batch_id=?").all(batch) as { status: string }[]).map((j) => j.status);
const usage = (s: S, batch?: string) =>
  (s.db.query(`SELECT count(*) n FROM usage_events WHERE service='jev'${batch ? " AND batch_id=?" : ""}`).get(...(batch ? [batch] : [])) as { n: number }).n;

test("a Browser lens evaluation completes every tab from the Jev queue, with no Workflow and no lease", async () => {
  const { s, lensEvaluation, status } = await browserSetup();
  const calls = provider();
  const { batchId } = await lensEvaluation("req-lens", keys(5));
  expect(s.sent).toEqual([]);
  expect(s.jevSent).toHaveLength(5);
  s.steps.splice(0);
  await s.runQueued();
  expect(jobStates(s, batchId)).toEqual(Array(5).fill("done"));
  const states = (await status("req-lens")).targets;
  expect(states.map((t) => [t.targetKey, t.state, t.answer?.type])).toEqual(keys(5).map((k) => [k, "done", "noul"]));
  expect(calls.n).toBe(5);
  expect(usage(s, batchId)).toBe(5);
  expect(s.steps).toEqual([]);
  expect(s.db.query("SELECT count(*) n FROM provider_leases").get()).toEqual({ n: 0 });
});

test("a Browser autogroup hands back the page's destination keys", async () => {
  const { s, autogroup, status } = await browserSetup();
  provider();
  const { batchId } = await autogroup("req-group", keys(2));
  await s.runQueued();
  expect(jobStates(s, batchId)).toEqual(["done", "done"]);
  for (const t of (await status("req-group")).targets) {
    expect(t.state).toBe("done");
    expect(t.answer.choice).toBe("group-news");
    expect(Object.keys(t.answer.probabilities).sort()).toEqual(["group-dev", "group-news", "none"]);
  }
});

test("the snapshot is dropped once the evaluation is saved, and a missing one fails the tab without a call", async () => {
  const { s, lensEvaluation, status } = await browserSetup();
  const calls = provider();
  await lensEvaluation("req-snap", keys(2));
  const [gone] = s.db.query("SELECT capture_key FROM browser_targets WHERE target_key='t0'").all() as { capture_key: string }[];
  s.r2.delete(gone!.capture_key);
  await s.runQueued();
  const [first, second] = (await status("req-snap")).targets;
  expect([first!.state, first!.error]).toEqual(["failed", "The page snapshot is no longer available. Evaluate the tab again."]);
  expect(second!.state).toBe("done");
  expect(calls.n).toBe(1);
  expect(s.r2.size).toBe(0);
  expect(s.db.query("SELECT capture_key FROM browser_targets WHERE target_key='t1'").get()).toEqual({ capture_key: null });
});

test("the Jev ceiling holds across Browser tabs, library lenses and auto-tags together", async () => {
  const { s, lensEvaluation, autogroup } = await browserSetup();
  const ceiling = jevConsumer.max_batch_size * jevConsumer.max_concurrency;
  const urls = Array.from({ length: 60 }, (_, i) => `https://jq.example/${i}`);
  const ids = ((await s.api("/import", "POST", { urls })).data.links as { id: string }[]).map((l) => l.id);
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  const calls = provider(2);
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  const lens = await lensEvaluation("req-mixed", keys(60));
  const group = await autogroup("req-mixed-group", keys(60, "g"));
  s.steps.splice(0);
  await s.runQueued();
  for (const batch of [tag, lens.batchId, group.batchId]) expect(jobStates(s, batch)).toEqual(Array(60).fill("done"));
  expect(calls.n).toBe(180);
  expect(calls.peak).toBe(ceiling);
  expect(usage(s)).toBe(180);
  expect(s.steps).toEqual([]);
});

test("a redelivered message never sends a second call or writes a second usage row", async () => {
  const { s, lensEvaluation, status } = await browserSetup();
  const calls = provider(5);
  const { batchId } = await lensEvaluation("req-redeliver", keys(2));
  const [first, second] = s.jevSent.splice(0);
  await Promise.all([s.deliver([first!]), s.deliver([{ ...first!, attempts: 2 }])]);
  await s.deliver([{ ...first!, attempts: 3 }]);
  await s.deliver([second!, { ...second!, id: "resent" }]);
  expect(jobStates(s, batchId)).toEqual(["done", "done"]);
  expect((await status("req-redeliver")).targets.map((t) => t.state)).toEqual(["done", "done"]);
  expect(calls.n).toBe(2);
  expect(usage(s, batchId)).toBe(2);
});

test("an evaluation cancelled before its tabs start makes no call", async () => {
  const { s, lensEvaluation, status } = await browserSetup();
  const calls = provider();
  const { batchId } = await lensEvaluation("req-cancel", keys(3));
  expect((await s.api("/browser/evaluations/req-cancel", "DELETE")).data.cancelled).toBe(3);
  await s.runQueued();
  expect(calls.n).toBe(0);
  expect(usage(s)).toBe(0);
  expect(s.deliveries.map((d) => d.outcome)).toEqual(["ack", "ack", "ack"]);
  expect(jobStates(s, batchId)).toEqual(["failed", "failed", "failed"]);
  expect((await status("req-cancel")).targets.map((t) => t.state)).toEqual(["failed", "failed", "failed"]);
});

test("cancelling a running tab stops no Workflow; its answer is discarded and nothing more is written", async () => {
  const { s, lensEvaluation, status } = await browserSetup();
  provider(30);
  const { batchId } = await lensEvaluation("req-running", keys(1));
  const [message] = s.jevSent.splice(0);
  const delivery = s.deliver([message!]);
  await Bun.sleep(10);
  const job = (s.db.query("SELECT id FROM jobs WHERE batch_id=?").get(batchId) as { id: string }).id;
  const { cancelJob } = await import("../worker/jobs");
  await cancelJob(s.env, s.userId, job);
  await delivery;
  expect(s.workflows.terminated).toEqual([]);
  expect(jobStates(s, batchId)).toEqual(["failed"]);
  expect((await status("req-running")).targets[0]!.state).toBe("failed");
  expect(s.db.query("SELECT answer FROM browser_targets").get()).toEqual({ answer: null });
});

test("periodic recovery resends lost Browser jobs to the Jev queue", async () => {
  const { s, lensEvaluation, autogroup } = await browserSetup();
  const calls = provider();
  const send = s.env.JEV_JOBS.sendBatch;
  (s.env.JEV_JOBS as any).sendBatch = async () => { throw new Error("Queue send failed"); };
  const lens = await lensEvaluation("req-lost", keys(2));
  const group = await autogroup("req-lost-group", keys(1));
  expect(s.jevSent).toEqual([]);
  expect(jobStates(s, lens.batchId)).toEqual(["queued", "queued"]);
  (s.env.JEV_JOBS as any).sendBatch = send;
  await recover(s.env);
  expect(s.sent).toEqual([]);
  expect(s.jevSent).toHaveLength(3);
  await s.runQueued();
  expect([jobStates(s, lens.batchId), jobStates(s, group.batchId)]).toEqual([["done", "done"], ["done"]]);
  expect(calls.n).toBe(3);
});

test("a Browser job already inside a Workflow at deploy finishes there; its resent message runs nothing", async () => {
  const { s, lensEvaluation, status } = await browserSetup();
  const calls = provider();
  const { batchId } = await lensEvaluation("req-wf", keys(1));
  const [message] = s.jevSent.splice(0);
  await s.runWorkflow(message!.body.id);
  expect(jobStates(s, batchId)).toEqual(["done"]);
  expect((await status("req-wf")).targets[0]!.state).toBe("done");
  await s.deliver([message!]);
  expect(calls.n).toBe(1);
  expect(usage(s, batchId)).toBe(1);
});
