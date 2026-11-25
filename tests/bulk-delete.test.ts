// FAC-46: bulk delete removes the selected links and everything they own (content and previews in R2, tag
// associations, tag evaluations, lens results, media, hidden related links, pending jobs). Tag definitions stay
// (ADR 0003). A link with a running job is skipped and reported, so in-flight processing can never write
// content for a link that no longer exists. Cross-owner attempts are covered in isolation.test.ts.
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
  expect(res.data.running).toEqual([]);
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

test("pending jobs go with their links and never run afterwards", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/queued");
  const job = s.db.query("SELECT id,status FROM jobs WHERE link_id=?").get(id) as { id: string; status: string };
  expect(job.status).toBe("queued");
  const res = await bulkDelete(s, [id]);
  expect(res.data.deleted).toEqual([id]);
  expect(s.db.query("SELECT 1 FROM jobs WHERE id=?").get(job.id)).toBeNull();
  // The queue message still arrives: nothing runs, nothing is stored, the link does not come back.
  const before = fakes.calls.content;
  await drain(s);
  expect(fakes.calls.content).toBe(before);
  expect(objectsOf(s, id)).toEqual([]);
  expect(s.db.query("SELECT 1 FROM links WHERE id=?").get(id)).toBeNull();
});

test("a link with a running job is skipped and reported; it can be deleted once the job settles", async () => {
  const s = await setup();
  const running = await save(s, "https://example.com/running");
  const idle = await save(s, "https://example.com/idle");
  // Hold the running link's extraction inside its content step.
  let release!: (markdown: string) => void;
  fakes.content = { wait: new Promise<string>((r) => (release = r)) };
  const jobId = s.sent.splice(0).map((m) => m.body.id).find((j) => (s.db.query("SELECT link_id FROM jobs WHERE id=?").get(j) as { link_id: string }).link_id === running)!;
  const before = fakes.calls.content;
  const run = s.runJob(jobId);
  for (let i = 0; i < 200 && fakes.calls.content === before; i++) await Bun.sleep(1);
  expect((s.db.query("SELECT status FROM jobs WHERE id=?").get(jobId) as { status: string }).status).toBe("running");

  const res = await bulkDelete(s, [running, idle]);
  expect(res.status).toBe(200);
  expect(res.data.deleted).toEqual([idle]);
  expect(res.data.running).toEqual([running]);
  expect(res.data.links.map((l: { id: string }) => l.id)).toEqual([running]);

  release("# finished");
  await run;
  const link = s.db.query("SELECT content_key FROM links WHERE id=?").get(running) as { content_key: string };
  expect(s.r2.get(link.content_key)).toBe("# finished");

  const again = await bulkDelete(s, [running]);
  expect(again.data.deleted).toEqual([running]);
  expect(objectsOf(s, running)).toEqual([]);
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
  expect(res.data.running).toEqual([]);
});

test("content a cancelled workflow stores after its link was deleted is removed again", async () => {
  const s = await setup();
  const id = await save(s, "https://example.com/late");
  let release!: (markdown: string) => void;
  fakes.content = { wait: new Promise<string>((r) => (release = r)) };
  const jobId = s.sent.splice(0).map((m) => m.body.id)[0]!;
  const before = fakes.calls.content;
  const run = s.runJob(jobId);
  for (let i = 0; i < 200 && fakes.calls.content === before; i++) await Bun.sleep(1);
  // A terminate that came too late: the workflow carries on after its job was cancelled.
  s.workflows.terminate = "ignore";
  expect((await s.api(`/jobs/${jobId}`, "DELETE")).status).toBe(200);
  expect((await bulkDelete(s, [id])).data.deleted).toEqual([id]);
  release("# late");
  await run;
  expect(objectsOf(s, id)).toEqual([]);
});
