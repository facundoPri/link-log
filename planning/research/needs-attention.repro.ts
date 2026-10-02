// FAC-48 isolated repro: drives the real Worker fetch handler, LinkWorkflow and dispatch
// against in-memory SQLite (all migrations), with network-facing modules mocked.
// Not part of `bun test` (name does not match *.test.ts). Run explicitly:
//   bun test ./planning/research/needs-attention.repro.ts
// Nothing is deployed and no local D1/R2 state is read or written.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { expect, mock, setSystemTime, test, afterEach } from "bun:test";
import { responseFailure } from "../../worker/failures";

type Meta = { status: "ready" | "failed" } | { throws: string };
let meta: Meta = { status: "ready" };
let content: { markdown: string } | { throws: string } = { markdown: "# page" };

mock.module("../../worker/metadata", () => ({
  validateDestination: async () => {},
  publicAddress: () => true,
  extractMetadata: async (url: string) => {
    if ("throws" in meta) throw new Error(meta.throws);
    // Since FAC-48 S3 a non-OK or non-HTML answer throws a classified failure (here the 403 bot wall).
    if (meta.status === "failed") throw responseFailure(new Response(null, { status: 403, headers: { "content-type": "text/html" } }))!;
    const domain = new URL(url).hostname;
    return { url, domain, title: `Title of ${domain}`, description: "", image: null, favicon: null, status: meta.status };
  },
}));
mock.module("../../worker/adapters", () => ({
  adapterFor: () => ({
    extract: async () => {
      if ("throws" in content) throw new Error(content.throws);
      return { markdown: content.markdown, source: "web" };
    },
  }),
}));

const { default: worker, LinkWorkflow } = await import("../../worker/index");
const { dispatch } = await import("../../worker/jobs");
const { needsAttention } = await import("../../src/attention");

function d1(db: Database) {
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: db.query(sql).all(...(params as never[])) }),
    first: async () => db.query(sql).get(...(params as never[])) ?? null,
    run: async () => ({ meta: { changes: db.query(sql).run(...(params as never[])).changes } }),
    _exec: () => db.query(sql).run(...(params as never[])),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { _exec: () => { changes: number } }[]) =>
      db.transaction(() => list.map((s) => ({ meta: { changes: s._exec().changes } })))(),
  };
}

let clock = Date.parse("2026-09-29T12:00:00.000Z");
const tick = (ms: number) => setSystemTime(new Date((clock += ms)));
afterEach(() => setSystemTime());

async function setup() {
  tick(0);
  meta = { status: "ready" };
  content = { markdown: "# page" };
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(await Bun.file(`migrations/${f}`).text());
  const r2 = new Map<string, string>();
  const sent: { body: { id: string } }[] = [];
  const env = {
    DB: d1(db),
    CONTENT: {
      put: async (k: string, v: string) => void r2.set(k, v),
      get: async (k: string) => (r2.has(k) ? { text: async () => r2.get(k)! } : null),
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => {},
    },
    JOBS: { sendBatch: async (m: { body: { id: string } }[]) => void sent.push(...m) },
    JEV_PROVIDER: "fixture",
  } as unknown as Env;
  const api = async (path: string, method = "GET", body?: unknown) => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      }) as never,
      env,
      { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never,
    );
    await Promise.all(waits);
    return { status: res.status, data: (await res.json()) as any };
  };
  // Minimal Workflow step: runs callbacks inline with ctx.attempt (1-based), honouring an explicit retry limit.
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === "function" ? a : b) as (ctx: unknown) => Promise<unknown>;
      const config = typeof a === "object" ? (a as any) : {};
      const limit = config.retries?.limit ?? 0;
      for (let i = 0; ; i++) {
        try { return await fn({ step: { name, count: 1 }, attempt: i + 1, config }); }
        catch (e) { if (i >= limit || (e as Error)?.name === "NonRetryableError") throw e; }
      }
    },
    sleep: async () => {},
  };
  const runJob = async (jobId: string) => {
    const wf = new (LinkWorkflow as any)();
    wf.env = env;
    try { await wf.run({ payload: { id: jobId } }, step); } catch { /* record-failure already ran */ }
  };
  const runQueued = async () => {
    const ids = sent.splice(0).map((m) => m.body.id);
    for (const id of ids) await runJob(id);
  };
  // What the UI sees after a reload: GET /api/library, then Sidebar/App predicate.
  const view = async (id: string) => {
    const lib = (await api("/library")).data;
    const l = lib.links.find((x: any) => x.id === id);
    const job = db.query("SELECT status,step,error FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as any;
    return {
      status: l.status as string,
      content: l.content_state as string,
      processing: l.processing as boolean,
      attention: needsAttention(l), // shared by Sidebar and App
      err: l.content_error as string | null,
      job: job ? `${job.status}/${job.step}` : null,
    };
  };
  return { db, env, api, runQueued, runJob, view, sent };
}

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

