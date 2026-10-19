import { afterEach, expect, spyOn, test } from "bun:test";
import { fakes, resetClock, setup } from "./worker-harness";
import * as metadata from "../worker/metadata";
import { canUsePreview } from "../worker/preview-content";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { displayMetadataStatement } from "../worker/display-metadata";
import { metadataText } from "../src/metadata-text";
const fetchTarget: { fetch: (...args: Parameters<typeof fetch>) => Promise<Response> } = globalThis;
const realExtractMetadata = metadata.extractMetadata;
const mocks: { mockRestore(): void }[] = [];
afterEach(() => { mocks.splice(0).forEach(m => m.mockRestore()); resetClock(); });

for (const title of ["example.com", "https://example.com/path", "YouTube video", "Instagram post", "Instagram reel", "X post", ""]) {
  test(`automatic fallback refuses placeholder ${JSON.stringify(title)} but accepts a real description`, async () => {
    expect(metadataText({ title, domain: "example.com" })).toBe("");
    const s = await setup();
    fakes.meta = { status: "ready", title };
    fakes.content = { throws: "HTTP 404" };
    const { id } = (await s.api("/links", "POST", { url: "https://example.com/path" })).data;
    await s.runQueued();
    expect(await s.view(id)).toMatchObject({ content: "failed", attention_kind: "content" });
    (s.env as any).ALLOW_FIXTURE_JEV = "1";
    await s.api("/tags", "POST", { name: "topic" });
    expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.skipped).toEqual([id]);
    expect(s.db.query("SELECT count(*) n FROM usage_events WHERE service='jev'").get()).toEqual({ n: 0 });
    fakes.meta = { status: "ready", title, description: "Actual description." };
    await s.api("/batches", "POST", { kind: "extract", ids: [id] });
    await s.runQueued();
    expect((await s.api(`/links/${id}/content`)).data.markdown).toBe("Actual description.");
    expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
    await s.runQueued();
    expect((await s.api("/library")).data.links[0].metadata_evaluated).toBe(1);
  });
}

test("the real metadata 503 envelope causes three attempts and never publishes ready", async () => {
  const s = await setup();
  mocks.push(spyOn(metadata, "extractMetadata").mockImplementation(realExtractMetadata));
  let requests = 0;
  mocks.push(spyOn(fetchTarget, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("dns-query")) return Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] });
    requests++; return new Response("Unavailable", { status: 503 });
  }));
  const { id } = (await s.api("/links", "POST", { url: "https://example.com/unavailable" })).data;
  await s.runQueued();
  expect(requests).toBe(3);
  expect(await s.view(id)).toMatchObject({ status: "failed", preview_reason: "site_error" });
});

for (const [name, response, retryable] of [
  ["NXDOMAIN", { Status: 3 }, false],
  ["empty", { Status: 0, Answer: [] }, true],
  ["SERVFAIL", { Status: 2 }, true],
] as const) test(`DNS ${name} has the agreed retry policy`, async () => {
  mocks.push(spyOn(fetchTarget, "fetch").mockImplementation(async () => Response.json(response)));
  await expect(metadata.validateDestination(new URL("https://example.com"), AbortSignal.timeout(100))).rejects.toMatchObject({ reason: "unreachable", retryable });
});

test("DNS timeout retries; private answers and unsupported ports fail fast", async () => {
  const mock = spyOn(fetchTarget, "fetch").mockImplementation(async () => { throw new DOMException("Timed out", "TimeoutError"); }); mocks.push(mock);
  const { classify } = await import("../worker/failures");
  try { await metadata.validateDestination(new URL("https://example.com"), AbortSignal.timeout(100)); } catch (e) { expect(classify(e)).toMatchObject({ reason: "timeout", retryable: true }); }
  mock.mockImplementation(async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "127.0.0.1" }] }));
  for (const url of ["https://example.com", "https://example.com:8080"]) {
    let error: unknown; try { await metadata.validateDestination(new URL(url), AbortSignal.timeout(100)); } catch (e) { error = e; }
    expect(classify(error).retryable).toBe(false);
  }
});

