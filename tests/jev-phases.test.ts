// FAC-54: Jev failures are split by phase. Before the request is sent (no cost) only known border cases
// (a transient R2 read, a D1 conflict or timeout) are retried, once. After it may have been sent nothing is
// retried automatically. An account error (401/402/403, balance, quota) stops the rest of its batch.
import { afterEach, expect, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";
import { judge, JevFailure } from "../worker/ai/jev";
import { JEV_FAILURE_MESSAGES, jobProgress } from "../src/failures";

afterEach(resetClock);

type S = Awaited<ReturnType<typeof setup>>;
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));
const answer = (questions: Record<string, unknown>) =>
  Response.json({
    model: "jev-test",
    answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }])),
    usage: { input_tokens: 100, output_tokens: 5 },
  });
// The TypeSafe provider behind a scripted fetch: each call takes the next answer (the last one sticks).
function provider(...script: ((questions: Record<string, unknown>) => Response | Promise<Response>)[]) {
  const calls = { n: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const step = script[Math.min(calls.n++, script.length - 1)]!;
    return step(JSON.parse(String(init?.body)).questions);
  }) as typeof fetch;
  return calls;
}
async function start(links = 1) {
  const s = await setup();
  const ids: string[] = [];
  for (let i = 0; i < links; i++) ids.push((await s.api("/links", "POST", { url: `https://p.example/${i}` })).data.id);
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  return { s, ids };
}
const autotag = async (s: S, ids: string[]) => (await s.api("/batches", "POST", { kind: "autotag", ids })).data.batchId as string;
const jobs = (s: S, batch: string) =>
  s.db.query("SELECT id,link_id,status,step,error,reason,attempt,max_attempts FROM jobs WHERE batch_id=? ORDER BY rowid").all(batch) as
    { id: string; link_id: string; status: string; step: string; error: string | null; reason: string | null; attempt: number | null; max_attempts: number | null }[];
const usage = (s: S) => s.db.query("SELECT job_id,status FROM usage_events WHERE service='jev' ORDER BY rowid").all() as { job_id: string; status: string }[];
const jevSteps = (s: S) => s.steps.filter((x) => x.name === "evaluate-jev");

test("a transient R2 read error before the call is retried once and succeeds with one provider call", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  const content = s.env.CONTENT as any, get = content.get;
  let failures = 1;
  content.get = async (k: string) => (failures-- > 0 ? Promise.reject(new Error("We encountered an internal error. Please try again.")) : get(k));
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]).toMatchObject({ attempts: 2, retries: { limit: 1 } });
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "done", attempt: 2, max_attempts: 2 });
  expect(usage(s)).toEqual([{ job_id: jobs(s, batch)[0]!.id, status: "done" }]);
  expect((await s.view(ids[0]!)).attention).toBe(false);
});

test("a D1 conflict before the call is retried once; Activity shows the attempt and the plain reason meanwhile", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  fakes.failSqlOnce = /^UPDATE jobs SET step='Evaluating with Jev'/;
  let during: unknown;
  fakes.onSql = async (sql) => {
    if (sql.startsWith("UPDATE jobs SET step='Evaluating with Jev'") && !during)
      during = s.db.query("SELECT status,step,attempt,max_attempts,reason,attempt_started_at,attempt_budget_ms FROM jobs WHERE reason IS NOT NULL").get();
  };
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]!.attempts).toBe(2);
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]!.status).toBe("done");
  // Between the attempts the job carries attempt 2 of 2 and the previous reason.
  expect(during).toMatchObject({ status: "running", attempt: 2, max_attempts: 2, reason: "storage_busy" });
  expect(jobProgress({ ...(during as any), waiting_for: null, preview_reason: null })).toEqual({
    step: "Preparing content · Attempt 2 of 2 · Waiting to retry", // the failed write was the step label itself
    note: `Previous attempt: ${JEV_FAILURE_MESSAGES.storage_busy}`,
  });
});

