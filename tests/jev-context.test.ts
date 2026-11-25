import { test, expect, spyOn } from "bun:test";
import { judge, MAX_JEV_TEXT_CHARS } from "../worker/ai/jev";
const fetchTarget: {
  fetch: (...args: Parameters<typeof fetch>) => Promise<Response>;
} = globalThis;
const questions = {
  topic: {
    type: "noul" as const,
    instructions: "Does the document discuss AI?",
    criteria: { true: "AI", false: "Other" },
  },
};
const job = { id: "job", batch_id: "batch", link_id: "link" };
function environment() {
  const writes: unknown[][] = [];
  const env = {
    JEV_PROVIDER: "typesafe",
    TYPESAFE_API_KEY: "test-only",
    DB: {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            writes.push(values);
          },
          first: async () => null,
        }),
        first: async () => null,
      }),
      // The claim and its usage row: one transaction that authorizes the call.
      batch: async (list: unknown[]) => list.map(() => ({ meta: { changes: 1 } })),
    },
  } as unknown as Env;
  return { env, writes };
}
function recordRequest() {
  const sent: { body?: { model: string; questions: typeof questions; state: { description?: string; content: string } } } = {};
  const mock = spyOn(fetchTarget, "fetch").mockImplementation(
    async (_url, options) => {
      sent.body = JSON.parse(options!.body as string);
      return Response.json({
        model: "jev-fixture",
        answers: { topic: { type: "noul", noul: 0.93 } },
        usage: { input_tokens: 11000, output_tokens: 20 },
      });
    },
  );
  return { sent, mock };
}
test("a state under the cap reaches the provider byte-identical", async () => {
  const state = {
    description: "About AI.",
    content:
      "Artificial intelligence and dispositivos IoT. ".repeat(400) +
      "Final evidence: sensores.",
  };
  const { sent, mock } = recordRequest();
  try {
    const { env, writes } = environment();
    const result = await judge(env, state, questions, job);
    expect(sent.body).toEqual({ model: "jev-1.13.0", state, questions });
    expect(result.answers.topic).toEqual({ type: "noul", noul: 0.93 });
    expect(writes.at(-1)?.slice(0, 4)).toEqual([
      "done",
      "jev-fixture",
      11000,
      20,
    ]);
  } finally {
    mock.mockRestore();
  }
});
test("a state far over the cap is sent capped from the beginning, without touching the caller's object", async () => {
  const state = {
    url: "https://example.com",
    description: "DESCRIPTION-MARKER summary",
    content: "HEAD-MARKER " + "body ".repeat(40_000) + "TAIL-MARKER",
  };
  const original = structuredClone(state);
  const { sent, mock } = recordRequest();
  try {
    const { env } = environment();
    await judge(env, state, questions, job);
    const text = sent.body!.state;
    expect((text.description?.length ?? 0) + text.content.length).toBeLessThanOrEqual(MAX_JEV_TEXT_CHARS);
    expect(text.description).toBe(state.description);
    expect(text.content.startsWith("HEAD-MARKER body")).toBe(true);
    expect(JSON.stringify(sent.body)).not.toContain("TAIL-MARKER");
    expect(Object.keys(text).indexOf("description")).toBeLessThan(Object.keys(text).indexOf("content"));
    expect(state).toEqual(original);
  } finally {
    mock.mockRestore();
  }
});
test("a provider token-limit refusal is reported once and not retried", async () => {
  let calls = 0;
  const mock = spyOn(fetchTarget, "fetch").mockImplementation(async () => {
    calls++;
    return Response.json(
      { detail: "state exceeds maximum context length of 32000 tokens" },
      { status: 422 },
    );
  });
  try {
    const { env, writes } = environment();
    await expect(
      judge(env, { content: "a".repeat(140000) }, questions, job),
    ).rejects.toThrow("token window");
    expect(calls).toBe(1);
    expect(writes.at(-1)?.[0]).toBe("failed");
  } finally {
    mock.mockRestore();
  }
});
