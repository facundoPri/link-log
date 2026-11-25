// FAC-46: deleting links removes them with everything they own (content and previews in R2, tag associations, tag
// evaluations, lens results, media, hidden related links). Tag definitions stay (ADR 0003). Their unfinished jobs,
// running ones included, are cancelled as "Cancelled: link deleted" and stay in Activity, and nothing a job still in
// flight does afterwards can write for a deleted link. Cross-owner attempts are covered in isolation.test.ts.
import { afterEach, expect, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";

afterEach(resetClock);

type S = Awaited<ReturnType<typeof setup>>;
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const drain = async (s: S) => {
  while (s.sent.length) await s.runQueued();
};
const count = (s: S, table: string, linkId: string) =>
  (s.db.query(`SELECT count(*) n FROM ${table} WHERE link_id=?`).get(linkId) as { n: number }).n;
const objectsOf = (s: S, linkId: string) => [...s.r2.keys()].filter((k) => k.includes(linkId));
const bulkDelete = (s: S, ids: unknown) => s.api("/links/delete", "POST", { ids });

const OWNED = ["link_tags", "tag_evaluations", "lens_results", "media_items", "hidden_related_links", "jobs"];

/** A link with content, a tag, an evaluation, a lens result, media, a hidden related link and a legacy object. */
async function richLink(s: S, url: string, lensId: string) {
  const id = await save(s, url);
  await drain(s);
  await s.api(`/links/${id}`, "PATCH", { tags: ["keep-me"] });
  await s.api(`/links/${id}/related-links`, "PUT", { url: "https://related.example/x", hidden: true });
  const { tag, batch } = s.db.query("SELECT (SELECT id FROM tags) tag,(SELECT batch_id FROM jobs WHERE link_id=?) batch").get(id) as { tag: string; batch: string };
  s.db.query("INSERT INTO tag_evaluations(link_id,tag_id,probability,threshold,tag_version,description,content_version,model,evaluated_at,batch_id) VALUES(?,?,1,0.8,1,'',1,'m','now',?)").run(id, tag, batch);
  s.db.query("INSERT INTO lens_results(link_id,lens_id,answer,lens_version,content_version,model,evaluated_at,batch_id) VALUES(?,?,'{}',1,1,'m','now',?)").run(id, lensId, batch);
  s.db.query("INSERT INTO media_items(link_id,media_key,position,kind,url,ocr_state,updated_at) VALUES(?,'m1',0,'image','https://img.example/1.jpg','done','now')").run(id);
  s.r2.set(`links/${id}/legacy.md`, "old");
  expect(objectsOf(s, id).length).toBeGreaterThan(1);
  for (const table of OWNED) expect([table, count(s, table, id)]).toEqual([table, 1]);
  return id;
}

test("deletes the selected links with everything they own and keeps the rest", async () => {
  const s = await setup();
  const lensId = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Useful?" })).data.lenses[0].id as string;
  const [a, b, keep] = [
    await richLink(s, "https://example.com/a", lensId),
    await richLink(s, "https://example.com/b", lensId),
    await richLink(s, "https://example.com/keep", lensId),
  ];
  const usageBefore = (s.db.query("SELECT count(*) n FROM usage_events").get() as { n: number }).n;

  const res = await bulkDelete(s, [a, b]);
  expect(res.status).toBe(200);
  expect(res.data.deleted.sort()).toEqual([a, b].sort());
  expect(res.data.cancelled).toBe(0);
  expect(res.data.links.map((l: { id: string }) => l.id)).toEqual([keep]);

  for (const id of [a, b]) {
    expect(s.db.query("SELECT 1 FROM links WHERE id=?").get(id)).toBeNull();
    for (const table of OWNED) expect([table, count(s, table, id)]).toEqual([table, 0]);
    expect(objectsOf(s, id)).toEqual([]);
  }
  for (const table of OWNED) expect([table, count(s, table, keep)]).toEqual([table, 1]);
  expect(objectsOf(s, keep).length).toBeGreaterThan(1);
  // Tag definitions and lenses are the owner's taxonomy, not the link's: they stay (ADR 0003).
  expect(res.data.tags.map((t: { name: string }) => t.name)).toEqual(["keep-me"]);
  expect(res.data.lenses.map((l: { id: string }) => l.id)).toEqual([lensId]);
  expect((s.db.query("SELECT count(*) n FROM usage_events").get() as { n: number }).n).toBe(usageBefore);
});

test("a tag left without links is kept", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/only");
  await drain(s);
  await s.api(`/links/${id}`, "PATCH", { tags: ["lonely"] });
  const res = await bulkDelete(s, [id]);
  expect(res.data.links).toEqual([]);
  expect(res.data.tags.map((t: { name: string }) => t.name)).toEqual(["lonely"]);
});