test("batch cancellation drops a running extraction waiting for capacity and its Jev dependents", async () => {
  const s = await setup();
  (s.env as any).ALLOW_FIXTURE_JEV = "1";
  await s.api("/tags", "POST", { name: "topic" });
  const added = (await s.api("/links", "POST", { url: "https://example.com/wait" })).data;
  const id = added.id, batch = added.batches[0].id;
  const job = s.sent[0]!.body.id;
  s.db.query("UPDATE jobs SET status='running',step='Waiting for Browser slot' WHERE id=?").run(job);
  await s.api("/batches", "POST", { kind: "autotag", ids: [id] });
  expect((await s.api(`/batches/${batch}`, "DELETE")).data).toMatchObject({ cancelled: 1, dependents: 1 });
  expect(s.db.query("SELECT count(*) n FROM jobs WHERE status IN ('queued','running','waiting')").get()).toEqual({ n: 0 });
  await s.runQueued();
  expect(fakes.calls.content).toBe(0);
  expect(s.db.query("SELECT count(*) n FROM provider_leases").get()).toEqual({ n: 0 });
  expect(await s.view(id)).toMatchObject({ attention: false, content: "missing" });
});

test("new private recovery endpoints are isolated between authenticated A/B accounts", async () => {
  const db = await TestD1.migrated(), { env } = makeEnv(db);
  const a = await testSession(env, "a@example.test"), b = await testSession(env, "b@example.test"), call = client(env);
  const saved = await (await call("/api/links", { cookie: a.cookie, body: { url: "https://example.com/private" } })).json() as any;
  const job = db.sqlite.query("SELECT id FROM jobs").get() as { id: string };
  for (const [path, method, body] of [
    [`/links/${saved.id}/retry`, "POST", { step: "content" }], [`/links/${saved.id}/use-preview`, "POST", {}], [`/links/${saved.id}/dismiss`, "POST", {}],
    [`/jobs/${job.id}`, "DELETE", {}], [`/batches/${saved.batches[0].id}`, "DELETE", {}], [`/batches/${saved.batches[0].id}/retry`, "POST", {}],
  ] as const) expect((await call(`/api${path}`, { cookie: b.cookie, method, body })).status).toBe(404);
  expect(db.sqlite.query("SELECT status FROM jobs").get()).toEqual({ status: "queued" });
  expect((await (await call("/api/library", { cookie: b.cookie })).json() as any).links).toEqual([]);
});

test("fresh schema and upgrade from shipped main preserve owned data and all lifecycle columns", async () => {
  for (const upgrade of [false, true]) {
    const db = await TestD1.migrated(upgrade ? "0017" : undefined);
    db.sqlite.exec("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES('a','A','a@example.test',1,'t','t'); INSERT INTO links(id,user_id,original_url,url,domain,title,description,image,content_key,created_at) VALUES('l','a','https://example.com','https://example.com','example.com','A useful article','Saved description','https://example.com/a.png','users/a/links/l/a.md','t'); INSERT INTO batches(id,user_id,kind,config,created_at) VALUES('b','a','extract','{}','t'); INSERT INTO jobs(id,batch_id,link_id,status,created_at) VALUES('j','b','l','running','t')");
    if (upgrade) await db.migrate(undefined, "0017");
    expect(db.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.sqlite.query("SELECT user_id,title,content_key FROM links").get()).toEqual({ user_id: "a", title: "A useful article", content_key: "users/a/links/l/a.md" });
    for (const col of ["reason", "attempt", "jev_call", "jev_outcome", "content_source"]) expect((db.sqlite.query("PRAGMA table_info(jobs)").all() as any[]).some(r => r.name === col)).toBe(true);
    // Explicit metadata is primary. This fresh fixture models a legacy real title.
    if (!upgrade) db.sqlite.exec("UPDATE links SET title='A useful article',title_source='metadata'");
    await displayMetadataStatement(db.d1, "a", "l", "j", { title: "Other heading", image: "https://example.com/b.png" }, "https://example.com").run();
    expect(db.sqlite.query("SELECT title,description,image FROM links").get()).toEqual({ title: "A useful article", description: "Saved description", image: "https://example.com/a.png" });
    db.sqlite.exec("UPDATE links SET title='example.com',title_source='placeholder',description='',image=NULL");
    await displayMetadataStatement(db.d1, "a", "l", "j", { title: "Real heading", image: "https://example.com/first.png" }, "https://example.com").run();
    expect(db.sqlite.query("SELECT title,title_source,description,image FROM links").get()).toEqual({ title: "Real heading", title_source: "extraction", description: "", image: "https://example.com/first.png" });
  }
});

test("image-only metadata never becomes Jev content", () => {
  expect(canUsePreview({ status: "ready", title: "example.com", domain: "example.com", title_source: "placeholder", description: "", content_key: null, user_id: "a" })).toBe(false);
});
