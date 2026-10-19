// FAC-53: a link runs one job at a time. Jev requested on a link whose extraction is queued or running waits
// for it (status 'waiting', outside the Queue) and starts when it settles, without blocking other links or batches.
import { afterEach, expect, test } from "bun:test";
import { dispatch, fakes, resetClock, setup } from "./worker-harness";
import { recover } from "../worker/jobs";

afterEach(resetClock);

type S = Awaited<ReturnType<typeof setup>>;
async function start() {
  const s = await setup({ placeholder: true });
  Object.assign(s.env as any, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  await s.api("/tags", "POST", { name: "topic" });
  return s;
}
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const jobOf = (s: S, batch: string, link: string) =>
  s.db.query("SELECT id,status,step,error FROM jobs WHERE batch_id=? AND link_id=?").get(batch, link) as { id: string; status: string; step: string; error: string | null };
const batchOf = (s: S, where: string, id: string) => (s.db.query(`SELECT batch_id FROM jobs WHERE ${where}=?`).get(id) as { batch_id: string }).batch_id;
const sentIds = (s: S) => s.sent.map((m) => m.body.id);
const active = (s: S, link: string) =>
  (s.db.query("SELECT count(*) n FROM jobs WHERE link_id=? AND status IN ('queued','running')").get(link) as { n: number }).n;
const usage = (s: S) => (s.db.query("SELECT count(*) n FROM usage_events").get() as { n: number }).n;
const activity = async (s: S, batch: string) => (await s.api(`/batches/${batch}`)).data.jobs as { link_id: string; status: string; waiting_for: string | null }[];
const run = async (s: S, ids: string[]) => {
  s.sent.splice(0, s.sent.length, ...s.sent.filter((m) => !ids.includes(m.body.id)));
  for (const id of ids) await s.runJob(id);
};

test("auto-tag on ready, extracting and never-extracted links: ready runs now, extracting waits, the rest is skipped", async () => {
  const s = await start();
  const ready = await save(s, "https://q.example/ready");
  await s.runQueued();
  const extracting = await save(s, "https://q.example/extracting");
  const extractJob = sentIds(s)[0]!;
  const never = await save(s, "https://q.example/never");
  await s.api(`/batches/${batchOf(s, "link_id", never)}`, "DELETE");
  s.sent.splice(0);

  const res = await s.api("/batches", "POST", { kind: "autotag", ids: [ready, extracting, never] });
  expect(res.status).toBe(200);
  expect(res.data.skipped).toEqual([never]);
  const batch = res.data.batchId as string;
  expect(jobOf(s, batch, never)).toBeNull();
  expect(jobOf(s, batch, ready).status).toBe("queued");
  expect(jobOf(s, batch, extracting).status).toBe("waiting");
  // Only the ready link goes to the Queue; the waiting one is not sent.
  expect(sentIds(s)).toEqual([jobOf(s, batch, ready).id]);
  // Activity shows what it waits for; the batch counts it as active and the link as processing.
  expect((await activity(s, batch)).find((j) => j.link_id === extracting)).toMatchObject({ status: "waiting", waiting_for: "extract" });
  expect((await s.api("/library")).data.batches.find((b: { id: string }) => b.id === batch)).toMatchObject({ total: 2, active: 2, waiting: 1 });
  expect(await s.view(extracting)).toMatchObject({ processing: true, content: "queued" });

  // The ready link is not held back by the other link's extraction.
  await s.runQueued();
  expect(jobOf(s, batch, ready).status).toBe("done");
  expect(jobOf(s, batch, extracting).status).toBe("waiting");

  // The extraction settles and its waiting auto-tag starts, with no action from the user.
  await s.runJob(extractJob);
  expect(jobOf(s, batch, extracting).status).toBe("queued");
  expect(sentIds(s)).toEqual([jobOf(s, batch, extracting).id]);
  await s.runQueued();
  expect(jobOf(s, batch, extracting).status).toBe("done");
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations WHERE link_id=?").get(extracting)).toMatchObject({ n: 1 });
  expect((await s.api("/library")).data.batches.find((b: { id: string }) => b.id === batch)).toMatchObject({ active: 0, done: 2 });
  expect(await s.view(extracting)).toMatchObject({ processing: false, attention: false });
});

test("only never-extracted links: refused with a plain reason, nothing enqueued", async () => {
  const s = await start();
  const id = await save(s, "https://q.example/none");
  await s.api(`/batches/${batchOf(s, "link_id", id)}`, "DELETE");
  const jobs = s.db.query("SELECT count(*) n FROM jobs").get();
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.error).toBe("This link has no content yet. Extract it first.");
  expect(s.db.query("SELECT count(*) n FROM jobs").get()).toEqual(jobs);
});