test("B: a fail-fast preview (403 bot wall, PDF) + successful content stays in Needs attention with its reason; Retry preview repeats it (attention model: S4)", async () => {
  const s = await setup();
  meta = { status: "failed" }; // 403 bot wall: fails fast, no retries (FAC-48 S3)
  const id = (await s.api("/links", "POST", { url: "https://b.example/doc.pdf" })).data.id;
  await s.runQueued();
  const v1 = await s.view(id);
  rec("B", "extract OK, preview non-OK", v1);
  expect(v1).toMatchObject({ status: "failed", content: "ready", attention: true, job: "done/Done" });
  expect((s.db.query("SELECT preview_reason FROM links WHERE id=?").get(id) as any).preview_reason).toBe("blocked");
  const r = await s.api(`/links/${id}/retry`, "POST");
  expect(r.status).toBe(200);
  const v2 = await s.view(id);
  rec("B", "Retry preview (same site response)", v2);
  expect(v2.attention).toBe(true);
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  const v3 = await s.view(id);
  rec("B", "manual paste of content", v3);
  expect(v3.attention).toBe(true);
  meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
  const v4 = await s.view(id);
  rec("B", "Retry preview after site answers 200", v4);
  expect(v4.attention).toBe(false);
});

test("C: re-extract of a healthy link keeps its previous preview when only the preview fetch fails (fixed in FAC-48 S3)", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://c.example/x" })).data.id;
  await s.runQueued();
  rec("C", "first extract OK", await s.view(id));
  meta = { status: "failed" }; // the preview GET now fails (after retries, or fail-fast)
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  const v = await s.view(id);
  rec("C", "re-extract, preview fails, content OK", v);
  expect(v).toMatchObject({ status: "ready", content: "ready", attention: false, job: "done/Done" });
  // The failure is only recorded in Activity.
  expect((s.db.query("SELECT preview_reason FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as any).preview_reason).toBe("blocked");
  meta = { status: "ready" };
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  const v2 = await s.view(id);
  rec("C", "re-extract again, preview OK", v2);
  expect(v2.attention).toBe(false);
});

test("D: content failure without prior content toggles attention on every retry until success", async () => {
  const s = await setup();
  content = { throws: "Markdown: HTTP 503" };
  const id = (await s.api("/links", "POST", { url: "https://d.example/x" })).data.id;
  await s.runQueued();
  const v1 = await s.view(id);
  rec("D", "extract fails", v1);
  expect(v1).toMatchObject({ status: "ready", content: "failed", attention: true, job: "failed/Needs attention" });
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  const q = await s.view(id);
  rec("D", "Retry → enqueued (not run yet)", q);
  expect(q.attention).toBe(false);
  await s.runQueued();
  const v2 = await s.view(id);
  rec("D", "retry fails again", v2);
  expect(v2.attention).toBe(true);
  content = { markdown: "# ok" };
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  const v3 = await s.view(id);
  rec("D", "retry succeeds", v3);
  expect(v3).toMatchObject({ content: "ready", attention: false, err: null });
});

test("E: the same content failure on a link that already had content never shows Needs attention", async () => {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://e.example/x" })).data.id;
  await s.runQueued();
  content = { throws: "Markdown: HTTP 503" };
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
  const v2 = await s.view(id);
  rec("F", "Fetch preview", v2);
  expect(v2).toMatchObject({ status: "ready", attention: false });
});

test("G: preview keeps throwing → retried, then only the preview fails; content is still extracted (FAC-48 S3)", async () => {
  const s = await setup();
  meta = { throws: "DNS unavailable" };
  const id = (await s.api("/links", "POST", { url: "https://g.example/x" })).data.id;
  await s.runQueued();
  const v1 = await s.view(id);
  rec("G", "resolve-and-preview throws (3 attempts)", v1);
  expect(v1).toMatchObject({ status: "failed", content: "ready", attention: true, err: null, job: "done/Done" });
  expect((s.db.query("SELECT preview_reason FROM links WHERE id=?").get(id) as any).preview_reason).toBe("unreachable");
  meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
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
