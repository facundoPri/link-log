// FAC-48 S3: classified failure reasons, bounded retries with backoff, visible attempts and telemetry.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { fakes, resetClock, setup, tick } from "./worker-harness";
import { FAILURE_MESSAGES, jobProgress } from "../src/failures";
import { ADAPTER_MESSAGES, LinkFailure } from "../worker/failures";
import { ATTEMPT_BUDGET_MS } from "../worker/handlers/extract";
import type { Job } from "../src/types";

let logs: Record<string, unknown>[] = [];
let spy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logs = [];
  spy = spyOn(console, "log").mockImplementation((line: unknown) => {
    try { const v = JSON.parse(String(line)); if (v.event === "link_step_failed") logs.push(v); } catch { /* not JSON */ }
  });
});
const budgets = { ...ATTEMPT_BUDGET_MS };
afterEach(() => { spy.mockRestore(); resetClock(); Object.assign(ATTEMPT_BUDGET_MS, budgets); });

type S = Awaited<ReturnType<typeof setup>>;
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const reextract = (s: S, id: string) => s.api("/batches", "POST", { kind: "extract", ids: [id] });
const lastJob = (s: S, id: string) => s.db.query("SELECT * FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as Job;
const attempts = (s: S, name: string) => s.steps.filter((x) => x.name === name).map((x) => x.attempts);
const linkRow = (s: S, id: string) => s.db.query("SELECT preview_reason,content_reason,title FROM links WHERE id=?").get(id) as any;

test("retry config: preview 2 retries, Markdown 1, both with exponential backoff", async () => {
  const s = await setup({ placeholder: true });
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
    const s = await setup({ placeholder: true });
    fakes.meta = meta;
    const id = await save(s, "https://fast.example/doc");
    await s.runQueued();
    expect(fakes.calls.meta).toBe(1);
    expect(attempts(s, "resolve-and-preview")).toEqual([1]);
    expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", job: "done/Done", preview_reason: reason });
    expect(lastJob(s, id).preview_reason).toBe(reason);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "link_step_failed", link_id: id, job_id: lastJob(s, id).id, step: "preview", adapter: "preview", attempt: 1, max_attempts: 3, final: true, reason, domain: "fast.example" });
    if (label === "PDF") expect(logs[0]).toMatchObject({ http_status: 200, content_type: "application/pdf" });
  });

for (const [label, meta, reason] of [
  ["429", { http: 429 }, "rate_limited"],
  ["5xx", { http: 502 }, "site_error"],
  ["timeout", { throws: "The operation timed out." }, "timeout"],
  ["DNS", { throws: "DNS unavailable" }, "unreachable"],
] as const)
  test(`preview ${label} is retried twice (3 attempts), then only the preview fails`, async () => {
    const s = await setup({ placeholder: true });
    fakes.meta = meta;
    const id = await save(s, "https://slow.example/x");
    await s.runQueued();
    expect(fakes.calls.meta).toBe(3);
    expect(await s.view(id)).toMatchObject({ status: "failed", content: "ready", job: "done/Done", preview_reason: reason });
    expect(logs.map((l) => [l.adapter, l.attempt, l.final, l.reason])).toEqual([["preview", 1, false, reason], ["preview", 2, false, reason], ["preview", 3, true, reason]]);
  });

test("transient preview failure → retry → success never shows Needs attention; Activity shows attempt 2 of 3", async () => {
  const s = await setup({ placeholder: true });
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
  expect(job).toMatchObject({ attempt_budget_ms: 20_000, adapter: "preview" });
  expect(jobProgress(job!)).toEqual({ step: "Fetching preview · Attempt 2 of 3 · 0s of 20s", note: `Previous attempt: ${FAILURE_MESSAGES.site_error}` });
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, preview_reason: null, job: "done/Done" });
  expect(lastJob(s, id).preview_reason).toBeNull();
});

test("transient Markdown failure → 1 retry → success never shows Needs attention", async () => {
  const s = await setup({ placeholder: true });
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
  expect(jobProgress(job!)).toEqual({ step: "Extracting content · Attempt 2 of 2 · 0s of 1m 40s", note: `Previous attempt: ${FAILURE_MESSAGES.site_error}` });
  expect(await s.view(id)).toMatchObject({ content: "ready", attention: false, err: null, content_reason: null, job: "done/Done" });
});

