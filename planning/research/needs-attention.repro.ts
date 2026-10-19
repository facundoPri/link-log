// Authenticated FAC48 repro against the real router, workflow and all migrations.
// Disposable SQLite and fake network providers; hosted behavior is verified separately.
import { expect, test, afterEach } from "bun:test";
import { setup as authenticatedSetup, fakes, tick, resetClock, dispatch } from "../../tests/worker-harness";
const setup = () => authenticatedSetup({ placeholder: true });
afterEach(resetClock);
const log: string[] = [];
const rec = (scenario: string, event: string, v: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["view"]>>) =>
  log.push(`${scenario} | ${event} | status=${v.status} processing=${v.processing} content=${v.content} attention=${v.attention} job=${v.job}${v.err ? ` err="${v.err}"` : ""}`);

test("A: queued >30s behind the browser pool stays processing, never Needs attention (fixed in FAC-48 S1)", async () => {
  const s = await setup();
  const { data } = await s.api("/links", "POST", { url: "https://a.example/post" });
  const id = data.id;
  rec("A", "saved", await s.view(id));
  expect((await s.view(id)).attention).toBe(false);
  tick(31_000); // still waiting for a browser slot; nothing ran
  const waiting = await s.view(id);
  rec("A", "+31s reload, job not started", waiting);
  expect(waiting).toMatchObject({ status: "pending", processing: true, content: "queued", attention: false });
  await s.runQueued();
  const done = await s.view(id);
  rec("A", "workflow ran OK", done);
  expect(done).toMatchObject({ status: "ready", content: "ready", attention: false });
});

test("B: a fail-fast preview (403 bot wall, PDF) + successful content enters Needs attention once settled, with its reason; it stays until the preview works (FAC-48 S4)", async () => {
  const s = await setup();
  fakes.meta = { status: "failed" }; // 403 bot wall: fails fast, no retries (FAC-48 S3)
  const id = (await s.api("/links", "POST", { url: "https://b.example/doc.pdf" })).data.id;
  await s.runQueued();
  const v1 = await s.view(id);
  rec("B", "extract OK, preview non-OK", v1);
  expect(v1).toMatchObject({ status: "failed", content: "ready", attention: true, job: "done/Done" });
  expect(s.db.query("SELECT preview_reason,attention_kind,attention_reason FROM links WHERE id=?").get(id)).toEqual({ preview_reason: "blocked", attention_kind: "preview", attention_reason: "blocked" });
  const r = await s.api(`/links/${id}/retry`, "POST");
  expect(r.status).toBe(200);
  const queued = await s.view(id);
  rec("B", "Retry preview → queued job", queued);
  expect(queued).toMatchObject({ processing: true, attention: true }); // stays in the list, shown as processing
  await s.runQueued();
  const v2 = await s.view(id);
  rec("B", "Retry preview (same site response)", v2);
  expect(v2.attention).toBe(true);
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  const v3 = await s.view(id);
  rec("B", "manual paste of content", v3);
  expect(v3.attention).toBe(true);
  fakes.meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  const v4 = await s.view(id);
  rec("B", "Retry preview after site answers 200", v4);
  expect(v4.attention).toBe(false);
});

test("C: re-extract of a healthy link keeps its previous preview when only the preview fetch fails (fixed in FAC-48 S3)", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://c.example/x" })).data.id;
  await s.runQueued();
  rec("C", "first extract OK", await s.view(id));
  fakes.meta = { status: "failed" }; // the preview GET now fails (after retries, or fail-fast)
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  const v = await s.view(id);
  rec("C", "re-extract, preview fails, content OK", v);
  expect(v).toMatchObject({ status: "ready", content: "ready", attention: false, job: "done/Done" });
  // The failure is only recorded in Activity.
  expect((s.db.query("SELECT preview_reason FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as any).preview_reason).toBe("blocked");
  fakes.meta = { status: "ready" };
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  const v2 = await s.view(id);
  rec("C", "re-extract again, preview OK", v2);
  expect(v2.attention).toBe(false);
});

test("D: content failure without prior content stays in Needs attention through Retry (no flicker) until success (FAC-48 S4)", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 503" };
  const id = (await s.api("/links", "POST", { url: "https://d.example/x" })).data.id;
  await s.runQueued();
  const v1 = await s.view(id);
  rec("D", "extract fails", v1);
  expect(v1).toMatchObject({ status: "ready", content: "failed", attention: true, job: "failed/Needs attention" });
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  const q = await s.view(id);
  rec("D", "Retry → enqueued (not run yet)", q);
  expect(q).toMatchObject({ processing: true, attention: true });
  await s.runQueued();
  const v2 = await s.view(id);
  rec("D", "retry fails again", v2);
  expect(v2.attention).toBe(true);
  fakes.content = { markdown: "# ok" };
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  await s.runQueued();
  const v3 = await s.view(id);
  rec("D", "retry succeeds", v3);
  expect(v3).toMatchObject({ content: "ready", attention: false, err: null });
});

test("E: the same content failure on a link that already had content never shows Needs attention", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://e.example/x" })).data.id;
  await s.runQueued();
  fakes.content = { throws: "Markdown: HTTP 503" };
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  const v = await s.view(id);
  rec("E", "re-extract fails, prior content kept", v);
  expect(v).toMatchObject({ content: "ready", attention: false, job: "failed/Needs attention", err: "The site had a problem." }); // plain reason since FAC-48 S3
});