test("pre-call failures that persist end after 2 attempts, with no provider call and no usage row", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  (s.env.CONTENT as any).get = async () => { throw new Error("R2 internal error"); };
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]!.attempts).toBe(2);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", step: "Failed", error: JEV_FAILURE_MESSAGES.storage_busy, reason: "storage_busy" });
  expect(calls.n).toBe(0);
  expect(usage(s)).toEqual([]);
  expect((await s.view(ids[0]!)).attention).toBe(false);
});

test("missing saved content is not a border case: one attempt, no call, no usage", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  (s.env.CONTENT as any).get = async () => null;
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]!.attempts).toBe(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", error: "Saved content is missing. Extract it again.", reason: "before_call" });
  expect(calls.n + usage(s).length).toBe(0);
});

test("a provider 5xx is not retried; Activity says it may have been billed and a manual retry works", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Response("upstream", { status: 503 }), answer);
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]!.attempts).toBe(1);
  expect(calls.n).toBe(1);
  const [job] = jobs(s, batch);
  expect(job).toMatchObject({ status: "failed", step: "Failed", error: "Jev returned an error (may have been billed).", reason: "provider_error" });
  expect(usage(s)).toEqual([{ job_id: job!.id, status: "failed" }]);
  // Activity lists the job with that copy; the link never enters Needs attention.
  expect((await s.api(`/batches/${batch}`)).data.jobs[0]).toMatchObject({ status: "failed", error: "Jev returned an error (may have been billed)." });
  expect(await s.view(ids[0]!)).toMatchObject({ attention: false, processing: false });

  const retry = await s.api(`/batches/${batch}/retry`, "POST", { ids: [ids[0]] });
  expect(retry.status).toBe(200);
  await s.runQueued();
  expect(calls.n).toBe(2);
  expect(jobs(s, retry.data.batchId)[0]!.status).toBe("done");
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations WHERE link_id=?").get(ids[0]!)).toEqual({ n: 1 });
});

test("network errors and timeouts after sending are not retried", async () => {
  for (const fail of [() => Promise.reject(new TypeError("fetch failed")), () => Promise.reject(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }))]) {
    const { s, ids } = await start();
    const calls = provider(fail);
    const batch = await autotag(s, ids);
    await s.runQueued();
    expect(calls.n).toBe(1);
    expect(jevSteps(s)[0]!.attempts).toBe(1);
    expect(["network", "no_answer"]).toContain(jobs(s, batch)[0]!.reason!);
    expect(usage(s).map((u) => u.status)).toEqual(["failed"]);
  }
});

test("an attempt the engine ended after sending is never sent again", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Promise<Response>(() => {}));
  s.engine.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]!.attempts).toBe(2);
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});

test("an account error on the first job stops the rest of the batch with no further calls or usage rows", async () => {
  const { s, ids } = await start(3);
  // The third link is busy with an extraction: its auto-tag waits, and a lens queued behind it on that link
  // belongs to another batch.
  const extract = (await s.api("/batches", "POST", { kind: "extract", ids: [ids[2]] })).data.batchId;
  s.sent.splice(0);
  const calls = provider(() => Response.json({ error: "Insufficient balance" }, { status: 402 }));
  const batch = await autotag(s, ids);
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0];
  const other = (await s.api("/batches", "POST", { kind: "lens", ids: [ids[2]], lensId: lens.id })).data.batchId;
  expect(jobs(s, batch).map((j) => j.status)).toEqual(["queued", "queued", "waiting"]);

  const [first] = s.sent.splice(0, 1);
  await s.runJob(first!.body.id);
  expect(calls.n).toBe(1);
  const [a, b, c] = jobs(s, batch);
  expect(a).toMatchObject({ status: "failed", reason: "account", error: JEV_FAILURE_MESSAGES.account });
  for (const j of [b, c]) expect(j).toMatchObject({ status: "failed", step: "Stopped", reason: "account_stopped", error: JEV_FAILURE_MESSAGES.account_stopped });
  // The second job's queue message is ignored; nothing else calls Jev or writes Usage.
  await s.runQueued();
  expect(calls.n).toBe(1);
  expect(usage(s)).toEqual([{ job_id: a!.id, status: "failed" }]);
  // The extraction still runs, and the other batch's lens (outside the stopped batch) runs after it.
  await s.runJob(jobs(s, extract)[0]!.id);
  expect(jobs(s, other)[0]!.status).toBe("queued");
  for (const id of ids) expect((await s.view(id)).attention).toBe(false);
  // Retrying the stopped batch from Activity enqueues all three links again.
  const retry = await s.api(`/batches/${batch}/retry`, "POST", {});
  expect(retry.status).toBe(200);
  expect(jobs(s, retry.data.batchId)).toHaveLength(3);
});

