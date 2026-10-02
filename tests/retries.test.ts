// FAC-48 S3: classified failure reasons, bounded retries with backoff, visible attempts and telemetry.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";
import { FAILURE_MESSAGES, jobProgress } from "../src/failures";
import { LinkFailure } from "../worker/failures";
import type { Job } from "../src/types";

let logs: Record<string, unknown>[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  spy = spyOn(console, "log").mockImplementation((line: unknown) => {
    try { const v = JSON.parse(String(line)); if (v.event === "link_step_failed") logs.push(v); } catch { /* not JSON */ }
  });
});
afterEach(() => { spy.mockRestore(); resetClock(); });

type S = Awaited<ReturnType<typeof setup>>;
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const reextract = (s: S, id: string) => s.api("/batches", "POST", { kind: "extract", ids: [id] });
const lastJob = (s: S, id: string) => s.db.query("SELECT * FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as Job;
const attempts = (s: S, name: string) => s.steps.filter((x) => x.name === name).map((x) => x.attempts);
const linkRow = (s: S, id: string) => s.db.query("SELECT preview_reason,content_reason,title FROM links WHERE id=?").get(id) as any;

test("retry config: preview 2 retries, Markdown 1, both with exponential backoff", async () => {
  const s = await setup();
  await save(s, "https://cfg.example/x");
  await s.runQueued();
  expect(s.steps.find((x) => x.name === "resolve-and-preview")?.retries).toMatchObject({ limit: 2, backoff: "exponential" });
  expect(s.steps.find((x) => x.name === "extract-content")?.retries).toMatchObject({ limit: 1, backoff: "exponential" });
});

for (const [label, meta, reason] of [
  ["403 bot wall", { http: 403 }, "blocked"],
  ["Cloudflare challenge", { http: 503, headers: { "cf-mitigated": "challenge" } }, "blocked"],
  ["404", { http: 404 }, "not_found"],
  ["410", { http: 410 }, "not_found"],
  ["PDF", { http: 200, type: "application/pdf" }, "not_html"],
] as const)
  test(`preview ${label} fails fast (1 attempt) with reason ${reason}; content is still extracted`, async () => {
    const s = await setup();
    fakes.meta = meta;
    const id = await save(s, "https://fast.example/doc");
    await s.runQueued();
    expect(fakes.calls.meta).toBe(1);
    expect(attempts(s, "resolve-and-preview")).toEqual([1]);
    expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", job: "done/Done", preview_reason: reason });
    expect(lastJob(s, id).preview_reason).toBe(reason);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "link_step_failed", link_id: id, job_id: lastJob(s, id).id, step: "preview", attempt: 1, max_attempts: 3, final: true, reason, domain: "fast.example" });
    if (label === "PDF") expect(logs[0]).toMatchObject({ http_status: 200, content_type: "application/pdf" });
  });

for (const [label, meta, reason] of [
  ["429", { http: 429 }, "rate_limited"],
  ["5xx", { http: 502 }, "site_error"],
  ["timeout", { throws: "The operation timed out." }, "timeout"],
  ["DNS", { throws: "DNS unavailable" }, "unreachable"],
] as const)
  test(`preview ${label} is retried twice (3 attempts), then only the preview fails`, async () => {
    const s = await setup();
    fakes.meta = meta;
    const id = await save(s, "https://slow.example/x");
    await s.runQueued();
    expect(fakes.calls.meta).toBe(3);
    expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", job: "done/Done", preview_reason: reason });
    expect(logs.map((l) => [l.attempt, l.final, l.reason])).toEqual([[1, false, reason], [2, false, reason], [3, true, reason]]);
  });

test("transient preview failure → retry → success never shows Needs attention; Activity shows attempt 2 of 3", async () => {
  const s = await setup();
  fakes.meta = [{ http: 503 }, { status: "ready" }];
  const id = await save(s, "https://flaky.example/x");
  const batch = s.db.query("SELECT batch_id FROM jobs WHERE link_id=?").get(id) as { batch_id: string };
  let during: Awaited<ReturnType<S["view"]>> | undefined, job: Job | undefined;
  fakes.onMeta = async () => {
    if (fakes.calls.meta !== 2) return;
    during = await s.view(id);
    job = (await s.api(`/batches/${batch.batch_id}`)).data.jobs[0];
  };
  await s.runQueued();
  expect(during).toMatchObject({ status: "pending", processing: true, previewing: true, attention: false, job: "running/Fetching preview" });
  expect(job).toMatchObject({ attempt: 2, max_attempts: 3, reason: "site_error" });
  expect(jobProgress(job!)).toEqual({ step: "Fetching preview · Attempt 2 of 3", note: `Previous attempt: ${FAILURE_MESSAGES.site_error}` });
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, preview_reason: null, job: "done/Done" });
  expect(lastJob(s, id).preview_reason).toBeNull();
});

