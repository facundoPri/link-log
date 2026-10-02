// FAC-48 part 3: persisted Needs attention. Regression tests for repro scenarios A–I with the final rules:
// set only when a step fails for good, kept while its retry runs, cleared by that step's success or Dismiss.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { nextAttention } from "../worker/attention";
import { attentionMessage } from "../src/attention";
import { dispatch, fakes, resetClock, setup, tick } from "./worker-harness";

afterEach(resetClock);

type S = Awaited<ReturnType<typeof setup>>;
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const reextract = (s: S, id: string) => s.api("/batches", "POST", { kind: "extract", ids: [id] });
const linkOf = async (s: S, id: string) => (await s.api("/library")).data.links.find((l: { id: string }) => l.id === id);

test("A: a transient preview and content failure, retried automatically, never shows Needs attention", async () => {
  const s = await setup();
  fakes.meta = [{ http: 503 }, { status: "ready" }];
  fakes.content = [{ throws: "Markdown: HTTP 503" }, { markdown: "# ok" }];
  const id = await save(s, "https://a.example/post");
  tick(31_000);
  const seen: boolean[] = [(await s.view(id)).attention];
  fakes.onMeta = async () => void seen.push((await s.view(id)).attention);
  fakes.onContent = async () => void seen.push((await s.view(id)).attention);
  await s.runQueued();
  expect(fakes.calls).toMatchObject({ meta: 2, content: 2 });
  expect(seen).toEqual([false, false, false, false, false]);
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, attention_kind: null });
});

test("B: a final preview failure enters with its reason only once the job settles; Retry keeps it until the preview works", async () => {
  const s = await setup();
  fakes.meta = { status: "failed" };
  const id = await save(s, "https://b.example/page");
  let during: unknown;
  fakes.onContent = async () => void (during = await s.view(id));
  await s.runQueued();
  expect(during).toMatchObject({ status: "failed", processing: true, attention: false });
  const settled = await s.view(id);
  expect(settled).toMatchObject({ status: "failed", content: "ready", attention: true, attention_kind: "preview", attention_reason: "blocked", job: "done/Done" });
  expect(attentionMessage(await linkOf(s, id))).toBe("Couldn't get the preview: The site blocks automated access.");
  expect(await s.view(id)).toEqual(settled); // identical after a reload

  // Retry runs only the preview, as a queued job; the link stays in the list while it is processing.
  const retry = await s.api(`/links/${id}/retry`, "POST");
  expect(retry.data.batchId).toBeString();
  expect(await s.view(id)).toMatchObject({ processing: true, previewing: true, attention: true, attention_kind: "preview" });
  await s.runQueued();
  expect(fakes.calls).toMatchObject({ meta: 2, content: 1 });
  expect(await s.view(id)).toMatchObject({ status: "failed", attention: true, attention_reason: "blocked", job: "failed/Needs attention" });

  // Pasting content doesn't fix the preview.
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  expect((await s.view(id)).attention_kind).toBe("preview");

  fakes.meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", preview_reason: null, attention: false, attention_kind: null, job: "done/Done" });
});

test("C: a re-extract whose preview fails keeps the previous preview and stays out of Needs attention", async () => {
  const s = await setup();
  const id = await save(s, "https://c.example/x");
  await s.runQueued();
  fakes.meta = { status: "failed" };
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, job: "done/Done" });
});

test("D: Retry of failed content keeps the link in Needs attention while it runs, re-runs only the content, and clears on success", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 503" };
  const id = await save(s, "https://d.example/x");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "failed", attention: true, attention_kind: "content", attention_reason: "site_error" });
  expect(attentionMessage(await linkOf(s, id))).toBe("Couldn't get the content: The site had a problem.");

  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  expect(await s.view(id)).toMatchObject({ content: "queued", processing: true, attention: true, attention_kind: "content" }); // no flicker
  const meta = fakes.calls.meta;
  await s.runQueued();
  expect(fakes.calls.meta).toBe(meta); // the preview did not run again
  expect(await s.view(id)).toMatchObject({ content: "failed", processing: false, attention: true, attention_kind: "content", job: "failed/Needs attention" });

  fakes.content = { markdown: "# ok" };
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  await s.runQueued();
  expect(fakes.calls.meta).toBe(meta);
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", err: null, attention: false, attention_kind: null, job: "done/Done" });
});

