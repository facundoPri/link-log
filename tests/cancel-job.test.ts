// FAC-55: one link's job is cancelled from Activity whether queued, waiting or running. A running one has its
// workflow terminated first. The job ends Cancelled as if never requested: what already ran is kept, nothing is
// stored for what didn't, Needs attention is never touched, and an extraction takes its waiting Jev jobs with it.
import { afterEach, expect, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";
import { dispatch, recover } from "../worker/jobs";
import { JEV_FAILURE_MESSAGES } from "../src/failures";

afterEach(resetClock);
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

type S = Awaited<ReturnType<typeof setup>>;
async function start() {
  const s = await setup();
  Object.assign(s.env as any, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  await s.api("/tags", "POST", { name: "topic" });
  return s;
}
const gate = <T = void>() => {
  let open!: (v: T) => void;
  const opened = new Promise<T>((r) => (open = r));
  return { opened, open };
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(1);
  expect(ok()).toBe(true);
};
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const job = (s: S, id: string) =>
  s.db.query("SELECT status,step,error,reason FROM jobs WHERE id=?").get(id) as { status: string; step: string; error: string | null; reason: string | null };
const jobOf = (s: S, batch: string, link: string) =>
  s.db.query("SELECT id,status,step,error FROM jobs WHERE batch_id=? AND link_id=?").get(batch, link) as { id: string; status: string; step: string; error: string | null };
const linkRow = (s: S, id: string) =>
  s.db.query("SELECT content_key,content_version,content_state,content_source,content_error,attention_kind,attention_reason,attention_at FROM links WHERE id=?").get(id) as Record<string, unknown>;
const leases = (s: S) => (s.db.query("SELECT count(*) n FROM provider_leases").get() as { n: number }).n;
const batchSummary = async (s: S, id: string) => (await s.api("/library")).data.batches.find((b: { id: string }) => b.id === id);
const lensOf = async (s: S) =>
  (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0] as { id: string };
const cancel = (s: S, id: string) => s.api(`/jobs/${id}`, "DELETE");
const runAll = async (s: S) => {
  while (s.sent.length) await s.runQueued();
};

// An extraction held inside its content step (the workflow is running) until `release` is called.
async function runningExtraction(s: S, link: string, content: { markdown: string } | { throws: string } = { markdown: "# new" }) {
  const hold = gate<string>();
  fakes.content = { wait: hold.opened.then((m) => (m === "throw" && "throws" in content ? Promise.reject(new Error(content.throws)) : m)) };
  const id = s.sent.splice(0).map((m) => m.body.id).find((j) => (s.db.query("SELECT link_id FROM jobs WHERE id=?").get(j) as { link_id: string }).link_id === link)!;
  const before = fakes.calls.content;
  const running = s.runJob(id);
  await until(() => fakes.calls.content > before);
  expect(job(s, id).status).toBe("running");
  return {
    id,
    release: async () => {
      hold.open("markdown" in content ? content.markdown : "throw");
      await running;
    },
  };
}

test("cancelling a running extraction stops its workflow, cancels its waiting Jev jobs and leaves a fresh link neutral", async () => {
  const s = await start();
  const lens = await lensOf(s);
  const id = await save(s, "https://c.example/fresh");
  const ex = await runningExtraction(s, id);
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  expect([jobOf(s, tag, id).status, jobOf(s, ask, id).status]).toEqual(["waiting", "waiting"]);
  expect(leases(s)).toBe(1);

  const res = await cancel(s, ex.id);
  expect(res.status).toBe(200);
  expect(res.data).toMatchObject({ from: "running", dependents: 2 });
  expect(s.workflows.terminated).toEqual([ex.id]);
  expect(job(s, ex.id)).toMatchObject({ status: "failed", step: "Cancelled", error: "Cancelled", reason: null });
  for (const b of [tag, ask]) expect(jobOf(s, b, id)).toMatchObject({ status: "failed", step: "Cancelled", error: "Cancelled: its extraction was cancelled" });
  expect(leases(s)).toBe(0);
  // The response already carries the library: neutral, not processing, never in Needs attention.
  const l = res.data.links.find((x: { id: string }) => x.id === id);
  expect(l).toMatchObject({ content_state: "missing", processing: false, attention_kind: null });
  expect(await batchSummary(s, tag)).toMatchObject({ total: 1, active: 0, failed: 0, cancelled: 1 });

  // The step in flight finishes, but nothing after it runs: no content stored, nothing settled or started.
  await ex.release();
  expect(fakes.calls.content).toBe(1);
  expect(linkRow(s, id)).toMatchObject({ content_key: null, content_state: "missing", attention_kind: null });
  expect(job(s, ex.id).step).toBe("Cancelled");
  expect(s.sent).toEqual([]);
  await recover(s.env);
  expect(s.sent).toEqual([]);
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations").get()).toEqual({ n: 0 });
  expect(await s.view(id)).toMatchObject({ content: "missing", processing: false, attention: false, job: "failed/Cancelled" });
});

test("cancelling a re-extraction keeps the previous content, or the previous failure, untouched", async () => {
  const s = await start();
  const ok = await save(s, "https://c.example/ok");
  await s.runQueued();
  const before = linkRow(s, ok);
  await s.api("/batches", "POST", { kind: "extract", ids: [ok] });
  const ex = await runningExtraction(s, ok);
  expect((await cancel(s, ex.id)).data).toMatchObject({ from: "running", dependents: 0 });
  await ex.release();
  expect(linkRow(s, ok)).toEqual(before);
  expect(before).toMatchObject({ content_state: "ready" });

  // A link already in Needs attention stays exactly as it was: cancelling neither adds nor clears it.
  fakes.content = { throws: "Markdown: HTTP 404" };
  const bad = await save(s, "https://c.example/bad");
  await s.runQueued();
  const failed = linkRow(s, bad);
  expect(failed).toMatchObject({ content_state: "failed", attention_kind: "content" });
  await s.api("/batches", "POST", { kind: "extract", ids: [bad] });
  const again = await runningExtraction(s, bad);
  await cancel(s, again.id);
  await again.release();
  expect(linkRow(s, bad)).toEqual(failed);
});

test("queued and waiting jobs are cancelled without touching the workflow; the next unrelated waiting job starts", async () => {
  const s = await start();
  const lens = await lensOf(s);
  const id = await save(s, "https://c.example/queue");
  await s.runQueued();
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  const tag2 = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  s.sent.splice(0);
  expect([tag, ask, tag2].map((b) => jobOf(s, b, id).status)).toEqual(["queued", "waiting", "waiting"]);

  // A waiting job: only it goes; the queued one ahead is untouched and nothing new starts.
  expect((await cancel(s, jobOf(s, ask, id).id)).data).toMatchObject({ from: "waiting", dependents: 0 });
  expect([tag, ask, tag2].map((b) => jobOf(s, b, id).status)).toEqual(["queued", "failed", "waiting"]);
  expect(s.sent).toEqual([]);
  // A queued Jev job: the auto-tag waiting behind it starts.
  expect((await cancel(s, jobOf(s, tag, id).id)).data).toMatchObject({ from: "queued", dependents: 0 });
  expect(jobOf(s, tag2, id).status).toBe("queued");
  expect(s.sent.map((m) => m.body.id)).toEqual([jobOf(s, tag2, id).id]);
  expect(s.workflows.terminated).toEqual([]);
  // A stray message for the cancelled job runs nothing.
  await s.runJob(jobOf(s, tag, id).id);
  expect(jobOf(s, tag, id)).toMatchObject({ status: "failed", step: "Cancelled" });
  await runAll(s);
  expect(jobOf(s, tag2, id).status).toBe("done");
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations WHERE batch_id=?").get(tag)).toEqual({ n: 0 });

  // A queued extraction takes its waiting dependents with it and restores the link.
  const fresh = await save(s, "https://c.example/queued-extract");
  const extractJob = s.sent.splice(0)[0]!.body.id;
  const dep = (await s.api("/batches", "POST", { kind: "autotag", ids: [fresh] })).data.batchId;
  expect((await cancel(s, extractJob)).data).toMatchObject({ from: "queued", dependents: 1 });
  expect(jobOf(s, dep, fresh).step).toBe("Cancelled");
  expect(await s.view(fresh)).toMatchObject({ content: "missing", processing: false, attention: false });
  expect(s.sent).toEqual([]);
  // Finished or unknown jobs are refused plainly.
  expect(await cancel(s, extractJob)).toMatchObject({ status: 409, data: { error: "This job already finished." } });
  expect((await cancel(s, "nope")).status).toBe(404);
});

test("a cancelled job's late settlement changes nothing: a failure sets no attention and no preview fallback", async () => {
  const s = await start();
  await s.api("/settings", "PUT", { preview_fallback: true });
  s.workflows.terminate = "ignore"; // the workflow carries on to record-failure as if the terminate came too late
  const id = await save(s, "https://c.example/late-failure");
  const ex = await runningExtraction(s, id, { throws: "Markdown: HTTP 404" });
  await cancel(s, ex.id);
  const after = linkRow(s, id);
  await ex.release();
  expect(s.steps.some((x) => x.name === "record-failure")).toBe(true);
  expect(job(s, ex.id)).toMatchObject({ status: "failed", step: "Cancelled", error: "Cancelled", reason: null });
  expect(linkRow(s, id)).toEqual(after);
  expect(linkRow(s, id)).toMatchObject({ content_key: null, content_source: null, content_state: "missing", attention_kind: null });
  expect(await s.view(id)).toMatchObject({ attention: false, processing: false });
});

test("a cancelled job's late success stores no content and never turns Done", async () => {
  const s = await start();
  s.workflows.terminate = "ignore";
  const id = await save(s, "https://c.example/late-success");
  const ex = await runningExtraction(s, id);
  await cancel(s, ex.id);
  await ex.release();
  expect(s.steps.some((x) => x.name === "complete")).toBe(true);
  expect(job(s, ex.id)).toMatchObject({ status: "failed", step: "Cancelled" });
  expect(linkRow(s, id)).toMatchObject({ content_key: null, content_state: "missing", attention_kind: null });
});

test("a job that settles while the cancel is on its way wins cleanly: the cancel reports it already finished", async () => {
  const s = await start();
  const lens = await lensOf(s);
  const id = await save(s, "https://c.example/race");
  const ex = await runningExtraction(s, id);
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  // The job completes between the terminate and the cancel's write.
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && sql.startsWith("UPDATE jobs SET status='failed',step='Cancelled'")) {
      fakes.onSql = undefined;
      s.workflows.terminated.length = 0;
      await ex.release();
    }
  };
  s.workflows.terminate = "ignore";
  const res = await cancel(s, ex.id);
  expect(res).toMatchObject({ status: 409, data: { error: "This job already finished." } });
  expect(job(s, ex.id)).toMatchObject({ status: "done", step: "Done" });
  expect(linkRow(s, id)).toMatchObject({ content_state: "ready" });
  // Its dependent was promoted by the completion, not cancelled.
  expect(jobOf(s, ask, id).status).toBe("queued");
});

