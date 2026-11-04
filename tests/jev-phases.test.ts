// FAC-54: Jev failures are split by phase. Before the request is sent (no cost) only known border cases
// (a transient R2 read, a D1 conflict or timeout) are retried, once. After it may have been sent nothing is
// retried automatically. An account error (401/402/403, balance, quota) stops the rest of its batch.
// FAC-193: these jobs run from the Jev queue's consumer. The pre-call retry is a message retry, and a run whose
// consumer invocation died is settled from what it recorded once it is abandoned, never sent again.
import { afterEach, expect, test } from "bun:test";
import { fakes, resetClock, setup, tick } from "./worker-harness";
import { judge, JevFailure } from "../worker/ai/jev";
import { ABANDONED_MS } from "../worker/jev-queue";
import { recover } from "../worker/jobs";
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
// How each delivery of the job's messages ended, in order.
const deliveries = (s: S, job: string) => s.deliveries.filter((d) => d.job === job).map((d) => d.outcome);
// The consumer invocation running the job died: the platform redelivers, and once the run is abandoned the
// periodic recovery's resend settles it.
async function abandon(s: S) {
  s.queue.timeoutMs = undefined;
  tick(ABANDONED_MS + 1);
  await recover(s.env);
  await s.runQueued();
}

test("a transient R2 read error before the call is retried once and succeeds with one provider call", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  const content = s.env.CONTENT as any, get = content.get;
  let failures = 1;
  content.get = async (k: string) => (failures-- > 0 ? Promise.reject(new Error("We encountered an internal error. Please try again.")) : get(k));
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["retry", "ack"]);
  expect(s.deliveries[0]!.delaySeconds).toBe(5);
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
  await s.deliver(s.jevSent.splice(0));
  // While the retry waits in the queue, Activity shows the coming attempt and why the last one failed.
  const waiting = (await s.api(`/batches/${batch}`)).data.jobs[0];
  expect(waiting).toMatchObject({ status: "queued", attempt: 2, max_attempts: 2, reason: "storage_busy" });
  expect(jobProgress(waiting)).toEqual({
    step: "Preparing content · Attempt 2 of 2 · Waiting to retry",
    note: `Previous attempt: ${JEV_FAILURE_MESSAGES.storage_busy}`,
  });
  await s.runQueued();
  expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["retry", "ack"]);
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
  expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["retry", "ack"]);
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
  expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["ack"]);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", error: "Saved content is missing. Extract it again.", reason: "before_call" });
  expect(calls.n + usage(s).length).toBe(0);
});

test("a provider 5xx is not retried; Activity says it may have been billed and a manual retry works", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Response("upstream", { status: 503 }), answer);
  const batch = await autotag(s, ids);
  await s.runQueued();
  const [job] = jobs(s, batch);
  expect(deliveries(s, job!.id)).toEqual(["ack"]);
  expect(calls.n).toBe(1);
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

test("a batch Retry skips links a later run already recovered or is running; a double click sends nothing twice", async () => {
  const { s, ids } = await start(3);
  const calls = provider((q) => (calls.n <= 3 ? new Response("upstream", { status: 503 }) : answer(q)));
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(jobs(s, batch).map((j) => j.status)).toEqual(["failed", "failed", "failed"]);
  // A double click: both requests arrive before anything runs; only the first enqueues.
  const [first, second] = await Promise.all([s.api(`/batches/${batch}/retry`, "POST", {}), s.api(`/batches/${batch}/retry`, "POST", {})]);
  const ok = [first, second].filter((r) => r.status === 200);
  expect(ok).toHaveLength(1);
  expect([first, second].find((r) => r.status !== 200)!.data.error).toBe("These links were already retried.");
  expect(jobs(s, ok[0]!.data.batchId)).toHaveLength(3);
  await s.runQueued();
  expect(calls.n).toBe(6);
  // The original batch still lists its failures, but every link has been recovered since: nothing to resend.
  const again = await s.api(`/batches/${batch}/retry`, "POST", {});
  expect(again.status).toBe(400);
  expect(again.data.error).toBe("These links were already retried.");
  expect(calls.n).toBe(6);
  expect(s.db.query("SELECT count(*) n FROM batches WHERE kind='autotag'").get()).toEqual({ n: 2 });
  // A retry that failed again doesn't count: that link can still be retried from either batch.
  provider(() => new Response("upstream", { status: 503 }));
  s.db.query("UPDATE jobs SET status='failed',step='Failed' WHERE batch_id=? AND link_id=?").run(ok[0]!.data.batchId, ids[0]!);
  const one = await s.api(`/batches/${batch}/retry`, "POST", {});
  expect(one.status).toBe(200);
  expect(jobs(s, one.data.batchId).map((j) => j.link_id)).toEqual([ids[0]!]);
});

