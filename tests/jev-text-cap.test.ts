// FAC-220: only the text sent to Jev is capped. Stored content (R2) is never changed.
import { afterEach, expect, test } from "bun:test";
import { resetClock, setup, fakes } from "./worker-harness";
import { judge, MAX_JEV_TEXT_CHARS } from "../worker/ai/jev";
import { FIXTURE_JEV_WINDOW_CHARS } from "../worker/ai/fixture";
import { JEV_FAILURE_MESSAGES } from "../src/failures";

afterEach(resetClock);
const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

type Sent = { state: { url: string; title: string; description?: string; content: string }; questions: Record<string, unknown> };
function recordJev() {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    return Response.json({
      model: "jev-test",
      answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: 0.9 }])),
      usage: { input_tokens: 100, output_tokens: 5 },
    });
  }) as typeof fetch;
  return sent;
}
const longPage = "HEAD-MARKER " + "A paragraph of a very long page. ".repeat(10_000) + "TAIL-MARKER";

async function savedLongLink() {
  const s = await setup();
  fakes.meta = { status: "ready", description: "DESCRIPTION-MARKER summary" };
  fakes.content = { markdown: longPage };
  const id = (await s.api("/links", "POST", { url: "https://long.example/page" })).data.id as string;
  await s.runQueued();
  Object.assign(s.env as object, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  const key = (s.db.query("SELECT content_key k FROM links WHERE id=?").get(id) as { k: string }).k;
  return { s, id, key };
}
const textLength = (state: Sent["state"]) => (state.description?.length ?? 0) + state.content.length;

test("a lens on a long page sends description then the page beginning, within the cap, and leaves the saved document whole", async () => {
  const { s, id, key } = await savedLongLink();
  expect(s.r2.get(key)).toBe(longPage);
  const sent = recordJev();
  const lens = (await s.api("/lenses", "POST", { name: "Useful", type: "noul", question: "Is it useful?", threshold: 0.8 })).data.lenses[0];
  const batch = (await s.api("/batches", "POST", { kind: "lens", ids: [id], lensId: lens.id })).data.batchId;
  await s.runQueued();
  expect(s.db.query("SELECT status,reason FROM jobs WHERE batch_id=?").all(batch)).toEqual([{ status: "done", reason: null }]);
  expect(sent).toHaveLength(1);
  const state = sent[0]!.state;
  expect(state.description).toBe("DESCRIPTION-MARKER summary");
  expect(state.content.startsWith("HEAD-MARKER")).toBe(true);
  expect(textLength(state)).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
  expect(JSON.stringify(sent[0])).not.toContain("TAIL-MARKER");
  expect(Object.keys(state).indexOf("description")).toBeLessThan(Object.keys(state).indexOf("content"));
  expect(s.r2.get(key)).toBe(longPage);
  expect(s.r2.get(key)).toContain("TAIL-MARKER");
});

test("auto-tag sends the link description too, and a short page reaches Jev whole", async () => {
  const s = await setup();
  fakes.meta = { status: "ready", description: "A short summary" };
  fakes.content = { markdown: "# Short page\n\nSmall body." };
  const id = (await s.api("/links", "POST", { url: "https://short.example/page" })).data.id as string;
  await s.runQueued();
  await s.api("/tags", "POST", { name: "topic" });
  Object.assign(s.env as object, { JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: "test-only" });
  const sent = recordJev();
  await s.api("/batches", "POST", { kind: "autotag", ids: [id] });
  await s.runQueued();
  expect(sent).toHaveLength(1);
  expect(sent[0]!.state).toEqual({
    url: "https://short.example/page",
    title: "Title of short.example",
    description: "A short summary",
    content: "# Short page\n\nSmall body.",
  });
});

test("the fixture provider enforces its window: a state the cap cannot shrink fails with too_long", async () => {
  const writes: unknown[][] = [];
  const env = {
    JEV_PROVIDER: "fixture",
    ALLOW_FIXTURE_JEV: "1",
    APP_ENV: "test",
    DB: {
      prepare: () => ({
        bind: (...values: unknown[]) => ({ run: async () => void writes.push(values), first: async () => null }),
        first: async () => null,
      }),
      batch: async (list: unknown[]) => list.map(() => ({ meta: { changes: 1 } })),
    },
  } as unknown as Env;
  const job = { id: "job", batch_id: "batch", link_id: "link" };
  const questions = { topic: { type: "noul" as const, instructions: "Is it AI?", criteria: { true: "AI", false: "Other" } } };
  // The cap covers description and content only, so a huge side field still reaches the provider whole.
  const oversized = { content: "short", facts: { note: "x".repeat(FIXTURE_JEV_WINDOW_CHARS + 1) } };
  await expect(judge(env, oversized, questions, job)).rejects.toMatchObject({
    reason: "too_long",
    message: JEV_FAILURE_MESSAGES.too_long,
  });
  // The same page capped by judge() is answered.
  expect((await judge(env, { content: "x".repeat(MAX_JEV_TEXT_CHARS * 20) }, questions, { ...job, id: "job2" })).model).toBe("fixture/jev");
});
