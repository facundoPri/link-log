// FAC-190: Jev timing metrics are logged as structured events so the owner can compare before and after
// the Jev queue change. Logs only: ids and numbers, never content or secrets.
import { afterEach, expect, spyOn, test } from "bun:test";
import { resetClock, setup, tick } from "./worker-harness";

afterEach(resetClock);
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

type Event = { event: string } & Record<string, any>;
function capture() {
  const lines: Event[] = [];
  const spy = spyOn(console, "log").mockImplementation((line: unknown) => {
    try { lines.push(JSON.parse(String(line))); } catch { /* not a structured event */ }
  });
  return { lines, events: (name: string) => lines.filter((e) => e.event === name), stop: () => spy.mockRestore() };
}

// TypeSafe behind a scripted fetch that takes `latency` ms per call; a status other than 200 answers that error.
function jev(script: (n: number) => { status?: number; latency: number; retryAfter?: string }) {
  let n = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const { status = 200, latency, retryAfter } = script(n++);
    tick(latency);
    if (status !== 200) return new Response("busy", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
    const questions = JSON.parse(String(init?.body)).questions as Record<string, unknown>;
    return Response.json({
      model: "jev-test",
      answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }])),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  }) as typeof fetch;
}

test("a batch logs queue wait, call latency, first result, duration and its 429 count", async () => {
  const s = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await s.api("/links", "POST", { url: `https://m.example/${i}` })).data.id);
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "secret-key-do-not-log" });
  jev((n) => (n === 1 ? { status: 429, latency: 50, retryAfter: "7" } : { latency: 200 }));

  const log = capture();
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
  tick(3000);
  // One delivery at a time, so each call's scripted latency is its own on the shared clock.
  for (const m of s.jevSent.splice(0)) await s.runJob(m.body.id);
  log.stop();
  const jobs = s.db.query("SELECT id,status FROM jobs WHERE batch_id=? ORDER BY rowid").all(batch) as { id: string; status: string }[];
  expect(jobs.map((j) => j.status)).toEqual(["done", "failed", "done"]);

  const started = log.events("jev_job_started");
  expect(started.map((e) => e.job_id)).toEqual(jobs.map((j) => j.id));
  expect(started[0]).toMatchObject({ batch_id: batch, kind: "autotag" });
  expect(started[0]!.queue_wait_ms).toBeGreaterThanOrEqual(3000);

  const calls = log.events("jev_call");
  expect(calls.map((c) => [c.latency_ms, c.http_status, c.ok])).toEqual([[200, null, true], [50, 429, false], [200, null, true]]);
  expect(calls[0]).toMatchObject({ job_id: jobs[0]!.id, batch_id: batch, provider: "typesafe" });
  expect(calls[0]!.waited_ms).toBeGreaterThanOrEqual(3000);

  expect(log.events("jev_rate_limited")).toEqual([
    { event: "jev_rate_limited", job_id: jobs[1]!.id, batch_id: batch, retry_after_s: 7 },
  ]);

  const first = log.events("jev_batch_first_result");
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({ batch_id: batch, kind: "autotag", job_id: jobs[0]!.id });
  expect(first[0]!.ms).toBeGreaterThanOrEqual(3200);

  const done = log.events("jev_batch_done");
  expect(done).toHaveLength(1);
  expect(done[0]).toMatchObject({ batch_id: batch, kind: "autotag", jobs: 3, done: 2, failed: 1 });
  expect(done[0]!.duration_ms).toBeGreaterThanOrEqual(3450);

  expect(JSON.stringify(log.lines)).not.toContain("secret-key-do-not-log");
});

test("a job retried after a storage error before its call logs its start once", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://m.example/retried" })).data.id as string;
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  jev(() => ({ latency: 10 }));
  const content = s.env.CONTENT as any, get = content.get;
  let failures = 1;
  content.get = async (k: string) => (failures-- > 0 ? Promise.reject(new Error("We encountered an internal error. Please try again.")) : get(k));
  const log = capture();
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId as string;
  await s.runQueued();
  log.stop();
  expect(s.db.query("SELECT status,attempt FROM jobs WHERE batch_id=?").get(batch)).toEqual({ status: "done", attempt: 2 });
  expect(log.events("jev_job_started")).toHaveLength(1);
});

test("extraction jobs log no Jev events", async () => {
  const s = await setup();
  const log = capture();
  await s.api("/links", "POST", { url: "https://m.example/x" });
  await s.runQueued();
  log.stop();
  expect(log.lines.filter((e) => /^jev_(job_started|call|rate_limited|batch_)/.test(e.event))).toEqual([]);
});