test("a terminate that fails on a live instance cancels nothing; an instance that already ended is cancelled", async () => {
  const s = await start();
  const id = await save(s, "https://c.example/terminate");
  const ex = await runningExtraction(s, id);
  s.workflows.terminate = "throw";
  expect(await cancel(s, ex.id)).toMatchObject({ status: 400, data: { error: "Could not stop this job. Try again." } });
  expect(job(s, ex.id).status).toBe("running");
  expect(leases(s)).toBe(1);
  s.workflows.terminate = "ended";
  expect((await cancel(s, ex.id)).status).toBe(200);
  expect(job(s, ex.id).step).toBe("Cancelled");
  s.workflows.terminate = "stop";
  await ex.release();
});

// Jev behind a scripted provider (TypeSafe), as in jev-phases.test.ts.
function provider(respond: (questions: Record<string, unknown>) => Response | Promise<Response>) {
  const calls = { n: 0 };
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls.n++;
    return respond(JSON.parse(String(init?.body)).questions);
  }) as typeof fetch;
  return calls;
}
const answer = (questions: Record<string, unknown>) =>
  Response.json({
    model: "jev-test",
    answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }])),
    usage: { input_tokens: 100, output_tokens: 5 },
  });
async function jevReady() {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://c.example/jev" })).data.id as string;
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  Object.assign(s.env as any, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  return { s, id };
}
const usage = (s: S) => s.db.query("SELECT status FROM usage_events WHERE service='jev'").all() as { status: string }[];

test("a running Jev job cancelled before its call claim never calls Jev and records no usage", async () => {
  const { s, id } = await jevReady();
  const calls = provider(answer);
  const hold = gate();
  let reached = false;
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && /^UPDATE jobs SET jev_call=/.test(sql) && !reached) { reached = true; await hold.opened; }
  };
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const j = s.sent.splice(0)[0]!.body.id;
  const running = s.runJob(j);
  await until(() => reached);
  expect((await cancel(s, j)).data).toMatchObject({ from: "running" });
  hold.open();
  await running;
  expect(calls.n).toBe(0);
  expect(usage(s)).toEqual([]);
  expect(jobOf(s, batch, id)).toMatchObject({ status: "failed", step: "Cancelled", error: "Cancelled" });
  expect(await s.view(id)).toMatchObject({ attention: false, processing: false });
});