test("E: a failed re-extract with previous content stays out of Needs attention", async () => {
  const s = await setup();
  const id = await save(s, "https://e.example/x");
  await s.runQueued();
  fakes.content = { throws: "Markdown: HTTP 503" };
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", attention: false, attention_kind: null, err: "The site had a problem.", job: "failed/Needs attention" });
});

test("F: cancelling a retry leaves Needs attention as it was; cancelling a fresh import adds nothing", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://f.example/x");
  await s.runQueued();
  const before = await s.view(id);
  expect(before).toMatchObject({ content: "failed", attention_kind: "content", attention_reason: "not_found" });
  const { batchId } = (await s.api(`/links/${id}/retry`, "POST", { step: "content" })).data;
  s.sent.splice(0);
  await s.api(`/batches/${batchId}`, "DELETE");
  expect(await s.view(id)).toMatchObject({ content: "failed", processing: false, attention: true, attention_kind: "content", attention_reason: "not_found", job: "failed/Cancelled" });

  tick(1_000);
  const imp = await s.api("/import", "POST", { urls: ["https://f.example/new"] });
  s.sent.splice(0);
  await s.api(`/batches/${imp.data.batches[0].id}`, "DELETE");
  tick(31_000);
  const fresh = imp.data.links.find((l: { original_url: string }) => l.original_url === "https://f.example/new").id;
  expect(await s.view(fresh)).toMatchObject({ status: "pending", content: "missing", attention: false });
});

test("G: a preview that keeps failing after its retries enters as unreachable; a later Retry preview that works clears it", async () => {
  const s = await setup();
  fakes.meta = { throws: "DNS unavailable" };
  const id = await save(s, "https://g.example/x");
  await s.runQueued();
  expect(fakes.calls.meta).toBe(3);
  expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", attention_kind: "preview", attention_reason: "unreachable" });
  fakes.meta = [{ throws: "DNS unavailable" }, { status: "ready" }];
  await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", attention: false, job: "done/Done" });
});

test("H: an interrupted job never raises Needs attention, and an interrupted retry keeps it", async () => {
  const s = await setup();
  const interrupted = async () => {
    const [msg] = s.sent.splice(0);
    (s.env as any).PROCESS_LINK = {
      create: async () => { throw new Error("instance already exists"); },
      get: async () => ({ status: async () => ({ status: "errored" }) }),
    };
    await dispatch({ messages: [{ body: msg!.body, ack() {}, retry() {} }] } as never, s.env);
  };
  const fresh = await save(s, "https://h.example/fresh");
  await interrupted();
  expect(await s.view(fresh)).toMatchObject({ content: "missing", attention: false, job: "failed/Interrupted" });

  fakes.content = { throws: "Markdown: HTTP 403" };
  const failed = await save(s, "https://h.example/failed");
  await s.runQueued();
  await s.api(`/links/${failed}/retry`, "POST", { step: "content" });
  await interrupted();
  expect(await s.view(failed)).toMatchObject({ processing: false, attention: true, attention_kind: "content", attention_reason: "blocked", job: "failed/Interrupted" });
  // Still recoverable through the same Retry.
  fakes.content = { markdown: "# ok" };
  await s.api(`/links/${failed}/retry`, "POST", { step: "content" });
  await s.runQueued();
  expect(await s.view(failed)).toMatchObject({ content: "ready", attention: false });
});

test("I: Retry is refused while a job is active (the guard stays) and offered again afterwards", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://i.example/x");
  expect((await s.api(`/links/${id}/retry`, "POST", { step: "content" })).status).toBe(400);
  await s.runQueued();
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  const again = await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  expect(again).toMatchObject({ status: 400, data: { error: "Wait for the running job to finish." } });
  expect(s.db.query("SELECT count(*) n FROM jobs WHERE link_id=? AND status IN ('queued','running')").get(id)).toEqual({ n: 1 });
});

