// FAC-56: when the content fails for good and the preview worked, the title and description can stand in
// for the content automatically, or explicitly after a failed fallback storage operation.
import { afterEach, expect, spyOn, test } from "bun:test";
import { dispatch, fakes, resetClock, setup, tick } from "./worker-harness";

afterEach(resetClock);

type S = Awaited<ReturnType<typeof setup>>;
const save = async (s: S, url: string) => (await s.api("/links", "POST", { url })).data.id as string;
const linkOf = async (s: S, id: string) => (await s.api("/library")).data.links.find((l: { id: string }) => l.id === id);
const contentOf = async (s: S, id: string) => (await s.api(`/links/${id}/content`)).data.markdown as string;
const lastJob = (s: S, id: string) =>
  s.db.query("SELECT status,step,reason,error FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as Record<string, string>;
const fallbackView = async (s: S, id: string) => {
  const l = await linkOf(s, id);
  return { source: l.content_source, content: l.content_state, attention: l.attention_kind, reason: l.content_reason, has_key: !!l.content_key };
};

// Autotag with a real provider request captured, to check exactly what Jev receives.
async function autotag(s: S, id: string) {
  const env = s.env as any;
  env.JEV_PROVIDER = "typesafe";
  env.TYPESAFE_API_KEY = "test-only";
  let sent: any;
  const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => Promise<Response> } = globalThis;
  const mock = spyOn(fetchTarget, "fetch").mockImplementation(async (_url, options) => {
    sent = JSON.parse(options!.body as string);
    return Response.json({ model: "jev-fixture", answers: Object.fromEntries(Object.keys(sent.questions).map((k) => [k, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 10, output_tokens: 2 } });
  });
  try {
    await s.api("/tags", "POST", { name: "topic" });
    const res = await s.api("/batches", "POST", { kind: "autotag", ids: [id] });
    expect(res.status).toBe(200);
    await s.runQueued();
  } finally {
    mock.mockRestore();
  }
  return sent;
}

test("automatic: a final content failure with a preview gets the preview as content, is auto-taggable and not in Needs attention", async () => {
  const s = await setup();
  expect((await s.api("/library")).data.settings).toBeUndefined();
  expect((await s.api("/settings", "PUT", { preview_fallback: false })).status).toBe(404);
  fakes.meta = { status: "ready", description: "What the page is about." };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/a");
  await s.runQueued();

  expect(await fallbackView(s, id)).toEqual({ source: "preview", content: "partial", attention: null, reason: "not_found", has_key: true });
  expect((await s.view(id)).attention).toBe(false);
  expect(await contentOf(s, id)).toBe("Title of fb.example\n\nWhat the page is about.");
  // Activity keeps the original failure and notes the preview was used.
  expect(lastJob(s, id)).toMatchObject({ status: "failed", step: "Used the preview", reason: "not_found" });

  const sent = await autotag(s, id);
  expect(sent.state.content).toBe("Title of fb.example\n\nWhat the page is about.");
  expect(JSON.stringify(sent)).not.toContain("from preview");
  expect(lastJob(s, id)).toMatchObject({ status: "done" });
  expect(s.db.query("SELECT count(*) n FROM tag_evaluations WHERE link_id=?").get(id)).toMatchObject({ n: 1 });
});

test("automatic: never applied while retrying; a transient failure that recovers keeps the real content", async () => {
  const s = await setup();
  fakes.content = [{ throws: "Markdown: HTTP 503" }, { markdown: "# real" }];
  const id = await save(s, "https://fb.example/transient");
  const during: unknown[] = [];
  fakes.onContent = async () => void during.push(await fallbackView(s, id));
  await s.runQueued();
  expect(fakes.calls.content).toBe(2);
  for (const v of during) expect(v).toMatchObject({ source: null, has_key: false, attention: null });
  expect(await fallbackView(s, id)).toMatchObject({ source: "web", content: "ready", attention: null });
  expect(await contentOf(s, id)).toBe("# real");
});

test("automatic: when the preview also failed there is nothing to use and the link enters Needs attention", async () => {
  const s = await setup();
  fakes.meta = { status: "failed" };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/both");
  await s.runQueued();
  expect(await fallbackView(s, id)).toEqual({ source: null, content: "failed", attention: "content", reason: "not_found", has_key: false });
  expect(lastJob(s, id).step).toBe("Needs attention");
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("There is no preview to use.");
});

test("automatic: a failed re-extract with previous content keeps that content, not the preview", async () => {
  const s = await setup();
  const id = await save(s, "https://fb.example/kept");
  await s.runQueued();
  fakes.content = { throws: "Markdown: HTTP 404" };
  await s.api("/batches", "POST", { kind: "extract", ids: [id] });
  await s.runQueued();
  expect(await fallbackView(s, id)).toMatchObject({ source: "web", content: "ready", attention: null });
  expect(await contentOf(s, id)).toBe("# page");
});

test("if storing the automatic fallback fails, explicit recovery can save it later", async () => {
  const s = await setup();
  fakes.meta = { status: "ready", description: "Summary." };
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/manual");
  failingPuts(s, 3); // automatic fallback exhausted storage retries
  await s.runQueued();
  expect(await fallbackView(s, id)).toEqual({ source: null, content: "failed", attention: "content", reason: "not_found", has_key: false });
  expect(lastJob(s, id).step).toBe("Needs attention");

  // Never while a job is queued or running.
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("Wait for the running job to finish.");
  failingPuts(s, 3);
  await s.runQueued();

  const used = await s.api(`/links/${id}/use-preview`, "POST");
  expect(used.status).toBe(200);
  expect(await fallbackView(s, id)).toEqual({ source: "preview", content: "partial", attention: null, reason: "not_found", has_key: true });
  expect((await s.view(id)).attention).toBe(false);
  expect(await contentOf(s, id)).toBe("Title of fb.example\n\nSummary.");
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("This link already has content.");

  const sent = await autotag(s, id);
  expect(sent.state.content).toBe("Title of fb.example\n\nSummary.");
});

test("Retry getting content replaces the preview text on success; a failed retry keeps it without Needs attention", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/retry");
  await s.runQueued();
  expect(await fallbackView(s, id)).toMatchObject({ source: "preview", content: "partial", attention: null });

  // A retry that fails again keeps the preview text; the link stays out of the list.
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  expect(await fallbackView(s, id)).toMatchObject({ source: "preview", content: "queued", attention: null });
  await s.runQueued();
  expect(await fallbackView(s, id)).toMatchObject({ source: "preview", content: "partial", attention: null });
  expect(await contentOf(s, id)).toBe("Title of fb.example");

  // A cancelled retry goes back to the preview text, still partial.
  const { batchId } = (await s.api(`/links/${id}/retry`, "POST", { step: "content" })).data;
  s.sent.splice(0);
  await s.api(`/batches/${batchId}`, "DELETE");
  expect(await fallbackView(s, id)).toMatchObject({ source: "preview", content: "partial", attention: null });

  fakes.content = { markdown: "# the real page" };
  tick(1_000);
  await s.api(`/links/${id}/retry`, "POST", { step: "content" });
  await s.runQueued();
  expect(await fallbackView(s, id)).toEqual({ source: "web", content: "ready", attention: null, reason: null, has_key: true });
  expect((await linkOf(s, id)).content_error).toBeNull();
  expect(await contentOf(s, id)).toBe("# the real page");
});

test("changing metadata while failure settles refuses stale fallback text atomically", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/race");
  let raced = false;
  fakes.onSql = async (sql, phase) => {
    if (raced || phase !== "write" || !sql.includes("content_source='preview'")) return;
    raced = true;
    fakes.onSql = undefined;
    s.db.query("UPDATE links SET title='New title' WHERE id=?").run(id);
  };
  await s.runQueued();
  expect(raced).toBe(true);
  expect(await fallbackView(s, id)).toEqual({ source: null, content: "failed", attention: "content", reason: "not_found", has_key: false });
  expect(lastJob(s, id)).toMatchObject({ status: "failed", step: "Needs attention" });
  // The preview text stored for it is removed, not left in R2 without a reference.
  expect([...s.r2.keys()].filter((k) => k.endsWith("-preview.md"))).toEqual([]);
});