test("a running Jev job cancelled after sending may have been billed, is never resent and stores no result", async () => {
  const { s, id } = await jevReady();
  const reply = gate();
  const calls = provider(async (q) => (await reply.opened, answer(q)));
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const j = s.sent.splice(0)[0]!.body.id;
  const running = s.runJob(j);
  await until(() => calls.n === 1);
  const res = await cancel(s, j);
  expect(res.status).toBe(200);
  expect(jobOf(s, batch, id)).toMatchObject({ status: "failed", step: "Cancelled", error: JEV_FAILURE_MESSAGES.cancelled_sent });
  // Usage keeps the call (it may be billed) as soon as the cancel lands.
  expect(usage(s)).toEqual([{ status: "failed" }]);
  reply.open();
  await running;
  await recover(s.env);
  await runAll(s);
  expect(calls.n).toBe(1);
  expect(usage(s)).toHaveLength(1);
  expect(jobOf(s, batch, id).step).toBe("Cancelled");
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations").get()).toEqual({ n: 0 });
  // Not a failure: no Retry for it and no failed count.
  expect(await batchSummary(s, batch)).toMatchObject({ failed: 0, cancelled: 1, active: 0 });
  expect((await s.api(`/batches/${batch}/retry`, "POST")).data.error).toBe("Nothing to retry.");
  expect(await s.view(id)).toMatchObject({ attention: false });
});

