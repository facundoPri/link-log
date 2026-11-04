import { expect, test } from "bun:test";
import { Glob } from "bun";
import { sendJobs } from "../worker/job-routing";

const kinds = ["extract", "preview", "lens", "autotag", "query", "browser-lens", "browser-autogroup"];

test("jobs of every batch kind are sent to the jobs queue", async () => {
  const sent: { body: { id: string } }[][] = [];
  const env = { JOBS: { sendBatch: async (m: { body: { id: string } }[]) => void sent.push(m) } } as unknown as Env;
  await sendJobs(env, kinds.map((kind) => ({ id: `job-${kind}`, kind })));
  expect(sent.flat().map((m) => m.body)).toEqual(kinds.map((kind) => ({ id: `job-${kind}` })));
});

test("sending no jobs sends nothing", async () => {
  let calls = 0;
  const env = { JOBS: { sendBatch: async () => void calls++ } } as unknown as Env;
  await sendJobs(env, []);
  expect(calls).toBe(0);
});

test("only the routing module sends to a queue binding", async () => {
  const offenders: string[] = [];
  for await (const file of new Glob("worker/**/*.ts").scan(".")) {
    if (file === "worker/job-routing.ts") continue;
    if (/\.JOBS\b/.test(await Bun.file(file).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