test("another batch is not blocked: a lens on a ready link runs while auto-tag waits for an extraction elsewhere", async () => {
  const s = await start();
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0];
  const ready = await save(s, "https://q.example/a");
  await s.runQueued();
  const extracting = await save(s, "https://q.example/b");
  const extractJob = sentIds(s)[0]!;
  s.sent.splice(0);
  const tagBatch = (await s.api("/batches", "POST", { kind: "autotag", ids: [extracting] })).data.batchId;
  const lensBatch = (await s.api("/batches", "POST", { kind: "lens", ids: [ready], lensId: lens.id })).data.batchId;
  expect(jobOf(s, tagBatch, extracting).status).toBe("waiting");
  expect(sentIds(s)).toEqual([jobOf(s, lensBatch, ready).id]);
  await s.runQueued();
  expect(jobOf(s, lensBatch, ready).status).toBe("done");
  await s.runJob(extractJob);
  await s.runQueued();
  expect(jobOf(s, tagBatch, extracting).status).toBe("done");
});

test("Jev jobs on one link run one after the other, oldest first; never two active jobs on a link", async () => {
  const s = await start();
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0];
  const id = await save(s, "https://q.example/fifo");
  await s.runQueued();
  const first = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const second = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  const third = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  expect([first, second, third].map((b) => jobOf(s, b, id).status)).toEqual(["queued", "waiting", "waiting"]);
  // Extraction is still refused while the link is busy (it never waits behind Jev).
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).data.error).toBe("Some selected links are still processing.");
  const order: string[] = [];
  while (s.sent.length) {
    expect(active(s, id)).toBe(1);
    const [m] = s.sent.splice(0, 1);
    order.push(batchOf(s, "id", m!.body.id));
    await s.runJob(m!.body.id);
  }
  expect(order).toEqual([first, second, third]);
  expect([first, second, third].map((b) => jobOf(s, b, id).status)).toEqual(["done", "done", "done"]);
});

test("an extraction that fails for good resolves its waiting Jev job as content missing, without a provider call", async () => {
  const s = await start();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://q.example/fails");
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  expect(jobOf(s, batch, id).status).toBe("waiting");
  await s.runQueued(); // the extraction fails and promotes the auto-tag
  s.steps.splice(0);
  await s.runQueued(); // the auto-tag fails before taking a slot or calling Jev
  expect(jobOf(s, batch, id)).toMatchObject({ status: "failed", error: "Content missing. Extract it first." });
  expect(usage(s)).toBe(0);
  expect(s.steps.some((x) => x.name.startsWith("provider-slot"))).toBe(false);
  // The link is in Needs attention for its content, not because of the auto-tag; no extraction was started.
  expect(await s.view(id)).toMatchObject({ processing: false, attention: true, attention_kind: "content", attention_reason: "not_found" });
  expect(fakes.calls.content).toBe(1);
  expect(s.sent).toHaveLength(0);
});

test("with the preview fallback, the waiting Jev job runs on the preview content", async () => {
  const s = await start();
  fakes.meta = { status: "ready", description: "About the page." };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://q.example/fallback");
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  await s.runQueued();
  await s.runQueued();
  expect(jobOf(s, batch, id).status).toBe("done");
  expect(await s.view(id)).toMatchObject({ attention: false, processing: false });
});

test("cancelling a batch drops its waiting jobs; the extraction they waited for continues", async () => {
  const s = await start();
  const id = await save(s, "https://q.example/cancel");
  const extractJob = sentIds(s)[0]!;
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const res = await s.api(`/batches/${batch}`, "DELETE");
  expect(res.data.cancelled).toBe(1);
  expect(jobOf(s, batch, id)).toMatchObject({ status: "failed", step: "Cancelled" });
  expect(await s.view(id)).toMatchObject({ processing: true, content: "queued" });
  await run(s, [extractJob]);
  expect(s.sent).toHaveLength(0);
  expect(await s.view(id)).toMatchObject({ processing: false, content: "ready", attention: false });
  expect(usage(s)).toBe(0);
});