test("Dismiss removes the link from Needs attention and keeps its data; a later final failure brings it back", async () => {
  const s = await setup();
  fakes.meta = { status: "failed" };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://dismiss.example/x");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ attention_kind: "content" });
  await s.api(`/links/${id}/dismiss`, "POST");
  const dismissed = await s.view(id);
  expect(dismissed).toMatchObject({ status: "failed", content: "failed", preview_reason: "blocked", content_reason: "not_found", attention: false, attention_kind: null });
  expect((await s.api("/library")).data.links.filter((l: { attention_kind: string | null }) => l.attention_kind)).toHaveLength(0);
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ attention: true, attention_kind: "content", attention_reason: "not_found" });
});

test("when both steps failed, content comes first and the preview takes its place once content recovers", async () => {
  const s = await setup();
  fakes.meta = { http: 404 };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://both.example/x");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ attention_kind: "content", attention_reason: "not_found" });
  fakes.content = { markdown: "# ok" };
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", attention_kind: "preview", attention_reason: "not_found" });
});

test("pasting content resolves a content failure", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://paste.example/x");
  await s.runQueued();
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  expect(await s.view(id)).toMatchObject({ content: "ready", attention: false, attention_kind: null });
});

test("reprocessing gives the same result: the same final failure leaves the same attention", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://again.example/x");
  await s.runQueued();
  const first = await s.view(id);
  for (let i = 0; i < 2; i++) {
    await reextract(s, id);
    await s.runQueued();
    expect(await s.view(id)).toEqual(first);
  }
});

test("nextAttention: final failures raise, masked failures and other steps leave it, the same step's success clears", () => {
  const link = { status: "ready" as const, preview_reason: null, content_key: null, attention_kind: null, attention_reason: null };
  const clear = { attention_kind: null, attention_reason: null };
  expect(nextAttention(link, { content: "failed", content_reason: "timeout" })).toEqual({ attention_kind: "content", attention_reason: "timeout" });
  expect(nextAttention({ ...link, content_key: "k" }, { content: "failed", preview: "ok" })).toEqual(clear);
  expect(nextAttention({ ...link, status: "failed", preview_reason: "blocked" }, { content: "ok", preview: "failed" }))
    .toEqual({ attention_kind: "preview", attention_reason: "blocked" });
  const content = { ...link, attention_kind: "content" as const, attention_reason: "timeout" };
  expect(nextAttention(content, { preview: "ok" })).toEqual({ attention_kind: "content", attention_reason: "timeout" });
  expect(nextAttention(content, { preview: "failed" })).toEqual({ attention_kind: "content", attention_reason: "timeout" });
  expect(nextAttention(content, { content: "ok" })).toEqual(clear);
  const preview = { ...link, status: "failed" as const, preview_reason: "blocked", content_key: "k", attention_kind: "preview" as const, attention_reason: "blocked" };
  expect(nextAttention(preview, { content: "ok" })).toEqual({ attention_kind: "preview", attention_reason: "blocked" });
  expect(nextAttention(preview, { content: "failed" })).toEqual({ attention_kind: "preview", attention_reason: "blocked" });
  expect(nextAttention({ ...preview, status: "ready" }, { preview: "ok" })).toEqual(clear);
});

