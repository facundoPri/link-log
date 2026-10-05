// FAC-48 part 3: persisted Needs attention. Regression tests for repro scenarios A–I with the final rules:
// set only when a step fails for good, kept while its retry runs, cleared by that step's success or Dismiss.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { contentFailureAttentionSql, nextAttention } from "../worker/attention";
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

// Round 3 (S4 re-review).

const blockedPreviewWithContent = async (s: S, url: string) => {
  fakes.meta = { status: "failed" };
  const id = await save(s, url);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", attention_kind: "preview", attention_reason: "blocked" });
  return id;
};

test("a Dismiss that lands while a failed re-extract settles stays dismissed", async () => {
  const s = await setup();
  const id = await blockedPreviewWithContent(s, "https://race.example/x");
  fakes.content = { throws: "Markdown: HTTP 404" };
  await reextract(s, id);
  let dismissed = false;
  fakes.onSql = async (sql, phase) => {
    if (dismissed || phase !== "write" || !sql.startsWith("UPDATE links SET content_state=")) return;
    dismissed = true;
    expect((await s.api(`/links/${id}/dismiss`, "POST")).status).toBe(200);
    expect((await s.view(id)).attention).toBe(false);
  };
  await s.runQueued();
  fakes.onSql = undefined;
  expect(dismissed).toBe(true);
  expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", err: "The page no longer exists.", attention: false, attention_kind: null, job: "failed/Needs attention" });
});

test("a Dismiss between reading and writing a settlement is never overwritten", async () => {
  const s = await setup();
  const id = await blockedPreviewWithContent(s, "https://race2.example/x");
  let dismissed = false;
  fakes.onSql = async (sql, phase) => {
    if (dismissed || phase !== "read" || !sql.startsWith("SELECT status,preview_reason,content_key,attention_kind")) return;
    dismissed = true;
    await s.api(`/links/${id}/dismiss`, "POST");
  };
  // Pasting content settles {content: ok}, which keeps the preview warning as it was read.
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  fakes.onSql = undefined;
  expect(dismissed).toBe(true);
  expect(await s.view(id)).toMatchObject({ attention: false, attention_kind: null });
});

test("the content failure SQL settles exactly like nextAttention, on the live row", async () => {
  // Every input nextAttention reads is varied, so a change to either copy that the other misses fails here.
  const db = new Database(":memory:");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) db.exec(await Bun.file(`migrations/${f}`).text());
  let n = 0;
  for (const status of ["ready", "failed"] as const)
  for (const preview_reason of [null, "blocked"])
  for (const content_key of [null, "k"])
    for (const [attention_kind, attention_reason] of [[null, null], ["preview", "blocked"], ["preview", null], ["content", "timeout"], ["content", "not_found"], ["content", null]] as const)
      for (const previewOk of [true, false])
      for (const reason of ["not_found", null]) {
        const id = `l${n++}`;
        db.query("INSERT INTO links(id,original_url,url,domain,title,description,status,content_key,preview_reason,attention_kind,attention_reason,attention_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(id, `https://${id}/`, `https://${id}/`, "x", "x", "", status, content_key, preview_reason, attention_kind, attention_reason, attention_kind ? "2026-01-01T00:00:00.000Z" : null, "2026-01-01T00:00:00.000Z");
        const set = contentFailureAttentionSql(reason, previewOk);
        db.query(`UPDATE links SET ${set.sql} WHERE id=?`).run(...(set.params as never[]), id);
        const row = db.query("SELECT attention_kind,attention_reason,attention_at FROM links WHERE id=?").get(id) as any;
        const expected = nextAttention({ status, preview_reason, content_key, attention_kind, attention_reason },
          { content: "failed", content_reason: reason, preview: previewOk ? "ok" : "failed" });
        expect({ kind: row.attention_kind, reason: row.attention_reason }).toEqual({ kind: expected.attention_kind, reason: expected.attention_reason });
        const unchanged = expected.attention_kind === attention_kind && expected.attention_reason === attention_reason;
        expect(row.attention_at === "2026-01-01T00:00:00.000Z").toBe(unchanged && !!attention_kind);
        expect(row.attention_at === null).toBe(!expected.attention_kind);
      }
  expect(n).toBe(192);
});

// Upgrade fixtures for migration 0014: links and their extract jobs as an older version left them.
type Fixture = { status: string; content: string; key?: string; source?: string; updated?: string; error?: string; preview?: string; reason?: string; retried?: string;
  /** The content was saved during this job (by index), just after it started. */
  savedBy?: number };