// Round 2 (review): a write already on its way when the cancel lands is fenced inside the statement itself.
// Each test pauses one real write of the stopped workflow's in-flight step, cancels, then lets it run.
function pauseAt(pattern: RegExp) {
  const hold = gate();
  const state = { reached: false };
  fakes.onSql = async (sql, phase) => {
    if (phase === "write" && !state.reached && pattern.test(sql)) {
      state.reached = true;
      await hold.opened;
    }
  };
  return { state, release: hold.open };
}
const attention = (s: S, id: string) =>
  s.db.query("SELECT status,preview_reason,attention_kind,attention_reason,attention_at FROM links WHERE id=?").get(id);

test("a pending attention write of a cancelled extraction adds nothing to Needs attention", async () => {
  const s = await start();
  fakes.meta = { status: "failed" }; // the preview fails fast (403); the content works
  const id = await save(s, "https://c.example/attention");
  const j = s.sent.splice(0)[0]!.body.id;
  const pause = pauseAt(/^UPDATE links SET attention_kind=/);
  const running = s.runJob(j);
  await until(() => pause.state.reached);
  expect((await cancel(s, j)).status).toBe(200);
  const atCancel = attention(s, id);
  pause.release();
  await running;
  expect(attention(s, id)).toEqual(atCancel);
  expect(atCancel).toMatchObject({ attention_kind: null });
  expect(await s.view(id)).toMatchObject({ attention: false, job: "failed/Cancelled" });
});

test("a cancelled preview retry publishes no preview failure and no attention", async () => {
  const s = await start();
  const imp = await s.api("/import", "POST", { urls: ["https://c.example/preview-only"] });
  const id = imp.data.links[0].id as string;
  await s.api(`/batches/${imp.data.batches[0].id}`, "DELETE");
  s.sent.splice(0);
  fakes.meta = { status: "failed" };
  await s.api(`/links/${id}/retry`, "POST");
  const j = s.sent.splice(0)[0]!.body.id;
  const before = attention(s, id);
  const pause = pauseAt(/^UPDATE links SET preview_reason=/);
  const running = s.runJob(j);
  await until(() => pause.state.reached);
  expect((await cancel(s, j)).status).toBe(200);
  pause.release();
  await running;
  expect(attention(s, id)).toEqual(before);
  expect(before).toMatchObject({ status: "pending", attention_kind: null });
  expect(await s.view(id)).toMatchObject({ attention: false });
});