test("migration 0014 backfills existing failures (no job history) and leaves pending links neutral", async () => {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  const last = files.indexOf("0014_attention.sql");
  for (const f of files.slice(0, last)) db.exec(await Bun.file(`migrations/${f}`).text());
  const insert = db.query("INSERT INTO links(id,original_url,url,domain,title,description,status,content_state,preview_reason,content_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const row = (id: string, status: string, content: string, preview: string | null, reason: string | null) =>
    insert.run(id, `https://${id}.example/`, `https://${id}.example/`, `${id}.example`, id, "", status, content, preview, reason, "2026-09-01T00:00:00.000Z");
  row("content", "ready", "failed", null, "timeout");
  row("both", "failed", "failed", "blocked", "not_found");
  row("preview", "failed", "ready", "not_html", null);
  row("legacy", "failed", "missing", null, null);
  row("pending", "pending", "missing", null, null);
  row("queued", "pending", "queued", null, null);
  row("ok", "ready", "ready", null, null);
  for (const f of files.slice(last)) db.exec(await Bun.file(`migrations/${f}`).text());
  const rows = Object.fromEntries((db.query("SELECT id,attention_kind,attention_reason,attention_at IS NOT NULL dated FROM links").all() as any[])
    .map((r) => [r.id, [r.attention_kind, r.attention_reason, r.dated]]));
  expect(rows).toEqual({
    content: ["content", "timeout", 1],
    both: ["content", "not_found", 1],
    preview: ["preview", "not_html", 1],
    legacy: ["preview", null, 1],
    pending: [null, null, 0],
    queued: [null, null, 0],
    ok: [null, null, 0],
  });
  expect(attentionMessage({ attention_kind: "preview", attention_reason: null })).toBe("Couldn't get the preview: Something went wrong.");
});

// Round 2 (S4 review).

for (const [label, pattern] of [
  ["the terminal job write", /^UPDATE jobs SET status='failed',step='Needs attention'/],
  ["the link's failure and attention write", /^UPDATE links SET content_state=.*attention_kind=/],
] as const)
  test(`a one-time D1 failure on ${label} is finished by the retried record-failure`, async () => {
    const s = await setup();
    fakes.content = { throws: "Markdown: HTTP 404" };
    const id = await save(s, "https://replay.example/x");
    fakes.failSqlOnce = pattern;
    await s.runQueued();
    expect(fakes.failSqlOnce).toBeUndefined(); // the fault fired
    expect(s.steps.find((x) => x.name === "record-failure")?.attempts).toBe(2);
    expect(await s.view(id)).toMatchObject({ content: "failed", content_reason: "not_found", attention: true, attention_kind: "content", attention_reason: "not_found", job: "failed/Needs attention" });
    const row = s.db.query("SELECT attention_at FROM links WHERE id=?").get(id) as { attention_at: string };
    expect(row.attention_at).toBe(new Date().toISOString());
  });

test("a job interrupted while running leaves the link alone when its own failure is recorded", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://interrupted.example/x");
  fakes.onContent = async () => {
    // What dispatch() does for an errored instance while the callback is still going.
    s.db.query("UPDATE jobs SET status='failed',step='Interrupted' WHERE link_id=?").run(id);
    s.db.query("UPDATE links SET content_state='missing' WHERE id=?").run(id);
  };
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "missing", err: null, attention: false, job: "failed/Interrupted" });
});

test("a failed re-extract that keeps previous content never adds preview attention", async () => {
  const s = await setup();
  // Manual content on a link whose preview never ran (cancelled import, then pasted).
  const imp = await s.api("/import", "POST", { urls: ["https://kept.example/x"] });
  const id = imp.data.links[0].id;
  s.sent.splice(0);
  await s.api(`/batches/${imp.data.batches[0].id}`, "DELETE");
  await s.api(`/links/${id}/content`, "PUT", { markdown: "manual" });
  fakes.meta = { status: "failed" };
  fakes.content = { throws: "Markdown: HTTP 503" };
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", err: "The site had a problem.", attention: false, attention_kind: null });
  expect((await s.api(`/links/${id}/content`)).data.markdown).toBe("manual");
  // Again, now with a failed preview already stored: still nothing.
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "failed", attention: false });
});

test("a failed re-extract with previous content keeps an unresolved preview failure, keeps a dismissed one dismissed, and clears it when the preview works", async () => {
  const s = await setup();
  fakes.meta = { status: "failed" };
  const id = await save(s, "https://dismissed.example/x");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", attention_kind: "preview", attention_reason: "blocked" });
  const at = (s.db.query("SELECT attention_at FROM links WHERE id=?").get(id) as any).attention_at;
  fakes.content = { throws: "Markdown: HTTP 503" };
  tick(60_000);
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ attention_kind: "preview", attention_reason: "blocked" });
  expect((s.db.query("SELECT attention_at FROM links WHERE id=?").get(id) as any).attention_at).toBe(at);

  await s.api(`/links/${id}/dismiss`, "POST");
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "failed", attention: false, attention_kind: null });

  // Not dismissed, and this time the preview works while content fails again: cleared.
  s.db.query("UPDATE links SET attention_kind='preview',attention_reason='blocked' WHERE id=?").run(id);
  fakes.meta = { status: "ready" };
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false });
});