test("Markdown keeps failing: 2 attempts, then the link fails with a plain reason", async () => {
  const s = await setup({ placeholder: true });
  fakes.content = { throws: "Navigation timeout of 30000 ms exceeded" };
  const id = await save(s, "https://md.example/slow");
  await s.runQueued();
  expect(fakes.calls.content).toBe(2);
  expect(await s.view(id)).toMatchObject({ content: "failed", attention: true, err: FAILURE_MESSAGES.timeout, content_reason: "timeout", job: "failed/Needs attention" });
  expect(lastJob(s, id)).toMatchObject({ reason: "timeout", error: FAILURE_MESSAGES.timeout });
  expect(logs.map((l) => [l.step, l.adapter, l.attempt, l.final])).toEqual([["content", "web", 1, false], ["content", "web", 2, true]]);
});

for (const [label, content, reason] of [
  ["blocked", { throws: "Markdown: HTTP 403" }, "blocked"],
  ["empty page", { error: new LinkFailure("empty") }, "empty"], // what the web adapter throws for no content
  ["private host", { throws: "Private host" }, "unreachable"],
] as const)
  test(`Markdown ${label} fails fast without a retry`, async () => {
    const s = await setup({ placeholder: true });
    fakes.content = content;
    const id = await save(s, "https://md.example/fast");
    await s.runQueued();
    expect(fakes.calls.content).toBe(1);
    expect(await s.view(id)).toMatchObject({ content: "failed", content_reason: reason, err: FAILURE_MESSAGES[reason] });
  });

test("a failed re-extract with previous content keeps it, stays out of Needs attention and is recorded in Activity", async () => {
  const s = await setup({ placeholder: true });
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
  const s = await setup({ placeholder: true });
  const id = await save(s, "https://kept.example/p");
  await s.runQueued();
  fakes.meta = { http: 429 };
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", content: "ready", attention: false, preview_reason: null });
  expect(linkRow(s, id).title).toBe("kept.example");
  const job = lastJob(s, id);
  expect(job).toMatchObject({ status: "done", preview_reason: "rate_limited" });
  expect(jobProgress(job).note).toBe(`No preview: ${FAILURE_MESSAGES.rate_limited}`);
});

test("a later successful preview clears the reason; Retry preview records its own reason", async () => {
  const s = await setup({ placeholder: true });
  fakes.meta = { http: 404 };
  const id = await save(s, "https://later.example/x");
  await s.runQueued();
  expect(linkRow(s, id).preview_reason).toBe("not_found");
  fakes.meta = { http: 200, type: "application/pdf" };
  const retry = await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "failed", preview_reason: "not_html", attention: true, job: "failed/Needs attention" });
  const job = s.db.query("SELECT id FROM jobs WHERE batch_id=?").get(retry.data.batchId) as { id: string };
  expect(logs.at(-1)).toMatchObject({ step: "preview", adapter: "preview", reason: "not_html", final: true, job_id: job.id });
  fakes.meta = { status: "ready" };
  await s.api(`/links/${id}/retry`, "POST");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ status: "ready", preview_reason: null, attention: false });
});

// Round 2 (S3 review).

const envelope = (status: number, body: unknown) =>
  () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const failedEnvelope = (status: number, message: string, code?: number) => envelope(status, { success: false, errors: [{ code, message }] });
// A public IP literal skips DNS in validateDestination, so the real web adapter runs offline.
const PUBLIC_URL = "https://93.184.216.34/page";

for (const [status, message, code, reason, calls] of [
  [403, "Authentication error", 10000, "service_unavailable", 1], // the Browser API's own account error, not the site
  [403, "Forbidden", undefined, "blocked", 1],
  [404, "Not found", undefined, "not_found", 1],
  [422, "Navigation timeout of 30000 ms exceeded", undefined, "timeout", 2], // how the API reports a render timeout
  [429, "Rate limit exceeded", undefined, "rate_limited", 2],
  [503, "Service unavailable", undefined, "site_error", 2],
] as const)
  test(`real web adapter: a JSON ${status} "${message}" envelope is ${reason} with ${calls} Browser call(s)`, async () => {
    const s = await setup({ placeholder: true });
    fakes.browser = failedEnvelope(status, message, code);
    const id = await save(s, PUBLIC_URL);
    await s.runQueued();
    expect(fakes.calls.browser).toBe(calls);
    expect(s.db.query("SELECT count(*) n FROM usage_events WHERE link_id=? AND service='browser-markdown' AND status='failed'").get(id)).toEqual({ n: calls });
    expect(await s.view(id)).toMatchObject({ content: "failed", content_reason: reason, err: FAILURE_MESSAGES[reason] });
    expect(logs.at(-1)).toMatchObject({ step: "content", adapter: "web", reason, http_status: status, final: true, attempt: calls });
    expect(String(logs.at(-1)!.detail)).toContain(message);
  });