const lensOf = async (s: S) =>
  (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0] as { id: string };
const results = (s: S, link: string) => ({
  evaluations: (s.db.query("SELECT count(*) n FROM tag_evaluations WHERE link_id=?").get(link) as { n: number }).n,
  lens: (s.db.query("SELECT count(*) n FROM lens_results WHERE link_id=?").get(link) as { n: number }).n,
});
const runAll = async (s: S) => {
  while (s.sent.length) await s.runQueued();
};

test("cancelling an extraction cancels the Jev jobs waiting for it: fresh link, several dependents, nothing runs", async () => {
  const s = await start();
  const lens = await lensOf(s);
  const id = await save(s, "https://q.example/cancel-fresh");
  const extractBatch = batchOf(s, "link_id", id);
  s.sent.splice(0);
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  const res = await s.api(`/batches/${extractBatch}`, "DELETE");
  expect(res.data).toMatchObject({ cancelled: 1, dependents: 2 });
  for (const b of [tag, ask]) expect(jobOf(s, b, id)).toMatchObject({ status: "failed", step: "Cancelled", error: "Cancelled: its extraction was cancelled" });
  expect(s.sent).toHaveLength(0);
  // Recovery does not bring them back.
  await recover(s.env);
  expect(s.sent).toHaveLength(0);
  expect([tag, ask].map((b) => jobOf(s, b, id).status)).toEqual(["failed", "failed"]);
  expect(await s.view(id)).toMatchObject({ processing: false, attention: false, content: "missing" });
  expect(usage(s)).toBe(0);
  expect(results(s, id)).toEqual({ evaluations: 0, lens: 0 });
});

test("cancelling a re-extraction cancels its dependents too: the previous content and results stay, no provider call", async () => {
  const s = await start();
  const lens = await lensOf(s);
  const id = await save(s, "https://q.example/cancel-retained");
  await runAll(s);
  const before = s.db.query("SELECT content_key,content_version,content_state,attention_kind FROM links WHERE id=?").get(id);
  const reextract = (await s.api("/batches", "POST", { kind: "extract", ids: [id] })).data.batchId;
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  s.sent.splice(0);
  expect((await s.api(`/batches/${reextract}`, "DELETE")).data).toMatchObject({ cancelled: 1, dependents: 2 });
  await runAll(s);
  await recover(s.env);
  await runAll(s);
  expect([tag, ask].map((b) => jobOf(s, b, id).step)).toEqual(["Cancelled", "Cancelled"]);
  expect(s.db.query("SELECT content_key,content_version,content_state,attention_kind FROM links WHERE id=?").get(id)).toEqual(before);
  expect(fakes.calls.content).toBe(1);
  expect(usage(s)).toBe(0);
  expect(results(s, id)).toEqual({ evaluations: 0, lens: 0 });
});

test("cancel cascades only from extractions it actually cancelled; unrelated waiting work still starts", async () => {
  const s = await start();
  const lens = await lensOf(s);
  const queued = await save(s, "https://q.example/mixed-queued");
  const running = await save(s, "https://q.example/mixed-running");
  const ready = await save(s, "https://q.example/mixed-ready");
  await runAll(s);
  // One extract batch over two links: one job already running (it finishes, keeps its dependent), one queued.
  const extract = (await s.api("/batches", "POST", { kind: "extract", ids: [queued, running] })).data.batchId;
  s.db.run("UPDATE jobs SET status='running' WHERE batch_id=? AND link_id=?", [extract, running]);
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids: [queued, running, ready] })).data.batchId;
  const ask = (await s.api("/batches", "POST", { kind: "lens", ids: [ready], lensId: lens.id })).data.batchId;
  expect([queued, running, ready].map((l) => jobOf(s, tag, l).status)).toEqual(["waiting", "waiting", "queued"]);
  expect(jobOf(s, ask, ready).status).toBe("waiting");
  s.sent.splice(0);

  expect((await s.api(`/batches/${extract}`, "DELETE")).data).toMatchObject({ cancelled: 1, dependents: 1 });
  expect(jobOf(s, tag, queued).step).toBe("Cancelled");
  expect(jobOf(s, tag, running).status).toBe("waiting");
  expect(s.sent).toHaveLength(0);

  // An unrelated cancel: the auto-tag batch drops its jobs and the lens waiting behind it on the ready link starts.
  expect((await s.api(`/batches/${tag}`, "DELETE")).data).toMatchObject({ cancelled: 2, dependents: 0 });
  expect(jobOf(s, ask, ready).status).toBe("queued");
  expect(sentIds(s)).toEqual([jobOf(s, ask, ready).id]);
  await runAll(s);
  expect(jobOf(s, ask, ready).status).toBe("done");
});