test("a repeated record-failure after a D1 fault applies the preview exactly once", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/replay");
  fakes.failSqlOnce = /UPDATE jobs SET status='failed'/;
  await s.runQueued();
  expect(s.steps.find((x) => x.name === "record-failure")?.attempts).toBe(2);
  expect(await fallbackView(s, id)).toMatchObject({ source: "preview", content: "partial", attention: null });
  expect((await linkOf(s, id)).content_version).toBe(1);
  expect(lastJob(s, id)).toMatchObject({ status: "failed", step: "Used the preview" });
  // The replayed settlement doesn't remove the object the link now uses.
  expect(s.r2.get((await linkOf(s, id)).content_key)).toBe("Title of fb.example");
});

test("a cancelled or interrupted job never applies the preview", async () => {
  const s = await setup();
  const imp = await s.api("/import", "POST", { urls: ["https://fb.example/cancel"] });
  const id = imp.data.links[0].id;
  s.sent.splice(0);
  await s.api(`/batches/${imp.data.batches[0].id}`, "DELETE");
  expect(await fallbackView(s, id)).toMatchObject({ source: null, has_key: false, attention: null });
});

test("pasting text over the preview text makes it ordinary manual content", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/paste");
  await s.runQueued();
  await s.api(`/links/${id}/content`, "PUT", { markdown: "pasted" });
  expect(await fallbackView(s, id)).toMatchObject({ source: "manual", content: "ready", attention: null });
});