// Two Jev jobs on one link: A is cancelled while its save is pending, B runs and saves, then A's write lands.
async function successorRace(kind: "autotag" | "lens", pattern: RegExp) {
  const { s, id } = await jevReady();
  const lens = kind === "lens" ? await lensOf(s) : null;
  const scores = [0.2, 0.9];
  const calls = provider((q) =>
    Response.json({
      model: "jev-test",
      answers: Object.fromEntries(Object.keys(q).map((k) => [k, { type: "noul", noul: scores[calls.n - 1] }])),
      usage: { input_tokens: 100, output_tokens: 5 },
    }));
  const body = { kind, ids: [id], ...(lens && { lensId: lens.id }) };
  const a = (await s.api("/batches", "POST", body)).data.batchId;
  const b = (await s.api("/batches", "POST", body)).data.batchId;
  const ja = s.sent.splice(0)[0]!.body.id;
  const pause = pauseAt(pattern);
  const runningA = s.runJob(ja);
  await until(() => pause.state.reached);
  expect((await cancel(s, ja)).status).toBe(200);
  expect(s.sent.map((m) => m.body.id)).toEqual([jobOf(s, b, id).id]);
  await s.runQueued();
  expect(jobOf(s, b, id).status).toBe("done");
  pause.release();
  await runningA;
  expect(calls.n).toBe(2);
  expect(s.db.query("SELECT status,step,result FROM jobs WHERE id=?").get(ja)).toEqual({ status: "failed", step: "Cancelled", result: null });
  return { s, id, a, b };
}

test("a cancelled auto-tag's pending save never replaces the tags of the auto-tag that ran after it", async () => {
  const { s, id, b } = await successorRace("autotag", /^DELETE FROM link_tags/);
  expect(s.db.query("SELECT probability,batch_id FROM tag_evaluations WHERE link_id=?").all(id)).toEqual([{ probability: 0.9, batch_id: b }]);
  const applied = (s.db.query("SELECT threshold FROM tags").get() as { threshold: number }).threshold <= 0.9 ? 1 : 0;
  expect((s.db.query("SELECT count(*) n FROM link_tags WHERE link_id=?").get(id) as { n: number }).n).toBe(applied);
});

test("a cancelled lens's pending save never replaces the result of the lens that ran after it", async () => {
  const { s, id, b } = await successorRace("lens", /^INSERT OR REPLACE INTO lens_results/);
  const row = s.db.query("SELECT answer,batch_id FROM lens_results WHERE link_id=?").get(id) as { answer: string; batch_id: string };
  expect(row.batch_id).toBe(b);
  expect(JSON.parse(row.answer).noul).toBe(0.9);
});

// A social-style link whose first extraction kept one media item, with stored OCR.
async function socialWithMedia(media: { media_key: string; url: string }[]) {
  const s = await start();
  const found = (items: typeof media) => ({
    source: "x-post", text: "post", title: "Post",
    media: items.map((m, position) => ({ ...m, position, kind: "image", preview_url: null })),
    details: { completeness: "verified", issues: [] },
  });
  fakes.discover = () => found(media);
  const id = await save(s, "https://c.example/social");
  await s.runQueued();
  s.db.run("UPDATE media_items SET ocr_state='failed',ocr_text=NULL,ocr_error='old error' WHERE link_id=?", [id]);
  expect(linkRow(s, id)).toMatchObject({ content_state: "partial", content_version: 1 });
  const mediaRows = () => s.db.query("SELECT media_key,url,ocr_state,ocr_text,ocr_error FROM media_items WHERE link_id=? ORDER BY media_key").all(id);
  return { s, id, mediaRows, found };
}
async function cancelDuring(s: S, id: string, pattern: RegExp) {
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  const j = s.sent.splice(0)[0]!.body.id;
  const pause = pauseAt(pattern);
  const running = s.runJob(j);
  await until(() => pause.state.reached);
  expect((await cancel(s, j)).status).toBe(200);
  pause.release();
  await running;
}