test("the Markdown call bounds its own navigation and action below the attempt budget (the binding takes no abort signal)", async () => {
  const s = await setup({ placeholder: true });
  let options: Record<string, any> = {};
  fakes.browser = (_action, o) => ((options = o), envelope(200, { success: true, result: "# Page" })());
  await save(s, PUBLIC_URL);
  await s.runQueued();
  expect(options.gotoOptions.timeout).toBeGreaterThan(0);
  expect(options.actionTimeout).toBeGreaterThan(0);
  // Navigation is capped at 60 s by the API; both bounds together leave room for the call's own overhead.
  expect(options.gotoOptions.timeout).toBeLessThanOrEqual(60_000);
  expect(options.gotoOptions.timeout + options.actionTimeout).toBeLessThan(ATTEMPT_BUDGET_MS.content * 0.8);
});

test("a timed-out Markdown call that answers during the next attempt can't replace its content or count as a success", async () => {
  const s = await setup({ placeholder: true });
  ATTEMPT_BUDGET_MS.content = 20;
  let releaseFirst!: (r: Response) => void;
  const ok = (markdown: string) => new Response(JSON.stringify({ success: true, result: markdown }), { status: 200 });
  fakes.browser = async () => {
    if (fakes.calls.browser === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve));
    // Attempt 2 is running: the abandoned first call answers now and finishes its work.
    releaseFirst(ok("# timed-out first attempt"));
    await Bun.sleep(5);
    return ok("# second attempt");
  };
  const id = await save(s, PUBLIC_URL);
  await s.runQueued();
  await Bun.sleep(5);
  expect(fakes.calls.browser).toBe(2);
  const link = s.db.query("SELECT content_key,content_state,content_error FROM links WHERE id=?").get(id) as any;
  expect(link).toMatchObject({ content_state: "ready", content_error: null });
  expect(s.r2.get(link.content_key)).toBe("# second attempt");
  expect([...s.r2.values()]).not.toContain("# timed-out first attempt");
  expect(s.db.query("SELECT status,error FROM usage_events WHERE link_id=? ORDER BY rowid").all(id)).toEqual([
    { status: "failed", error: "The attempt timed out before the provider answered." },
    { status: "done", error: null },
  ]);
  expect(lastJob(s, id)).toMatchObject({ status: "done" });
});

test("an adapter that ignores the abort still can't publish a timed-out result: only the accepted attempt is stored", async () => {
  const s = await setup({ placeholder: true });
  ATTEMPT_BUDGET_MS.content = 20;
  let releaseFirst!: (markdown: string) => void;
  const first = new Promise<string>((resolve) => (releaseFirst = resolve));
  fakes.content = [{ wait: first }, { markdown: "# second attempt" }];
  // The abandoned call answers right after the accepted attempt stored its content, before it is saved.
  const content = s.env.CONTENT as unknown as { put: (k: string, v: string, o?: unknown) => Promise<void> };
  const put = content.put;
  content.put = async (k, v, o) => {
    await put(k, v, o);
    if (v === "# second attempt") { releaseFirst("# timed-out first attempt"); await Bun.sleep(5); }
  };
  const id = await save(s, "https://late.example/x");
  await s.runQueued();
  await Bun.sleep(5);
  const link = s.db.query("SELECT content_key,content_state FROM links WHERE id=?").get(id) as any;
  expect(link.content_state).toBe("ready");
  expect(s.r2.get(link.content_key)).toBe("# second attempt");
  expect([...s.r2.values()]).toEqual(["# second attempt"]);
});

test("real web adapter: a successful envelope is saved; an empty one fails fast", async () => {
  const s = await setup({ placeholder: true });
  fakes.browser = envelope(200, { success: true, result: "# Real page" });
  const id = await save(s, PUBLIC_URL);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", err: null });
  fakes.browser = envelope(200, { success: true, result: "  " });
  await reextract(s, id);
  await s.runQueued();
  expect(fakes.calls.browser).toBe(2);
  expect(lastJob(s, id)).toMatchObject({ status: "failed", reason: "empty" });
});