test("recover starts an orphaned waiting job once; dispatch ignores waiting jobs and repeats", async () => {
  const s = await start();
  const id = await save(s, "https://q.example/orphan");
  await s.runQueued();
  const first = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const second = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const third = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  const waiting = jobOf(s, second, id).id;
  s.sent.splice(0);

  // A stray message for a waiting job creates no workflow.
  const created: string[] = [];
  (s.env as any).PROCESS_LINK = { create: async ({ id }: { id: string }) => void created.push(id), get: async () => ({ status: async () => null }) };
  await dispatch({ messages: [{ body: { id: waiting }, ack() {}, retry() {} }] } as never, s.env);
  expect(created).toEqual([]);
  expect(jobOf(s, second, id).status).toBe("waiting");

  // The first job settles without promoting (a crash between the two): recover starts only the oldest waiting job.
  s.db.run("UPDATE jobs SET status='done' WHERE id=?", [jobOf(s, first, id).id]);
  await recover(s.env);
  await recover(s.env);
  expect([second, third].map((b) => jobOf(s, b, id).status)).toEqual(["queued", "waiting"]);
  expect(active(s, id)).toBe(1);
  expect(new Set(sentIds(s))).toEqual(new Set([waiting]));
  // Dispatching the promoted job twice creates one workflow: the second create fails and finds it running.
  (s.env as any).PROCESS_LINK = {
    create: async ({ id }: { id: string }) => {
      if (created.includes(id)) throw new Error("instance already exists");
      created.push(id);
    },
    get: async () => ({ status: async () => ({ status: "running" }) }),
  };
  const acks = { n: 0, retries: 0 };
  const message = { body: { id: waiting }, ack: () => void acks.n++, retry: () => void acks.retries++ };
  await dispatch({ messages: [message, message] } as never, s.env);
  expect(created).toEqual([waiting]);
  expect(acks).toEqual({ n: 2, retries: 0 });
});

test("an interrupted job starts the next waiting job on its link", async () => {
  const s = await start();
  const id = await save(s, "https://q.example/interrupted");
  const extractJob = sentIds(s)[0]!;
  s.sent.splice(0);
  const batch = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId;
  (s.env as any).PROCESS_LINK = {
    create: async () => { throw new Error("exists"); },
    get: async () => ({ status: async () => ({ status: "errored" }) }),
  };
  await dispatch({ messages: [{ body: { id: extractJob }, ack() {}, retry() {} }] } as never, s.env);
  expect(s.db.query("SELECT step FROM jobs WHERE id=?").get(extractJob)).toEqual({ step: "Interrupted" });
  expect(jobOf(s, batch, id).status).toBe("queued");
  expect(sentIds(s)).toEqual([jobOf(s, batch, id).id]);
});

// Round 2: the client sends a selection in chunks of 100; a chunk with no eligible link must not stop the others.
async function noContentLinks(s: S, prefix: string, n: number) {
  const res = await s.api("/import", "POST", { urls: Array.from({ length: n }, (_, i) => `https://${prefix}.example/${i}`) });
  const ids = (res.data.links as { id: string; url: string }[]).filter((l) => l.url.includes(`${prefix}.example`)).map((l) => l.id);
  await s.api(`/batches/${batchOf(s, "link_id", ids[0]!)}`, "DELETE");
  s.sent.splice(0);
  return ids;
}
const sendChunk = (s: S, kind: string, lensId?: string) => async (chunk: string[]) => {
  const res = await s.api("/batches", "POST", { kind, ids: chunk, lensId });
  if (res.status !== 200) throw Object.assign(new Error(res.data.error), { data: res.data });
  return res.data as { batchId?: string; skipped?: string[] };
};