test("a cancelled social re-extraction's pending media publication keeps the stored media", async () => {
  const { s, id, mediaRows, found } = await socialWithMedia([{ media_key: "old", url: "https://example.com/old.jpg" }]);
  const before = mediaRows(), content = linkRow(s, id);
  fakes.discover = () => found([]); // the new run finds no media at all
  await cancelDuring(s, id, /^DELETE FROM media_items WHERE link_id=/);
  expect(mediaRows()).toEqual(before);
  expect(linkRow(s, id)).toEqual(content);
});

test("a cancelled social re-extraction's pending OCR result keeps the stored OCR", async () => {
  const { s, id, mediaRows } = await socialWithMedia([{ media_key: "old", url: "https://example.com/old.jpg" }]);
  const before = mediaRows(), content = linkRow(s, id);
  expect(before).toEqual([{ media_key: "old", url: "https://example.com/old.jpg", ocr_state: "failed", ocr_text: null, ocr_error: "old error" }]);
  await cancelDuring(s, id, /^UPDATE media_items SET ocr_state=/);
  expect(mediaRows()).toEqual(before);
  expect(linkRow(s, id)).toEqual(content);
});

test("a slot acquisition in flight when its job is cancelled leaves no lease; the next job gets the slot at once", async () => {
  const s = await start();
  Object.assign(s.env as any, { BROWSER_CONCURRENCY: "1" });
  const first = await save(s, "https://c.example/slot-1");
  const j = s.sent.splice(0)[0]!.body.id;
  const pause = pauseAt(/^INSERT OR IGNORE INTO provider_leases/);
  const running = s.runJob(j);
  await until(() => pause.state.reached);
  expect((await cancel(s, j)).status).toBe(200);
  pause.release();
  await running;
  expect(leases(s)).toBe(0);
  expect(fakes.calls).toMatchObject({ meta: 0, content: 0 });
  expect(await s.view(first)).toMatchObject({ processing: false, attention: false, job: "failed/Cancelled" });
  const second = await save(s, "https://c.example/slot-2");
  await s.runQueued();
  expect(s.steps.some((x) => x.name.startsWith("waiting-for-slot"))).toBe(false);
  expect(await s.view(second)).toMatchObject({ content: "ready", job: "done/Done" });
});

test("stale Queue recovery after a cancel leaves the successor extraction's queued state alone", async () => {
  const s = await start();
  const id = await save(s, "https://c.example/stale");
  const ex = await runningExtraction(s, id);
  // A redelivered message for the running job finds its instance and waits on its status.
  const real = (s.env as any).PROCESS_LINK;
  const held = gate<{ status: string }>();
  let asked = false;
  (s.env as any).PROCESS_LINK = {
    create: async () => { throw new Error("instance already exists"); },
    get: async (j: string) => ({ ...(await real.get(j)), status: () => ((asked = true), held.opened) }),
  };
  const acked: string[] = [];
  const recovery = dispatch({ messages: [{ body: { id: ex.id }, ack: () => void acked.push(ex.id), retry() {} }] } as never, s.env);
  await until(() => asked);
  (s.env as any).PROCESS_LINK = real;

  expect((await cancel(s, ex.id)).status).toBe(200);
  const next = (await s.api("/batches", "POST", { kind: "extract", ids: [id] })).data.batchId;
  const pending = s.sent.splice(0);
  const successor = jobOf(s, next, id);
  expect(successor.status).toBe("queued");
  expect(linkRow(s, id).content_state).toBe("queued");

  held.open({ status: "terminated" });
  await recovery;
  expect(acked).toEqual([ex.id]);
  expect(job(s, ex.id).step).toBe("Cancelled");
  expect(jobOf(s, next, id).status).toBe("queued");
  const l = (await s.api("/library")).data.links.find((x: { id: string }) => x.id === id);
  expect(l).toMatchObject({ content_state: "queued", processing: true, attention_kind: null });
  // Jev (SelectionBar, App) still counts it as an extraction on the way.
  expect(!l.content_key && l.content_state !== "queued").toBe(false);
  // Nothing settled here, so nothing is resent.
  expect(s.sent).toEqual([]);
  await ex.release();
  s.sent.push(...pending);
  await runAll(s);
  expect(await s.view(id)).toMatchObject({ content: "ready", processing: false, job: "done/Done" });
});
