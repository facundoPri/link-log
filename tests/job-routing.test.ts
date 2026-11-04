import { expect, test } from "bun:test";
import { Glob } from "bun";
import wrangler from "../wrangler.jsonc";
import { isJevQueue, sendJobs, type BatchKind } from "../worker/job-routing";

const kinds: BatchKind[] = ["extract", "preview", "lens", "autotag", "query", "browser-lens", "browser-autogroup"];

test("lens, auto-tag and query jobs go to the Jev queue; every other kind to the jobs queue", async () => {
  const sent: Record<string, { body: { id: string } }[]> = { JOBS: [], JEV_JOBS: [] };
  const binding = (name: string) => ({ sendBatch: async (m: { body: { id: string } }[]) => void sent[name]!.push(...m) });
  const env = { JOBS: binding("JOBS"), JEV_JOBS: binding("JEV_JOBS") } as unknown as Env;
  await sendJobs(env, kinds.map((kind) => ({ id: `job-${kind}`, kind })));
  expect(sent.JEV_JOBS!.map((m) => m.body.id)).toEqual(["job-lens", "job-autotag", "job-query"]);
  expect(sent.JOBS!.map((m) => m.body.id)).toEqual(["job-extract", "job-preview", "job-browser-lens", "job-browser-autogroup"]);
});

test("sending no jobs sends nothing", async () => {
  let calls = 0;
  const env = { JOBS: { sendBatch: async () => void calls++ }, JEV_JOBS: { sendBatch: async () => void calls++ } } as unknown as Env;
  await sendJobs(env, []);
  expect(calls).toBe(0);
});

test("only the routing module sends to a queue binding", async () => {
  const offenders: string[] = [];
  for await (const file of new Glob("worker/**/*.ts").scan(".")) {
    if (file === "worker/job-routing.ts") continue;
    if (/\.(JEV_)?JOBS\b/.test(await Bun.file(file).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});

test("each environment's Jev queue is consumed as the Jev queue, and only it", () => {
  for (const config of [wrangler, wrangler.env.production]) {
    const { producers, consumers } = config.queues;
    const queueOf = (binding: string) => producers.find((p: { binding: string }) => p.binding === binding)!.queue;
    expect(isJevQueue(queueOf("JEV_JOBS"))).toBe(true);
    expect(isJevQueue(queueOf("JOBS"))).toBe(false);
    expect(consumers.map((c: { queue: string }) => c.queue).sort()).toEqual([queueOf("JOBS"), queueOf("JEV_JOBS")].sort());
  }
});