test("transient Markdown failure → 1 retry → success never shows Needs attention", async () => {
  const s = await setup();
  fakes.content = [{ throws: "Markdown: HTTP 503" }, { markdown: "# ok" }];
  const id = await save(s, "https://md.example/x");
  let during: Awaited<ReturnType<S["view"]>> | undefined, job: Job | undefined;
  fakes.onContent = async () => {
    if (fakes.calls.content !== 2) return;
    during = await s.view(id);
    job = lastJob(s, id);
  };
  await s.runQueued();
  expect(fakes.calls.content).toBe(2);
  expect(during).toMatchObject({ content: "queued", processing: true, attention: false, job: "running/Extracting content" });
  expect(jobProgress(job!)).toEqual({ step: "Extracting content · Attempt 2 of 2", note: `Previous attempt: ${FAILURE_MESSAGES.site_error}` });
  expect(await s.view(id)).toMatchObject({ content: "ready", attention: false, err: null, content_reason: null, job: "done/Done" });
});

test("Markdown keeps failing: 2 attempts, then the link fails with a plain reason", async () => {
  const s = await setup();
  fakes.content = { throws: "Navigation timeout of 30000 ms exceeded" };
  const id = await save(s, "https://md.example/slow");
  await s.runQueued();
  expect(fakes.calls.content).toBe(2);
  expect(await s.view(id)).toMatchObject({ content: "failed", attention: true, err: FAILURE_MESSAGES.timeout, content_reason: "timeout", job: "failed/Needs attention" });
  expect(lastJob(s, id)).toMatchObject({ reason: "timeout", error: FAILURE_MESSAGES.timeout });
  expect(logs.map((l) => [l.step, l.attempt, l.final])).toEqual([["content", 1, false], ["content", 2, true]]);
});

for (const [label, content, reason] of [
  ["blocked", { throws: "Markdown: HTTP 403" }, "blocked"],
  ["empty page", { error: new LinkFailure("empty") }, "empty"], // what the web adapter throws for no content
  ["private host", { throws: "Private host" }, "unreachable"],
] as const)
  test(`Markdown ${label} fails fast without a retry`, async () => {
    const s = await setup();
    fakes.content = content;
    const id = await save(s, "https://md.example/fast");
    await s.runQueued();
    expect(fakes.calls.content).toBe(1);
    expect(await s.view(id)).toMatchObject({ content: "failed", content_reason: reason, err: FAILURE_MESSAGES[reason] });
  });

test("a failed re-extract with previous content keeps it, stays out of Needs attention and is recorded in Activity", async () => {
  const s = await setup();
  const id = await save(s, "https://kept.example/x");
  await s.runQueued();
  fakes.content = { throws: "Markdown: HTTP 503" };
  await reextract(s, id);
  await s.runQueued();
  expect(fakes.calls.content).toBe(3);
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, err: FAILURE_MESSAGES.site_error, content_reason: "site_error" });
  expect(lastJob(s, id)).toMatchObject({ status: "failed", reason: "site_error", error: FAILURE_MESSAGES.site_error });
  expect(s.db.query("SELECT count(*) n FROM usage_events WHERE link_id=?").get(id)).toEqual({ n: 0 }); // the fake adapter is not metered
});

test("a failed preview on re-extract keeps the previous preview and records the reason only in Activity", async () => {
  const s = await setup();
  const id = await save(s, "https://kept.example/p");
  await s.runQueued();
  fakes.meta = { http: 429 };
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, preview_reason: null });
  expect(linkRow(s, id).title).toBe("Title of kept.example");
  const job = lastJob(s, id);
  expect(job).toMatchObject({ status: "done", preview_reason: "rate_limited" });
  expect(jobProgress(job).note).toBe(`No preview: ${FAILURE_MESSAGES.rate_limited}`);
});

test("a later successful preview clears the reason; Retry preview records its own reason", async () => {
  const s = await setup();
  fakes.meta = { http: 404 };
  const id = await save(s, "https://later.example/x");
  await s.runQueued();
  expect(linkRow(s, id).preview_reason).toBe("not_found");
  fakes.meta = { http: 200, type: "application/pdf" };
  await s.api(`/links/${id}/retry`, "POST");
  expect(await s.view(id)).toMatchObject({ status: "failed", preview_reason: "not_html" });
  expect(logs.at(-1)).toMatchObject({ step: "preview-retry", reason: "not_html", final: true, job_id: null });
  fakes.meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
  expect(await s.view(id)).toMatchObject({ status: "ready", preview_reason: null, attention: false });
});