test("the per-link action loses to a job enqueued between its check and its write", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/action-race");
  failingPuts(s, 3); // automatic fallback exhausted storage retries
  await s.runQueued();
  fakes.onSql = async (sql, phase) => {
    if (phase !== "write" || !sql.includes("content_source='preview'")) return;
    fakes.onSql = undefined;
    expect((await s.api(`/links/${id}/retry`, "POST", { step: "content" })).status).toBe(200);
  };
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("The link changed meanwhile. Try again.");
  expect(await fallbackView(s, id)).toMatchObject({ source: null, content: "queued", attention: "content", has_key: false });
});

// Round 2: storing the optional fallback can fail; the original failure must still settle.
const failingPuts = (s: S, failures: number) => {
  const content = (s.env as any).CONTENT;
  const put = content.put;
  const calls = { n: 0 };
  content.put = async (...a: unknown[]) => {
    calls.n++;
    if (failures-- > 0) throw new Error("R2 temporarily unavailable");
    return put(...a);
  };
  return calls;
};

test("a fallback write that fails once is retried and the preview is used", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/r2-once");
  const calls = failingPuts(s, 1);
  await s.runQueued();
  expect(calls.n).toBe(2);
  expect(s.steps.find((x) => x.name === "record-failure")?.attempts).toBe(1);
  expect(await fallbackView(s, id)).toMatchObject({ source: "preview", content: "partial", attention: null });
  expect(lastJob(s, id)).toMatchObject({ status: "failed", step: "Used the preview", reason: "not_found" });
});

test("when the fallback can't be stored, the original content failure still settles atomically", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/r2-down");
  const calls = failingPuts(s, Infinity);
  await s.runQueued();
  expect(calls.n).toBe(3);
  expect(s.steps.find((x) => x.name === "record-failure")?.attempts).toBe(1);
  const settled = await s.view(id);
  expect(settled).toMatchObject({ content: "failed", attention: true, attention_kind: "content", attention_reason: "not_found", content_reason: "not_found", processing: false, job: "failed/Needs attention" });
  expect(settled.err).toBeString();
  expect(lastJob(s, id)).toMatchObject({ status: "failed", reason: "not_found", error: settled.err });
  expect((await fallbackView(s, id)).has_key).toBe(false);

  // A late redelivery of the settled job (errored instance) changes nothing.
  const job = s.db.query("SELECT id FROM jobs WHERE link_id=?").get(id) as { id: string };
  (s.env as any).PROCESS_LINK = {
    create: async () => { throw new Error("instance already exists"); },
    get: async () => ({ status: async () => ({ status: "errored" }) }),
  };
  await dispatch({ messages: [{ body: { id: job.id }, ack() {}, retry() {} }] } as never, s.env);
  expect(await s.view(id)).toEqual(settled);
});