test("network errors and timeouts after sending are not retried", async () => {
  for (const fail of [() => Promise.reject(new TypeError("fetch failed")), () => Promise.reject(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }))]) {
    const { s, ids } = await start();
    const calls = provider(fail);
    const batch = await autotag(s, ids);
    await s.runQueued();
    expect(calls.n).toBe(1);
    expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["ack"]);
    expect(["network", "no_answer"]).toContain(jobs(s, batch)[0]!.reason!);
    expect(usage(s).map((u) => u.status)).toEqual(["failed"]);
  }
});

test("a run whose invocation died after sending is never sent again; once abandoned it settles as possibly billed", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Promise<Response>(() => {}));
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  // The redelivery finds the job running and leaves it to its run.
  expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["killed", "ack"]);
  expect(jobs(s, batch)[0]!.status).toBe("running");
  await abandon(s);
  expect(calls.n).toBe(1);
  expect(usage(s)).toEqual([{ job_id: jobs(s, batch)[0]!.id, status: "failed" }]);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});

test("an account error on the first job stops the rest of the batch with no further calls or usage rows", async () => {
  const { s, ids } = await start(3);
  // The third link is busy with an extraction: its auto-tag waits, and a lens queued behind it on that link
  // belongs to another batch.
  const extract = (await s.api("/batches", "POST", { kind: "extract", ids: [ids[2]] })).data.batchId;
  s.sent.splice(0);
  expect(s.jevSent).toEqual([]);
  const calls = provider(() => Response.json({ error: "Insufficient balance" }, { status: 402 }));
  const batch = await autotag(s, ids);
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0];
  const other = (await s.api("/batches", "POST", { kind: "lens", ids: [ids[2]], lensId: lens.id })).data.batchId;
  expect(jobs(s, batch).map((j) => j.status)).toEqual(["queued", "queued", "waiting"]);

  const [first] = s.jevSent.splice(0, 1);
  await s.deliver([first!]);
  expect(calls.n).toBe(1);
  const [a, b, c] = jobs(s, batch);
  expect(a).toMatchObject({ status: "failed", reason: "account", error: JEV_FAILURE_MESSAGES.account });
  for (const j of [b, c]) expect(j).toMatchObject({ status: "failed", step: "Stopped", reason: "account_stopped", error: JEV_FAILURE_MESSAGES.account_stopped });
  // The second job's queue message is ignored; nothing else calls Jev or writes Usage.
  await s.drainJev();
  expect(calls.n).toBe(1);
  expect(usage(s)).toEqual([{ job_id: a!.id, status: "failed" }]);
  // The extraction still runs, and the other batch's lens (outside the stopped batch) runs after it.
  await s.runJob(jobs(s, extract)[0]!.id);
  expect(jobs(s, other)[0]!.status).toBe("queued");
  expect(s.jevSent.map((m) => m.body.id)).toEqual([jobs(s, other)[0]!.id]);
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
  s.jevSent.splice(0);
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

test("a run whose invocation died before its claim is retried once abandoned; the dead run resuming never sends", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  const hold = gate();
  let paused: Promise<void> | null = null;
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && claimSql.test(sql) && !paused) await (paused = hold.opened);
  };
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  await abandon(s);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "done", attempt: 2, max_attempts: 2 });
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
  s.jevSent.splice(0);
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
    const [first] = s.jevSent.splice(0, 1);
    await s.deliver([first!]);
    await s.runQueued();
    expect(calls.n).toBe(1);
    const [a, b] = jobs(s, batch);
    expect(a).toMatchObject({ status: "failed", reason: "account", error: JEV_FAILURE_MESSAGES.account });
    expect(b).toMatchObject({ status: "failed", reason: "account_stopped" });
  });
}

test("a run taken over after its call was sent settles as possibly billed even when its link can't be read", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Promise<Response>(() => {}));
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  fakes.failSql = /^SELECT \* FROM links WHERE id=\? AND user_id=\?/;
  await abandon(s);
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});

test("a redelivery that can't read its job fails closed: it never sends, and is retried", async () => {
  const { s, ids } = await start();
  const calls = provider(() => new Promise<Response>(() => {}));
  s.queue.timeoutMs = 20;
  let reads = 0;
  fakes.onSql = async (sql, phase) => {
    if (phase === "read" && /^SELECT j\.id,j\.batch_id/.test(sql) && ++reads === 2) throw new Error("D1_ERROR: database is locked (SQLITE_BUSY)");
  };
  const batch = await autotag(s, ids);
  await s.runQueued();
  expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["killed", "retry", "ack"]);
  await abandon(s);
  expect(calls.n).toBe(1);
  expect(usage(s)).toHaveLength(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});

