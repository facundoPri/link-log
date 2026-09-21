import { test, expect, spyOn } from "bun:test";
import { judge } from "../worker/ai/jev";
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
    },
  } as unknown as Env;
  return { env, writes };
}
test("full context above the former byte limit reaches the provider unchanged", async () => {
  const state = {
    content:
      "Artificial intelligence and dispositivos IoT. ".repeat(1000) +
      "Final evidence: sensores.",
  };
  let sent: unknown;
  const mock = spyOn(fetchTarget, "fetch").mockImplementation(
    async (_url, options) => {
      sent = JSON.parse(options!.body as string);
      return Response.json({
        model: "jev-fixture",
        answers: { topic: { type: "noul", noul: 0.93 } },
        usage: { input_tokens: 11000, output_tokens: 20 },
      });
    },
  );
  try {
    const { env, writes } = environment();
    const result = await judge(env, state, questions, job);
    expect(
      new TextEncoder().encode(JSON.stringify(state)).length,
    ).toBeGreaterThan(28000);
    expect(sent).toEqual({ model: "jev-latest", state, questions });
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
test("actual provider token limit is reported without silently truncating or retrying", async () => {
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
    ).rejects.toThrow("ventana de tokens");
    expect(calls).toBe(1);
    expect(writes.at(-1)?.[0]).toBe("failed");
  } finally {
    mock.mockRestore();
  }
});