test("a job already past its start sees the account stop and fails before calling", async () => {
  const { s, ids } = await start(2);
  const calls = provider(answer);
  const batch = await autotag(s, ids);
  const [a, b] = jobs(s, batch);
  // Job a was refused by Jev while b was already on its way (dequeued before the stop).
  s.db.query("UPDATE jobs SET status='failed',step='Failed',reason='account' WHERE id=?").run(a!.id);
  s.sent.splice(0);
  await s.runJob(b!.id);
  expect(calls.n).toBe(0);
  expect(usage(s)).toEqual([]);
  expect(jobs(s, batch)[1]).toMatchObject({ status: "failed", reason: "account_stopped", error: JEV_FAILURE_MESSAGES.account_stopped });
});

test("provider answers are classified by phase", async () => {
  const env = (extra: Record<string, unknown> = {}) => ({
    JEV_PROVIDER: "typesafe",
    TYPESAFE_API_KEY: "k",
    DB: { prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => null }) }), batch: async (l: unknown[]) => l.map(() => ({ meta: { changes: 1 } })) },
    ...extra,
  }) as unknown as Env;
  const q = { t: { type: "noul" as const, instructions: "x", criteria: { true: "a", false: "b" } } };
  const job = { id: "j", batch_id: "b", link_id: null };
  const failure = async (e: Env) => judge(e, { content: "x" }, q, job).then(() => null, (f: JevFailure) => f);
  for (const [status, body, reason] of [
    [401, "unauthorized", "account"],
    [403, "", "account"],
    [429, '{"error":"quota exceeded"}', "account"],
    [429, "slow down", "provider_error"],
    [500, "boom", "provider_error"],
  ] as const) {
    provider(() => new Response(body, { status }));
    expect(await failure(env())).toMatchObject({ phase: "sent", reason, detail: { http_status: status } });
  }
  provider(() => Response.json({ answers: {} }));
  expect(await failure(env())).toMatchObject({ phase: "sent", reason: "invalid_response" });
  // Workers AI: account problems come back as errors from the binding.
  const ai = (message: string) => env({ JEV_PROVIDER: "cloudflare", AI: { run: async () => { throw new Error(message); } } });
  expect(await failure(ai("4006: you have used up your daily free allocation"))).toMatchObject({ phase: "sent", reason: "account" });
  expect(await failure(ai("3043: Internal server error"))).toMatchObject({ phase: "sent", reason: "provider_error" });
  // A D1 conflict while recording the call happens before sending.
  const d1 = (message: string) => env({ DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => { throw new Error(message); } } });
  const busy = d1("D1_ERROR: database is locked (SQLITE_BUSY)");
  const calls = provider(answer);
  expect(await failure(busy)).toMatchObject({ phase: "before_call", reason: "storage_busy", retryable: true });
  // A bare D1_ERROR (schema, constraint) or an unknown error is permanent: final, not retried.
  for (const message of ["D1_ERROR: no such table: usage_events", "D1_ERROR: UNIQUE constraint failed", "something odd"])
    expect(await failure(d1(message))).toMatchObject({ phase: "before_call", reason: "before_call", retryable: false });
  expect(calls.n).toBe(0);
});

// Round 2 (review): the call is authorized by one atomic claim, outcomes survive metering failures, unknown
// prior state fails closed, and only known transient storage errors are retried.
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { opened, open };
};
const claimSql = /^UPDATE jobs SET jev_call=/;

