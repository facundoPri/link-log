// FAC-48 regression tests for repro scenarios A, F, H and I
// (planning/research/needs-attention.repro.ts): a pending preview is processing or neutral, never failed.
import { afterEach, expect, test } from "bun:test";
import { canRetryPreview } from "../src/attention";
import { dispatch, fakes, resetClock, setup, tick } from "./worker-harness";

afterEach(resetClock);

test("A: a link queued for more than 30s stays processing and never enters Needs attention", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://a.example/post" })).data.id;
  expect(await s.view(id)).toMatchObject({ status: "pending", content: "queued", processing: true, attention: false });
  tick(31_000);
  expect(await s.view(id)).toMatchObject({ status: "pending", content: "queued", processing: true, attention: false });
  s.db.query("UPDATE jobs SET status='running' WHERE link_id=?").run(id);
  tick(5 * 60_000);
  expect(await s.view(id)).toMatchObject({ status: "pending", processing: true, attention: false });
  s.db.query("UPDATE jobs SET status='queued' WHERE link_id=?").run(id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", processing: false, attention: false, job: "done/Done" });
});

test("F: cancelling a batch before it runs leaves the link neutral, not in Needs attention", async () => {
  const s = await setup();
  const imp = await s.api("/import", "POST", { urls: ["https://f.example/1", "https://f.example/2"] });
  const batchId = imp.data.batches[0].id;
  const ids: string[] = imp.data.links.map((l: { id: string }) => l.id);
  s.sent.splice(0);
  expect((await s.api(`/batches/${batchId}`, "DELETE")).data.cancelled).toBe(2);
  for (const id of ids)
    expect(await s.view(id)).toMatchObject({ status: "pending", content: "missing", processing: false, attention: false, err: null, job: "failed/Cancelled" });
  tick(31_000);
  expect(await s.view(ids[0]!)).toMatchObject({ status: "pending", content: "missing", processing: false, attention: false });
  await s.api(`/links/${ids[0]}/retry`, "POST");
  expect(await s.view(ids[0]!)).toMatchObject({ status: "ready", content: "missing", attention: false });
});

test("F: cancelling a re-extract keeps the previous content and preview", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://f.example/kept" })).data.id;
  await s.runQueued();
  const batchId = (await s.api("/batches", "POST", { kind: "extract", ids: [id] })).data.batchId;
  s.sent.splice(0);
  await s.api(`/batches/${batchId}`, "DELETE");
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", processing: false, attention: false, err: null });
});

test("H: an interrupted workflow leaves the link neutral, not in Needs attention", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://h.example/x" })).data.id;
  const [msg] = s.sent.splice(0);
  (s.env as any).PROCESS_LINK = {
    create: async () => { throw new Error("instance already exists"); },
    get: async () => ({ status: async () => ({ status: "errored" }) }),
  };
  await dispatch({ messages: [{ body: msg!.body, ack() {}, retry() {} }] } as never, s.env);
  expect(await s.view(id)).toMatchObject({ status: "pending", content: "missing", processing: false, attention: false, err: null, job: "failed/Interrupted" });
  tick(31_000);
  expect(await s.view(id)).toMatchObject({ status: "pending", processing: false, attention: false });
});

test("H: an interrupted re-extract keeps the previous content and records why", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://h.example/kept" })).data.id;
  await s.runQueued();
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  const [msg] = s.sent.splice(0);
  (s.env as any).PROCESS_LINK = {
    create: async () => { throw new Error("instance already exists"); },
    get: async () => ({ status: async () => ({ status: "terminated" }) }),
  };
  await dispatch({ messages: [{ body: msg!.body, ack() {}, retry() {} }] } as never, s.env);
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, err: "Extraction was interrupted. Try again.", job: "failed/Interrupted" });
});

test("I: while queued, the preview retry is not offered and the API still refuses it", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://i.example/x" })).data.id;
  tick(31_000);
  const link = (await s.api("/library")).data.links.find((l: { id: string }) => l.id === id);
  expect(link).toMatchObject({ status: "pending", processing: true, previewing: true });
  expect(canRetryPreview(link)).toBe(false);
  const r = await s.api(`/links/${id}/retry`, "POST");
  expect(r.status).toBe(400);
  expect(r.data.error).toBe("Wait for the running job to finish.");
});

test("I: a neutral link offers the preview retry; an orphaned retry turns neutral, never failed", async () => {
  const s = await setup();
  fakes.meta = { status: "ready" };
  const id = (await s.api("/links", "POST", { url: "https://i.example/orphan" })).data.id;
  s.db.query("UPDATE jobs SET status='failed',step='Cancelled' WHERE link_id=?").run(id);
  s.db.query("UPDATE links SET content_state='missing' WHERE id=?").run(id);
  expect(canRetryPreview((await s.api("/library")).data.links[0])).toBe(true);
  // "Retry preview" runs outside the queue; simulate the Worker dying before it writes a result.
  s.db.query("UPDATE links SET metadata_started_at=? WHERE id=?").run(new Date().toISOString(), id);
  expect(await s.view(id)).toMatchObject({ status: "pending", processing: true, attention: false });
  tick(31_000);
  expect(await s.view(id)).toMatchObject({ status: "pending", processing: false, attention: false });
});

test("I: a failed preview is not offered for retry while a job is active, and is again once it ends", async () => {
  const s = await setup();
  fakes.meta = { status: "failed" };
  const id = (await s.api("/links", "POST", { url: "https://i.example/doc.pdf" })).data.id;
  await s.runQueued();
  const linkOf = async () => (await s.api("/library")).data.links.find((l: { id: string }) => l.id === id);
  expect(canRetryPreview(await linkOf())).toBe(true);
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  const active = await linkOf();
  expect(active).toMatchObject({ status: "failed", processing: true, previewing: false });
  expect(canRetryPreview(active)).toBe(false);
  expect((await s.api(`/links/${id}/retry`, "POST")).status).toBe(400);
  await s.runQueued();
  expect(await linkOf()).toMatchObject({ status: "failed", processing: false });
  expect(canRetryPreview(await linkOf())).toBe(true);
});

test("a pending link busy with a non-extract job is processing but not fetching its preview", async () => {
  const s = await setup();
  (s.env as any).ALLOW_FIXTURE_JEV = "1";
  const imp = await s.api("/import", "POST", { urls: ["https://p.example/1"] });
  const id = imp.data.links[0].id;
  s.sent.splice(0);
  await s.api(`/batches/${imp.data.batches[0].id}`, "DELETE");
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  await s.api("/tags", "POST", { name: "topic" });
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
  expect(await s.view(id)).toMatchObject({ status: "pending", processing: true, previewing: false, attention: false });
});