const DELETED = "Cancelled: link deleted";
const jobRow = (s: S, id: string) =>
  s.db.query("SELECT link_id,link_title,status,step,error FROM jobs WHERE id=?").get(id) as Record<string, string | null>;
const activityJob = async (s: S, batchId: string, jobId: string) =>
  ((await s.api(`/batches/${batchId}`)).data.jobs as { id: string; title: string | null; step: string; error: string | null }[]).find((j) => j.id === jobId);
const batchOf = (s: S, jobId: string) => (s.db.query("SELECT batch_id b FROM jobs WHERE id=?").get(jobId) as { b: string }).b;
/** Holds the link's extraction inside its content step; `release` lets it store `markdown`. */
async function runningExtraction(s: S, linkId: string) {
  let release!: (markdown: string) => void;
  fakes.content = { wait: new Promise<string>((r) => (release = r)) };
  const jobId = s.sent.splice(0).map((m) => m.body.id).find((j) => (s.db.query("SELECT link_id FROM jobs WHERE id=?").get(j) as { link_id: string }).link_id === linkId)!;
  const before = fakes.calls.content;
  const run = s.runJob(jobId);
  for (let i = 0; i < 200 && fakes.calls.content === before; i++) await Bun.sleep(1);
  expect(jobRow(s, jobId).status).toBe("running");
  return { jobId, finish: async (markdown: string) => (release(markdown), await run) };
}

test("a queued job is cancelled because its link was deleted, stays in Activity and never runs", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/queued");
  const { title } = s.db.query("SELECT title FROM links WHERE id=?").get(id) as { title: string };
  const job = s.db.query("SELECT id FROM jobs WHERE link_id=?").get(id) as { id: string };
  const res = await bulkDelete(s, [id]);
  expect(res.data.deleted).toEqual([id]);
  expect(jobRow(s, job.id)).toEqual({ link_id: null, link_title: title, status: "failed", step: "Cancelled", error: DELETED });
  expect(await activityJob(s, batchOf(s, job.id), job.id)).toMatchObject({ title, step: "Cancelled", error: DELETED });
  expect(res.data.batches.find((b: { id: string }) => b.id === batchOf(s, job.id))).toMatchObject({ cancelled: 1, active: 0 });
  const before = fakes.calls.content;
  await drain(s);
  expect(fakes.calls.content).toBe(before);
  expect(objectsOf(s, id)).toEqual([]);
  expect(s.db.query("SELECT 1 FROM links WHERE id=?").get(id)).toBeNull();
});

test("a finished job keeps its row and its link's title in Activity", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/done");
  await drain(s);
  const job = s.db.query("SELECT id,status FROM jobs WHERE link_id=?").get(id) as { id: string; status: string };
  expect(job.status).toBe("done");
  await bulkDelete(s, [id]);
  expect(jobRow(s, job.id)).toMatchObject({ link_id: null, status: "done", error: null });
  expect((await activityJob(s, batchOf(s, job.id), job.id))?.title).toBeTruthy();
});

test("a running extraction is stopped and cancelled, and its link is deleted anyway", async () => {
  const s = await setup();
  const running = await save(s, "https://example.com/running");
  const idle = await save(s, "https://example.com/idle");
  const { jobId, finish } = await runningExtraction(s, running);

  const res = await bulkDelete(s, [running, idle]);
  expect(res.status).toBe(200);
  expect(res.data.deleted.sort()).toEqual([running, idle].sort());
  expect(res.data.cancelled).toBe(2);
  expect(res.data.links).toEqual([]);
  expect(s.workflows.terminated).toEqual([jobId]);
  expect(jobRow(s, jobId)).toMatchObject({ link_id: null, status: "failed", step: "Cancelled", error: DELETED });

  await finish("# finished");
  expect(objectsOf(s, running)).toEqual([]);
  expect(jobRow(s, jobId)).toMatchObject({ status: "failed", step: "Cancelled", error: DELETED });
});

test("a workflow that keeps running after its link was deleted stores nothing", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/late");
  const { jobId, finish } = await runningExtraction(s, id);
  // A terminate that came too late: the workflow carries on.
  s.workflows.terminate = "ignore";
  expect((await bulkDelete(s, [id])).data.deleted).toEqual([id]);
  await finish("# late");
  expect(objectsOf(s, id)).toEqual([]);
  expect(jobRow(s, jobId)).toMatchObject({ status: "failed", error: DELETED });
});