test("a first attempt delayed before its claim, released after the second attempt finished, never sends", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  const hold = gate();
  let paused: Promise<void> | null = null;
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && claimSql.test(sql) && !paused) await (paused = hold.opened);
  };
  s.engine.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jobs(s, batch)[0]!.status).toBe("done");
  expect(calls.n).toBe(1);
  hold.open();
  await Bun.sleep(10);
  expect(calls.n).toBe(1);
  expect(usage(s)).toEqual([{ job_id: jobs(s, batch)[0]!.id, status: "done" }]);
  expect(jobs(s, batch)[0]!.status).toBe("done");
});

test("a running job paused right before its claim does not send once another job stopped the batch", async () => {
  const { s, ids } = await start(2);
  const calls = provider(() => Response.json({ error: "Insufficient balance" }, { status: 402 }));
  const batch = await autotag(s, ids);
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0];
  const other = (await s.api("/batches", "POST", { kind: "lens", ids: [ids[1]], lensId: lens.id })).data.batchId;
  const [a, b] = jobs(s, batch);
  s.sent.splice(0);
  const hold = gate();
  let paused = false;
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && claimSql.test(sql) && !paused) { paused = true; await hold.opened; }
  };
  const runningB = s.runJob(b!.id); // B is running and pauses right before its claim
  await Bun.sleep(5);
  await s.runJob(a!.id); // A gets a 402 and stops the batch
  expect(calls.n).toBe(1);
  hold.open();
  await runningB;
  expect(calls.n).toBe(1);
  expect(usage(s)).toEqual([{ job_id: a!.id, status: "failed" }]);
  expect(jobs(s, batch)[1]).toMatchObject({ status: "failed", reason: "account_stopped", error: JEV_FAILURE_MESSAGES.account_stopped });
  // The other batch's lens waiting behind B starts.
  expect(jobs(s, other)[0]!.status).toBe("queued");
});

for (const [name, setupFault] of [
  ["the usage row can't be finalized", (s: S) => { fakes.failSqlOnce = /^UPDATE usage_events SET status=\?,model=/; return () => Response.json({ error: "Insufficient balance" }, { status: 402 }); }],
  ["the error body fails to arrive", () => () => new Response(new ReadableStream({ start: (c) => c.error(new TypeError("network connection lost")) }), { status: 401 })],
] as const) {
  test(`an account error still stops the batch when ${name}`, async () => {
    const { s, ids } = await start(2);
    const calls = provider(setupFault({} as S));
    const batch = await autotag(s, ids);
    const [first] = s.sent.splice(0, 1);
    await s.runJob(first!.body.id);
    await s.runQueued();
    expect(calls.n).toBe(1);
    const [a, b] = jobs(s, batch);
    expect(a).toMatchObject({ status: "failed", reason: "account", error: JEV_FAILURE_MESSAGES.account });
    expect(b).toMatchObject({ status: "failed", reason: "account_stopped" });
  });
}

test("a replay guard that can't read the claim fails closed with the may-have-been-billed copy", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Promise<Response>(() => {}));
  s.engine.timeoutMs = 20;
  fakes.onSql = async (sql, phase) => {
    if (phase === "read" && sql === "SELECT jev_call FROM jobs WHERE id=?") throw new Error("D1_ERROR: database is locked (SQLITE_BUSY)");
  };
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(calls.n).toBe(1);
  expect(usage(s)).toHaveLength(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});

test("an engine error that escapes the Jev step is reported as possibly billed, without sending", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  (s.env.CONTENT as any).get = () => new Promise(() => {}); // both attempts hang before the call
  s.engine.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jevSteps(s)[0]!.attempts).toBe(2);
  expect(calls.n + usage(s).length).toBe(0);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});

test("permanent or unknown R2 errors are final: one attempt, no call, no usage", async () => {
  for (const message of ["R2 access denied: invalid bucket credentials", "unexpected R2 failure"]) {
    const { s, ids } = await start();
    const calls = provider(answer);
    (s.env.CONTENT as any).get = async () => { throw new Error(message); };
    const batch = await autotag(s, ids);
    await s.runQueued();
    expect(jevSteps(s)[0]!.attempts).toBe(1);
    expect(calls.n + usage(s).length).toBe(0);
    expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "before_call", error: "Failed before calling Jev (no cost): the saved content could not be read." });
  }
});