test("a failed preview stays out of Needs attention while Markdown is retrying, including after a reload", async () => {
  const s = await setup({ placeholder: true });
  fakes.meta = { http: 403 };
  fakes.content = [{ throws: "Markdown: HTTP 503" }, { throws: "Markdown: HTTP 503" }];
  const id = await save(s, "https://mixed.example/x");
  let during: Awaited<ReturnType<S["view"]>> | undefined;
  fakes.onContent = async () => {
    if (fakes.calls.content === 2) during = await s.view(id); // view() reloads GET /api/library
  };
  await s.runQueued();
  expect(during).toMatchObject({ status: "failed", preview_reason: "blocked", content: "queued", processing: true, attention: false, job: "running/Extracting content" });
  // Settled: both axes failed for good, with readable reasons.
  expect(await s.view(id)).toMatchObject({ status: "failed", preview_reason: "blocked", content: "failed", content_reason: "site_error", processing: false, attention: true });
});

test("a hanging Markdown call fails inside the attempt at its time budget and is retried once", async () => {
  const s = await setup({ placeholder: true });
  ATTEMPT_BUDGET_MS.content = 20;
  fakes.content = { pending: true };
  const id = await save(s, "https://hang.example/x");
  await s.runQueued();
  expect(fakes.calls.content).toBe(2);
  expect(logs.map((l) => [l.step, l.adapter, l.attempt, l.final, l.reason])).toEqual([["content", "web", 1, false, "timeout"], ["content", "web", 2, true, "timeout"]]);
  expect(await s.view(id)).toMatchObject({ content: "failed", content_reason: "timeout", err: FAILURE_MESSAGES.timeout });
});

test("an attempt ended by the engine's step timeout is still recorded, with the persisted step and attempt", async () => {
  const s = await setup({ placeholder: true });
  ATTEMPT_BUDGET_MS.content = 60_000; // the engine gives up first
  s.engine.timeoutMs = 20;
  fakes.content = { pending: true };
  const id = await save(s, "https://engine.example/x");
  await s.runQueued();
  expect(fakes.calls.content).toBe(2);
  expect(logs.map((l) => [l.step, l.adapter, l.attempt, l.max_attempts, l.final, l.reason])).toEqual([
    ["content", "web", 1, 2, false, "timeout"], // noticed when attempt 2 starts
    ["content", "web", 2, 2, true, "timeout"], // the step's final rejection, from record-failure
  ]);
  expect(lastJob(s, id)).toMatchObject({ status: "failed", reason: "timeout", error: FAILURE_MESSAGES.timeout });
});

test("a long-running attempt shows elapsed time against its budget, also after a reload", async () => {
  const s = await setup({ placeholder: true });
  const id = await save(s, "https://long.example/x");
  const batch = (s.db.query("SELECT batch_id FROM jobs WHERE link_id=?").get(id) as { batch_id: string }).batch_id;
  let shown: string | null = null;
  fakes.onContent = async () => {
    tick(40_000);
    const job = (await s.api(`/batches/${batch}`)).data.jobs[0] as Job; // what Activity polls after a reload
    shown = jobProgress(job).step;
  };
  await s.runQueued();
  expect(shown!).toBe("Extracting content · Attempt 1 of 2 · 40s of 1m 40s");
});

test("a bookkeeping failure after extraction shows the plain reason; the raw error goes only to the logs", async () => {
  const s = await setup({ placeholder: true });
  fakes.failSql = /content_state='ready'/; // the save-content write
  const id = await save(s, "https://busy.example/x");
  await s.runQueued();
  const v = await s.view(id);
  expect(v).toMatchObject({ content: "failed", err: FAILURE_MESSAGES.unknown, content_reason: "unknown" });
  expect(lastJob(s, id)).toMatchObject({ status: "failed", error: FAILURE_MESSAGES.unknown, reason: "unknown" });
  expect(logs.at(-1)).toMatchObject({ final: true, reason: "unknown", adapter: "web" });
  expect(String(logs.at(-1)!.detail)).toContain("SQLITE_BUSY");
});

test("an allowlisted adapter message is kept for users; the appended technical detail is not", async () => {
  const s = await setup({ placeholder: true });
  fakes.discoverError = `${ADAPTER_MESSAGES.instagramLogin} Rendered retry: Rendered post: HTTP 500`;
  const id = await save(s, "https://social.example/p/1");
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "failed", err: ADAPTER_MESSAGES.instagramLogin });
  expect(logs.at(-1)).toMatchObject({ step: "content", adapter: "x", final: true });
  fakes.discoverError = "TypeError: Cannot read properties of undefined (reading 'text')";
  await reextract(s, id);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "failed", err: FAILURE_MESSAGES.unknown });
});