test("a workflow that can't be stopped doesn't block the delete", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/stuck");
  const { jobId, finish } = await runningExtraction(s, id);
  s.workflows.terminate = "throw";
  expect((await bulkDelete(s, [id])).data.deleted).toEqual([id]);
  await finish("# late");
  expect(objectsOf(s, id)).toEqual([]);
  expect(jobRow(s, jobId)).toMatchObject({ status: "failed", error: DELETED });
});

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));
for (const kind of ["autotag", "lens"] as const) {
  test(`a running ${kind} job is cancelled with its link: its answer is discarded and nothing is written`, async () => {
    const s = await setup({ placeholder: true });
    const id = await save(s, "https://example.com/jev");
    await drain(s);
    await s.api("/tags", "POST", { name: "topic" });
    const lens = kind === "lens" ? (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Useful?" })).data.lenses[0].id : undefined;
    Object.assign(s.env as unknown as Record<string, unknown>, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
    let reply!: () => void;
    const replied = new Promise<void>((r) => (reply = r));
    let calls = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls++;
      const questions = JSON.parse(String(init?.body)).questions as Record<string, unknown>;
      await replied;
      return Response.json({ model: "jev-test", answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100, output_tokens: 5 } });
    }) as typeof fetch;
    await s.api("/batches", "POST", { kind, ids: [id], lensId: lens });
    const jobId = s.jevSent.splice(0)[0]!.body.id;
    const run = s.runJob(jobId);
    for (let i = 0; i < 200 && !calls; i++) await Bun.sleep(1);
    expect(calls).toBe(1);

    expect((await bulkDelete(s, [id])).data.deleted).toEqual([id]);
    expect(jobRow(s, jobId)).toMatchObject({ status: "failed", step: "Cancelled", error: `${DELETED}. Jev was already called (may have been billed).` });
    // Usage keeps the call (it may be billed) as soon as the delete lands.
    expect(s.db.query("SELECT status FROM usage_events WHERE service='jev'").all()).toEqual([{ status: "failed" }]);
    reply();
    await run;
    for (const table of ["tag_evaluations", "link_tags", "lens_results"])
      expect([table, (s.db.query(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]).toEqual([table, 0]);
    expect(s.db.query("SELECT count(*) n FROM usage_events WHERE service='jev'").get()).toEqual({ n: 1 });
    expect(jobRow(s, jobId).step).toBe("Cancelled");
  });
}

test("the Inspector's single delete cancels a running job the same way", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/single");
  const { jobId, finish } = await runningExtraction(s, id);
  const res = await s.api(`/links/${id}`, "DELETE");
  expect(res.status).toBe(200);
  expect(res.data).toMatchObject({ links: [], cancelled: 1 });
  expect(jobRow(s, jobId)).toMatchObject({ link_id: null, status: "failed", error: DELETED });
  await finish("# late");
  expect(objectsOf(s, id)).toEqual([]);
  expect((await s.api(`/links/${id}`, "DELETE")).status).toBe(404);
});

test("a job waiting on the deleted link's extraction is cancelled too and never starts", async () => {
  const s = await setup({ placeholder: true });
  Object.assign(s.env as unknown as Record<string, unknown>, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  await s.api("/tags", "POST", { name: "topic" });
  const id = await save(s, "https://example.com/waits");
  const { jobId, finish } = await runningExtraction(s, id);
  const tag = (await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.batchId as string;
  const waiting = (s.db.query("SELECT id,status FROM jobs WHERE batch_id=?").get(tag)) as { id: string; status: string };
  expect(waiting.status).toBe("waiting");
  const res = await bulkDelete(s, [id]);
  expect(res.data.cancelled).toBe(2);
  for (const j of [jobId, waiting.id]) expect(jobRow(s, j)).toMatchObject({ link_id: null, status: "failed", step: "Cancelled", error: DELETED });
  await finish("# late");
  await drain(s);
  expect(s.jevSent).toEqual([]);
  expect(jobRow(s, waiting.id).step).toBe("Cancelled");
  expect(res.data.batches.find((b: { id: string }) => b.id === tag)).toMatchObject({ cancelled: 1, active: 0, failed: 0 });
});

test("a job that failed before its link was deleted still counts as failed, but there is nothing to retry", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/failed");
  await drain(s);
  const { batch } = s.db.query("SELECT batch_id batch FROM jobs WHERE link_id=?").get(id) as { batch: string };
  s.db.query("UPDATE jobs SET status='failed',step='Extracting content',error='Boom' WHERE link_id=?").run(id);
  const before = (await s.api("/library")).data.batches.find((b: { id: string }) => b.id === batch);
  expect(before).toMatchObject({ failed: 1, retryable_failed: 1 });
  const res = await bulkDelete(s, [id]);
  expect(res.data.cancelled).toBe(0);
  expect(res.data.batches.find((b: { id: string }) => b.id === batch)).toMatchObject({ failed: 1, retryable_failed: 0 });
});

test("rejects a malformed selection", async () => {
  const s = await setup();
  for (const ids of [undefined, [], "x", [1], Array.from({ length: 101 }, (_, i) => `id${i}`)])
    expect((await bulkDelete(s, ids)).status).toBe(400);
});

test("unknown ids are ignored and duplicates count once", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/dup");
  await drain(s);
  const res = await bulkDelete(s, [id, id, "missing"]);
  expect(res.data.deleted).toEqual([id]);
});