test("a selection over 100 with a wholly unsupported first or middle chunk still runs its eligible links", async () => {
  const { submitInChunks } = await import("../src/batches");
  const s = await start();
  const lens = await lensOf(s);
  const first = await save(s, "https://q.example/chunk-first");
  const last = await save(s, "https://q.example/chunk-last");
  await runAll(s);
  const a = await noContentLinks(s, "a", 100);
  const b = await noContentLinks(s, "b", 99);
  // Unsupported first chunk: [100 without content], [ready].
  const firstChunk = await submitInChunks([...a, last], sendChunk(s, "autotag"));
  expect(firstChunk.batchIds).toHaveLength(1);
  expect(firstChunk.skipped.toSorted()).toEqual(a.toSorted());
  // Unsupported middle chunk: [ready + 99], [100], [ready].
  const middle = await submitInChunks([first, ...b, ...a, last], sendChunk(s, "lens", lens.id));
  expect(middle.batchIds).toHaveLength(2);
  expect(middle.skipped).toHaveLength(199);
  await runAll(s);
  expect(results(s, last)).toEqual({ evaluations: 1, lens: 1 });
  expect(results(s, first)).toEqual({ evaluations: 0, lens: 1 });

  // Nothing eligible at all: the refusal is reported. Real errors still stop at once.
  await expect(submitInChunks([...a, ...b], sendChunk(s, "autotag"))).rejects.toThrow("None of the selected links have content yet. Extract them first.");
  delete (s.env as any).ALLOW_FIXTURE_JEV;
  const calls: string[][] = [];
  await expect(submitInChunks([...a, last], async (chunk) => (calls.push(chunk), sendChunk(s, "autotag")(chunk)))).rejects.toThrow("Jev is not configured.");
  expect(calls).toHaveLength(1);
});

// Round 2: one-off link edits treat a waiting job (even an orphan before recovery) as busy.
const orphanWaiting = (s: S, link: string) => {
  s.db.run("INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('orphan',?,'autotag','{}','now')", [s.userId]);
  s.db.run("INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('orphan-job','orphan',?,'waiting','now')", [link]);
};
async function failedWithPreview(s: S, url: string) {
  fakes.meta = { status: "ready", description: "About." };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, url);
  const put = s.env.CONTENT.put;
  s.env.CONTENT.put = (async () => { throw new Error("R2 unavailable"); }) as typeof put;
  await runAll(s);
  s.env.CONTENT.put = put;
  return id;
}

test("Use preview is refused while an orphan waiting job is on the link", async () => {
  const s = await start();
  const id = await failedWithPreview(s, "https://q.example/use-preview-orphan");
  orphanWaiting(s, id);
  expect(await s.view(id)).toMatchObject({ processing: true, attention: true, attention_kind: "content" });
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("Wait for the running job to finish.");
  expect(await s.view(id)).toMatchObject({ attention_kind: "content", content: "failed" });
  // The other one-off edits wait too.
  expect((await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" })).data.error).toBe("Wait for the running job to finish.");
  expect((await s.api(`/links/${id}`, "PATCH", { tags: ["x"] })).data.error).toBe("Wait for the running job to finish.");
  expect((await s.api(`/links/${id}/retry`, "POST", { step: "content" })).data.error).toBe("Wait for the running job to finish.");
});

test("Use preview loses to a waiting job that appears between its check and its write", async () => {
  const s = await start();
  const id = await failedWithPreview(s, "https://q.example/use-preview-race");
  fakes.onSql = async (sql, phase) => {
    if (phase !== "write" || !sql.includes("content_source='preview'")) return;
    fakes.onSql = undefined;
    orphanWaiting(s, id);
  };
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("The link changed meanwhile. Try again.");
  expect(await s.view(id)).toMatchObject({ attention_kind: "content", content: "failed", processing: true });
  expect(s.db.query("SELECT content_key FROM links WHERE id=?").get(id)).toEqual({ content_key: null });
});