test("migrations 0014 and 0015 on an existing library: only settled failures need attention", async () => {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf("0014_attention.sql");
  for (const f of files.slice(0, at)) db.exec(await Bun.file(`migrations/${f}`).text());
  db.exec("INSERT INTO batches(id,kind,config,created_at) VALUES('b','extract','{}','2026-09-01T00:00:00.000Z')");
  const link = db.query("INSERT INTO links(id,original_url,url,domain,title,description,status,content_state,content_key,content_error,preview_reason,content_reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const job = db.query("INSERT INTO jobs(id,batch_id,link_id,status,step,reason,preview_reason,created_at) VALUES(?,?,?,?,?,?,?,?)");
  let t = 0;
  const add = (id: string, l: { status: string; content: string; key?: string; error?: string; preview?: string; reason?: string },
    jobs: [status: string, step: string, preview?: string, reason?: string][]) => {
    link.run(id, `https://${id}.example/`, `https://${id}.example/`, `${id}.example`, id, "", l.status, l.content, l.key ?? null, l.error ?? null, l.preview ?? null, l.reason ?? null, "2026-09-01T00:00:00.000Z");
    for (const [i, [status, step, preview, reason]] of jobs.entries())
      job.run(`${id}-${i}`, "b", id, status, step, reason ?? null, preview ?? null, `2026-09-02T00:00:${String(t++).padStart(2, "0")}.000Z`);
  };
  // First extraction still running after its preview failed: not final yet.
  add("inprogress", { status: "failed", content: "queued", preview: "blocked" }, [["running", "Extracting content", "blocked"]]);
  // Failed re-extract that kept manual content (preview never fetched before).
  add("kept", { status: "failed", content: "ready", key: "old.md", error: "The site had a problem.", preview: "blocked", reason: "site_error" },
    [["failed", "Cancelled"], ["failed", "Needs attention", "blocked", "site_error"]]);
  // A genuine preview failure, now being retried (the retry already failed its preview again, or not yet).
  add("retrying", { status: "failed", content: "queued", key: "a.md", preview: "blocked" }, [["done", "Done", "blocked"], ["running", "Extracting content", "blocked"]]);
  add("waiting", { status: "failed", content: "queued", key: "a.md", preview: "blocked" }, [["done", "Done", "blocked"], ["queued", "En cola"]]);
  // A genuine preview failure, then a failed re-extract that kept the content: still unresolved.
  add("genuine", { status: "failed", content: "ready", key: "a.md", error: "The site had a problem.", preview: "blocked" },
    [["done", "Done", "blocked"], ["failed", "Needs attention", "blocked", "site_error"]]);
  // Settled failures.
  add("preview", { status: "failed", content: "ready", key: "a.md", preview: "not_html" }, [["done", "Done", "not_html"]]);
  add("content", { status: "ready", content: "failed", error: "The page no longer exists.", reason: "not_found" }, [["failed", "Needs attention", undefined, "not_found"]]);
  // Content that failed for good and is being extracted again.
  add("recontent", { status: "ready", content: "queued" }, [["failed", "Needs attention", undefined, "timeout"], ["queued", "En cola"]]);
  // Neutral: cancelled, interrupted, fresh.
  add("cancelled", { status: "pending", content: "missing" }, [["failed", "Cancelled"]]);
  add("interrupted", { status: "pending", content: "queued" }, [["failed", "Interrupted"], ["queued", "En cola"]]);
  add("fresh", { status: "pending", content: "queued" }, [["queued", "En cola"]]);
  for (const f of files.slice(at)) db.exec(await Bun.file(`migrations/${f}`).text());
  const rows = Object.fromEntries((db.query("SELECT id,attention_kind,attention_reason,attention_at IS NOT NULL dated FROM links").all() as any[])
    .map((r) => [r.id, [r.attention_kind, r.attention_reason, r.dated]]));
  expect(rows).toEqual({
    inprogress: [null, null, 0],
    kept: [null, null, 0],
    retrying: ["preview", "blocked", 1],
    waiting: ["preview", "blocked", 1],
    genuine: ["preview", "blocked", 1],
    preview: ["preview", "not_html", 1],
    content: ["content", "not_found", 1],
    recontent: ["content", "timeout", 1],
    cancelled: [null, null, 0],
    interrupted: [null, null, 0],
    fresh: [null, null, 0],
  });
});