test("F: cancelling a fresh import leaves links pending and neutral, never Needs attention (fixed in FAC-48 S1)", async () => {
  const s = await setup();
  const imp = await s.api("/import", "POST", { urls: ["https://f.example/1", "https://f.example/2"] });
  const batchId = imp.data.batches[0].id;
  const id = imp.data.links[0].id;
  s.sent.splice(0); // queue not yet consumed
  await s.api(`/batches/${batchId}`, "DELETE");
  rec("F", "batch cancelled", await s.view(id));
  tick(31_000);
  const v = await s.view(id);
  rec("F", "+31s reload", v);
  expect(v).toMatchObject({ status: "pending", processing: false, content: "missing", attention: false });
  await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  const v2 = await s.view(id);
  rec("F", "Fetch preview", v2);
  expect(v2).toMatchObject({ status: "ready", attention: false });
});

test("G: preview keeps throwing → retried, then only the preview fails; content is still extracted (FAC-48 S3)", async () => {
  const s = await setup();
  fakes.meta = { throws: "DNS unavailable" };
  const id = (await s.api("/links", "POST", { url: "https://g.example/x" })).data.id;
  await s.runQueued();
  const v1 = await s.view(id);
  rec("G", "resolve-and-preview throws (3 attempts)", v1);
  expect(v1).toMatchObject({ status: "failed", content: "ready", attention: true, err: null, job: "done/Done" });
  expect((s.db.query("SELECT preview_reason FROM links WHERE id=?").get(id) as any).preview_reason).toBe("unreachable");
  fakes.meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  const v2 = await s.view(id);
  rec("G", "Retry preview succeeds", v2);
  expect(v2).toMatchObject({ status: "ready", content: "ready", attention: false });
});

test("H: an interrupted workflow (dispatch sees errored instance) leaves the link neutral (fixed in FAC-48 S1)", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://h.example/x" })).data.id;
  const [msg] = s.sent.splice(0);
  const env = s.env as any;
  env.PROCESS_LINK = {
    create: async () => { throw new Error("instance already exists"); },
    get: async () => ({ status: async () => ({ status: "errored" }) }),
  };
  await dispatch({ messages: [{ body: msg!.body, ack() {}, retry() {} }] } as never, s.env);
  const v1 = await s.view(id);
  rec("H", "dispatch: instance errored", v1);
  expect(v1).toMatchObject({ status: "pending", processing: false, content: "missing", attention: false, job: "failed/Interrupted" });
  tick(31_000);
  const v2 = await s.view(id);
  rec("H", "+31s reload", v2);
  expect(v2.attention).toBe(false);
});

test("I: while queued, the link is processing so the row no longer offers 'Retry preview'; the API still refuses it (FAC-48 S1)", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://i.example/x" })).data.id;
  tick(31_000);
  const v = await s.view(id);
  rec("I", "+31s, still queued", v);
  expect(v).toMatchObject({ status: "pending", processing: true }); // canRetryPreview (src/attention.ts) is false
  const r = await s.api(`/links/${id}/retry`, "POST");
  log.push(`I | POST /retry while queued | HTTP ${r.status} "${r.data.error}"`);
  expect(r.status).toBe(400);
});

test("J: without TYPESAFE_API_KEY, autotag is refused up front: no job, workflow or usage row (fixed in FAC-52)", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://j.example/x" })).data.id;
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  const env = s.env as any;
  env.JEV_PROVIDER = "typesafe";
  delete env.TYPESAFE_API_KEY;
  const lib = await s.api("/library");
  log.push(`J | capabilities.jev=${lib.data.capabilities.jev} (UI disables Auto-tag, Lens and Re-evaluate)`);
  expect(lib.data.capabilities.jev).toBe(false);
  const res = await s.api("/batches", "POST", { kind: "autotag", ids: [id] });
  log.push(`J | POST /batches autotag | HTTP ${res.status} "${res.data.error}"`);
  expect(res).toEqual({ status: 400, data: { error: "Jev is not configured: API key missing." } });
  const jobs = s.db.query("SELECT count(*) n FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE b.kind='autotag'").get() as any;
  const usage = s.db.query("SELECT service,status,error FROM usage_events WHERE service='jev'").all();
  log.push(`J | autotag jobs=${jobs.n} | usage_events=${JSON.stringify(usage)} | queued messages=${s.sent.length}`);
  expect(jobs.n).toBe(0);
  expect(usage).toHaveLength(0);
  expect(s.sent).toHaveLength(0);
  expect((await s.view(id)).attention).toBe(false);
});

test("timeline", () => {
  console.log("\n" + log.join("\n"));
});