test("Use preview needs a final content failure on record: refused for never-failed links, allowed for failed and dismissed ones", async () => {
  const s = await setup();
  // Never failed: import cancelled, then only the preview fetched.
  const imp = await s.api("/import", "POST", { urls: ["https://fb.example/neutral"] });
  const neutral = imp.data.links[0].id;
  s.sent.splice(0);
  await s.api(`/batches/${imp.data.batches[0].id}`, "DELETE");
  await s.api(`/links/${neutral}/retry`, "POST");
  await s.runQueued();
  expect(fakes.calls.content).toBe(0);
  expect(await fallbackView(s, neutral)).toMatchObject({ content: "missing", has_key: false, attention: null });
  expect((await s.api(`/links/${neutral}/use-preview`, "POST")).data.error).toBe("The content hasn't failed; extract it first.");

  // Interrupted extraction: back to neutral, still not eligible.
  await s.api("/batches", "POST", { kind: "extract", ids: [neutral] });
  const [msg] = s.sent.splice(0);
  (s.env as any).PROCESS_LINK = {
    create: async () => { throw new Error("instance already exists"); },
    get: async () => ({ status: async () => ({ status: "errored" }) }),
  };
  await dispatch({ messages: [{ body: msg!.body, ack() {}, retry() {} }] } as never, s.env);
  expect(await fallbackView(s, neutral)).toMatchObject({ content: "missing", has_key: false });
  expect((await s.api(`/links/${neutral}/use-preview`, "POST")).status).toBe(400);
  expect((await fallbackView(s, neutral)).source).toBeNull();

  // Failed for good: allowed.
  fakes.content = { throws: "Markdown: HTTP 404" };
  const failed = await save(s, "https://fb.example/failed");
  failingPuts(s, 3); // automatic fallback exhausted storage retries
  await s.runQueued();
  expect((await s.api(`/links/${failed}/use-preview`, "POST")).status).toBe(200);
  expect(await fallbackView(s, failed)).toMatchObject({ source: "preview", attention: null });

  // Failed and dismissed: Dismiss keeps the content failure, so it stays eligible.
  const dismissed = await save(s, "https://fb.example/dismissed");
  failingPuts(s, 3); // automatic fallback exhausted storage retries
  await s.runQueued();
  await s.api(`/links/${dismissed}/dismiss`, "POST");
  expect(await fallbackView(s, dismissed)).toMatchObject({ content: "failed", attention: null });
  expect((await s.api(`/links/${dismissed}/use-preview`, "POST")).status).toBe(200);
  expect(await fallbackView(s, dismissed)).toMatchObject({ source: "preview", content: "partial", attention: null });
});

test("Use preview re-checks the content failure in its write", async () => {
  const s = await setup();
  fakes.content = { throws: "Markdown: HTTP 404" };
  const id = await save(s, "https://fb.example/eligibility-race");
  failingPuts(s, 3); // automatic fallback exhausted storage retries
  await s.runQueued();
  fakes.onSql = async (sql, phase) => {
    if (phase !== "write" || !sql.includes("content_source='preview'")) return;
    fakes.onSql = undefined;
    s.db.query("UPDATE links SET content_state='missing' WHERE id=?").run(id);
  };
  expect((await s.api(`/links/${id}/use-preview`, "POST")).data.error).toBe("The link changed meanwhile. Try again.");
  expect((await fallbackView(s, id)).source).toBeNull();
});