test("a run whose invocation died before the call is retried once abandoned; abandoned again, it fails at no cost", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  (s.env.CONTENT as any).get = () => new Promise(() => {}); // the read before the call hangs
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  // Abandoned with nothing claimed: back in the queue for its second attempt, which dies the same way.
  tick(ABANDONED_MS + 1);
  await recover(s.env);
  await s.runQueued();
  expect(jobs(s, batch)[0]).toMatchObject({ status: "running", attempt: 2, max_attempts: 2 });
  await abandon(s);
  expect(calls.n + usage(s).length).toBe(0);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "before_call", error: JEV_FAILURE_MESSAGES.before_call });
});

test("permanent or unknown R2 errors are final: one attempt, no call, no usage", async () => {
  for (const message of ["R2 access denied: invalid bucket credentials", "unexpected R2 failure"]) {
    const { s, ids } = await start();
    const calls = provider(answer);
    (s.env.CONTENT as any).get = async () => { throw new Error(message); };
    const batch = await autotag(s, ids);
    await s.runQueued();
    expect(deliveries(s, jobs(s, batch)[0]!.id)).toEqual(["ack"]);
    expect(calls.n + usage(s).length).toBe(0);
    expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "before_call", error: "Failed before calling Jev (no cost): the saved content could not be read." });
  }
});

// Round 3 (review): the provider's outcome is recorded under the claim before metering is awaited.
const finalizeSql = /^UPDATE usage_events SET status=\?,model=/;
const holdFinalize = () => {
  const hold = gate();
  let held = false;
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && finalizeSql.test(sql) && !held) { held = true; await hold.opened; }
  };
  return hold;
};

test("an account error whose metering outlives the step still settles as account/402 and stops the batch", async () => {
  const { s, ids } = await start(2);
  const calls = provider(() => Response.json({ error: "Insufficient balance" }, { status: 402 }));
  const batch = await autotag(s, ids);
  const hold = holdFinalize();
  s.queue.timeoutMs = 20;
  const [first] = s.jevSent.splice(0, 1);
  await s.deliver([first!]); // A's invocation dies while it finalizes Usage
  await s.runQueued(); // B runs before A's write is released
  expect(jobs(s, batch)[1]).toMatchObject({ status: "failed", reason: "account_stopped" });
  await abandon(s); // A settles from the outcome it recorded
  const [a, b] = jobs(s, batch);
  expect(a).toMatchObject({ status: "failed", reason: "account", error: JEV_FAILURE_MESSAGES.account });
  expect(b).toMatchObject({ status: "failed", reason: "account_stopped" });
  expect(calls.n).toBe(1);
  hold.open();
  await Bun.sleep(10);
  expect(calls.n).toBe(1);
  expect(usage(s)).toEqual([{ job_id: a!.id, status: "failed" }]);
});

test("a running job of the batch can't claim once another job recorded an account error, even before it settles", async () => {
  const { s, ids } = await start(2);
  const calls = provider(() => Response.json({ error: "Insufficient balance" }, { status: 402 }));
  const batch = await autotag(s, ids);
  const hold = holdFinalize();
  const [a, b] = jobs(s, batch);
  s.jevSent.splice(0);
  const runningA = s.runJob(a!.id); // A has its 402 recorded and is still finalizing Usage
  await Bun.sleep(5);
  await s.runJob(b!.id);
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[1]).toMatchObject({ status: "failed", reason: "account_stopped" });
  hold.open();
  await runningA;
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "account" });
});

test("a 401 is an account error even when its body never arrives", async () => {
  const { s, ids } = await start(2);
  const calls = provider(() => new Response(new ReadableStream({ start: () => {} }), { status: 401 }));
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  const [first] = s.jevSent.splice(0, 1);
  await s.deliver([first!]);
  await s.runQueued();
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "account" });
  expect(jobs(s, batch)[1]).toMatchObject({ status: "failed", reason: "account_stopped" });
  expect(s.db.query("SELECT json_extract(jev_outcome,'$.http_status') s FROM jobs WHERE id=?").get(jobs(s, batch)[0]!.id)).toEqual({ s: 401 });
});

test("a successful answer whose metering outlives the step is recovered, not paid for twice", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  const hold = holdFinalize();
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  await abandon(s); // the run is taken over from the answer it recorded
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]!.status).toBe("done");
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations WHERE link_id=?").get(ids[0]!)).toEqual({ n: 1 });
  hold.open();
  await Bun.sleep(10);
  expect(usage(s)).toEqual([{ job_id: jobs(s, batch)[0]!.id, status: "done" }]);
});

test("a run taken over with a recorded answer it can't save, its link unreadable, settles as possibly billed", async () => {
  const { s, ids } = await start();
  const calls = provider(answer);
  holdFinalize();
  s.queue.timeoutMs = 20;
  const batch = await autotag(s, ids);
  await s.runQueued();
  fakes.failSql = /^SELECT \* FROM links WHERE id=\? AND user_id=\?/;
  await abandon(s);
  expect(calls.n).toBe(1);
  expect(jobs(s, batch)[0]).toMatchObject({ status: "failed", reason: "interrupted", error: JEV_FAILURE_MESSAGES.interrupted });
});