type FixtureJob = [status: string, step: string, preview?: string, reason?: string];
async function upgrade(from: "0012" | "0014", rows: Record<string, [Fixture, FixtureJob[]]>) {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  const at = files.findIndex((f) => f.startsWith(from));
  for (const f of files.slice(0, at)) db.exec(await Bun.file(`migrations/${f}`).text());
  const legacy = from === "0012";
  db.exec("INSERT INTO batches(id,kind,config,created_at) VALUES('b','extract','{}','2026-09-01T00:00:00.000Z')");
  let t = 10;
  for (const [id, [l, jobs]] of Object.entries(rows)) {
    db.query(`INSERT INTO links(id,original_url,url,domain,title,description,status,content_state,content_key,content_source,content_updated_at,content_error,metadata_started_at${legacy ? "" : ",preview_reason,content_reason"},created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?${legacy ? "" : ",?,?"},?)`)
      .run(...([id, `https://${id}.example/`, `https://${id}.example/`, `${id}.example`, id, "", l.status, l.content, l.key ?? null, l.source ?? (l.key ? "web" : null),
        l.updated ?? null, l.error ?? null, l.retried ?? null, ...(legacy ? [] : [l.preview ?? null, l.reason ?? null]), "2026-09-01T00:00:00.000Z"] as never[]));
    for (const [i, [status, step, preview, reason]] of jobs.entries())
      db.query(`INSERT INTO jobs(id,batch_id,link_id,status,step,created_at${legacy ? "" : ",reason,preview_reason,adapter"}) VALUES(?,?,?,?,?,?${legacy ? "" : ",?,?,?"})`)
        .run(...([`${id}-${i}`, "b", id, status, step, `2026-09-02T00:00:${t++}.000Z`,
          ...(legacy ? [] : [reason ?? null, preview ?? null, ["done", "failed"].includes(status) && !["Cancelled"].includes(step) ? "web" : null])] as never[]));
    if (l.savedBy !== undefined)
      db.query("UPDATE links SET content_updated_at=(SELECT replace(created_at,'.000Z','.500Z') FROM jobs WHERE id=?) WHERE id=?").run(`${id}-${l.savedBy}`, id);
  }
  for (const f of files.slice(at)) db.exec(await Bun.file(`migrations/${f}`).text());
  return Object.fromEntries((db.query("SELECT id,attention_kind,attention_reason,attention_at IS NOT NULL dated FROM links").all() as any[])
    .map((r) => [r.id, r.attention_kind ? `${r.attention_kind}/${r.attention_reason ?? "?"}` : null]));
}
// The same histories, in the 0013 schema (with reasons) and in the deployed one (before 0012, no reasons).
const histories = (legacy: boolean): Record<string, [Fixture, FixtureJob[]]> => {
  const p = legacy ? undefined : "blocked";
  const kept = { key: "old.md", source: "manual", updated: "2026-09-02T00:00:00.000Z" };
  return {
    // Neutral: nothing settled a final failure.
    interrupted: [{ status: "failed", content: "missing", preview: p }, [["failed", "Interrupted", p]]],
    inProgress: [{ status: "failed", content: "queued", preview: p }, [["running", "Extracting content", p]]],
    keptOnce: [{ status: "failed", content: "ready", ...kept, error: "The site had a problem.", preview: p }, [["failed", "Cancelled"], ["failed", "Needs attention", p, "site_error"]]],
    keptTwice: [{ status: "failed", content: "ready", ...kept, error: "The site had a problem.", preview: p },
      [["failed", "Cancelled"], ["failed", "Needs attention", p, "site_error"], ["failed", "Needs attention", p, "site_error"]]],
    // Web content saved by an extraction that was then interrupted, kept by failed re-extracts.
    savedThenKeptOnce: [{ status: "failed", content: "ready", key: "web.md", savedBy: 0, error: "The site had a problem.", preview: p },
      [["failed", "Interrupted", p], ["failed", "Needs attention", p, "site_error"]]],
    savedThenKeptTwice: [{ status: "failed", content: "ready", key: "web.md", savedBy: 0, error: "The site had a problem.", preview: p },
      [["failed", "Interrupted", p], ["failed", "Needs attention", p, "site_error"], ["failed", "Needs attention", p, "site_error"]]],
    cancelled: [{ status: "pending", content: "missing" }, [["failed", "Cancelled"]]],
    fresh: [{ status: "pending", content: "queued" }, [["queued", "En cola"]]],
    contentInterrupted: [{ status: "ready", content: legacy ? "failed" : "missing", error: legacy ? "Extraction was interrupted. Try again." : undefined }, [["failed", "Interrupted"]]],
    // A genuine earlier preview failure, then retries that did not settle anything new.
    genuineThenInterrupted: [{ status: "failed", content: "ready", key: "a.md", preview: p }, [["done", "Done", p], ["failed", "Interrupted", p]]],
    genuineThenKept: [{ status: "failed", content: "ready", key: "a.md", error: "The site had a problem.", preview: p },
      [["done", "Done", p], ["failed", "Needs attention", p, "site_error"], ["failed", "Needs attention", p, "site_error"]]],
    genuineRetrying: [{ status: "failed", content: "queued", key: "a.md", preview: p }, [["done", "Done", p], ["running", "Extracting content", p]]],
    // Settled failures.
    preview: [{ status: "failed", content: "ready", key: "a.md", preview: p }, [["done", "Done", p]]],
    content: [{ status: "ready", content: "failed", error: "The page no longer exists.", reason: legacy ? undefined : "not_found" }, [["failed", "Needs attention", undefined, legacy ? undefined : "not_found"]]],
    contentRetrying: [{ status: "ready", content: "queued" }, [["failed", "Needs attention", undefined, legacy ? undefined : "timeout"], ["queued", "En cola"]]],
    contentThenInterrupted: [{ status: "ready", content: legacy ? "failed" : "failed", error: "The site took too long to respond." },
      [["failed", "Needs attention", undefined, legacy ? undefined : "timeout"], ["failed", "Interrupted"]]],
    retryPreview: [{ status: "failed", content: "ready", key: "a.md", preview: p, retried: "2026-09-03T00:00:00.000Z" }, [["done", "Done"]]],
    noJobs: [{ status: "failed", content: "missing", preview: p }, []],
    // Genuine earlier failure, then content saved by an interrupted retry and kept by a failed one.
    genuineThenSavedThenKept: [{ status: "failed", content: "ready", key: "web.md", savedBy: 1, error: "The site had a problem.", preview: p },
      [["done", "Done", p], ["failed", "Interrupted", p], ["failed", "Needs attention", p, "site_error"]]],
    // Neutral again: a later preview worked, then a re-extract kept content or was interrupted.
    fixedThenKept: [{ status: "failed", content: "ready", key: "a.md", error: "The site had a problem.", preview: p },
      [["done", "Done", p], ["done", "Done"], ["failed", "Needs attention", p, "site_error"]]],
  };
};

