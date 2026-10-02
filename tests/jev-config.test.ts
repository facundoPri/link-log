// FAC-52 regression tests for repro scenario J (planning/research/needs-attention.repro.ts):
// without Jev configured, auto-tag and lens runs are refused before any job, workflow or usage row.
import { afterEach, expect, test } from "bun:test";
import { jevUnavailable } from "../src/attention";
import { resetClock, setup } from "./worker-harness";

afterEach(resetClock);

async function readyLink() {
  const s = await setup();
  const id = (await s.api("/links", "POST", { url: "https://j.example/x" })).data.id;
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data
    .lenses[0];
  const env = s.env as any;
  env.JEV_PROVIDER = "typesafe";
  delete env.TYPESAFE_API_KEY;
  const count = (table: string) => (s.db.query(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  const before = { batches: count("batches"), jobs: count("jobs") };
  return { s, id, lens, count, before };
}

function countFetches() {
  const realFetch = globalThis.fetch;
  const calls = { n: 0 };
  globalThis.fetch = (async (...a: Parameters<typeof fetch>) => {
    calls.n++;
    return realFetch(...a);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = realFetch) };
}

test("J: without TYPESAFE_API_KEY, auto-tag and lens are refused up front with a plain reason", async () => {
  const { s, id, lens, count, before } = await readyLink();
  const lib = (await s.api("/library")).data;
  expect(lib.capabilities).toMatchObject({ provider: "typesafe", jev: false });
  expect(jevUnavailable(lib.capabilities)).toBe("Jev is not configured: API key missing.");
  for (const body of [{ kind: "autotag", ids: [id] }, { kind: "lens", ids: [id], lensId: lens.id }]) {
    const res = await s.api("/batches", "POST", body);
    expect(res).toEqual({ status: 400, data: { error: "Jev is not configured: API key missing." } });
  }
  expect({ batches: count("batches"), jobs: count("jobs") }).toEqual(before);
  expect(count("usage_events")).toBe(0);
  expect(s.sent).toHaveLength(0);
  expect(await s.view(id)).toMatchObject({ status: "ready", processing: false, attention: false });
});

test("J: extraction does not need Jev and is still accepted", async () => {
  const { s, id } = await readyLink();
  expect((await s.api("/batches", "POST", { kind: "extract", ids: [id] })).status).toBe(200);
  await s.runQueued();
  expect(await s.view(id)).toMatchObject({ content: "ready", job: "done/Done" });
});

test("J: a key removed after enqueue fails the job before Usage records anything or the provider is called", async () => {
  const { s, id, count } = await readyLink();
  (s.env as any).TYPESAFE_API_KEY = "test-only";
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
  delete (s.env as any).TYPESAFE_API_KEY;
  const fetches = countFetches();
  try {
    await s.runQueued();
  } finally {
    fetches.restore();
  }
  const job = s.db.query("SELECT j.status,j.error FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE b.kind='autotag'").get();
  expect(job).toEqual({ status: "failed", error: "Jev is not configured: API key missing." });
  expect(count("usage_events")).toBe(0);
  expect(fetches.calls.n).toBe(0);
  expect((await s.view(id)).attention).toBe(false);
});

test("an unconfigured fixture or Workers AI provider is refused too", async () => {
  const { s, id } = await readyLink();
  const env = s.env as any;
  env.JEV_PROVIDER = "fixture";
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.error).toBe("Jev is not configured.");
  env.JEV_PROVIDER = "cloudflare";
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).data.error).toBe("Jev is not configured.");
  env.JEV_PROVIDER = "fixture";
  env.ALLOW_FIXTURE_JEV = "1";
  expect((await s.api("/batches", "POST", { kind: "autotag", ids: [id] })).status).toBe(200);
});