test("migration 0014 on a library from this branch's 0013 schema: only settled failures need attention", async () => {
  expect(await upgrade("0014", histories(false))).toEqual({
    interrupted: null, inProgress: null, keptOnce: null, keptTwice: null, cancelled: null, fresh: null, contentInterrupted: null,
    savedThenKeptOnce: null, savedThenKeptTwice: null, genuineThenSavedThenKept: "preview/blocked",
    genuineThenInterrupted: "preview/blocked", genuineThenKept: "preview/blocked", genuineRetrying: "preview/blocked",
    preview: "preview/blocked", content: "content/not_found", contentRetrying: "content/timeout", contentThenInterrupted: "content/timeout",
    retryPreview: "preview/blocked", noJobs: "preview/blocked", fixedThenKept: null,
  });
});

test("migration 0014 on the deployed library (before 0012, no stored reasons): the same, with generic reasons", async () => {
  expect(await upgrade("0012", histories(true))).toEqual({
    interrupted: null, inProgress: null, keptOnce: null, keptTwice: null, cancelled: null, fresh: null, contentInterrupted: null,
    savedThenKeptOnce: null, savedThenKeptTwice: null, genuineThenSavedThenKept: "preview/?",
    genuineThenInterrupted: "preview/?", genuineThenKept: "preview/?", genuineRetrying: "preview/?",
    preview: "preview/?", content: "content/?", contentRetrying: "content/?", contentThenInterrupted: "content/?",
    retryPreview: "preview/?", noJobs: "preview/?",
    // Ambiguous without reasons: the last settled extraction is taken as the one that failed the preview.
    fixedThenKept: "preview/?",
  });
  expect(attentionMessage({ attention_kind: "preview", attention_reason: null })).toBe("Couldn't get the preview: Something went wrong.");
});
