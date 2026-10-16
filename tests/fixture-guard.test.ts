// R4: the fixture Jev provider runs only in local/test. The guard sits where the provider is
// called, so Queue/Workflow work (which never goes through readConfig) can't produce fixture
// answers in preview/production either.
import { expect, test } from "bun:test";
import { lensFingerprint } from "@linklog/browser-protocol";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { loadOwnedJob } from "../worker/workflow";
import { browserEvaluationHandler } from "../worker/handlers/browser";
import { capabilities } from "../worker/store";

const step = { do: async (_name: string, a: unknown, b?: unknown) => (typeof a === "function" ? a() : (b as () => unknown)()) };

async function queuedBrowserJob() {
  const db = await TestD1.migrated();
  const { env } = makeEnv(db, { JEV_PROVIDER: "fixture", ALLOW_FIXTURE_JEV: "1" });
  const A = await testSession(env, "a@example.test");
  db.sqlite.query("INSERT INTO lenses(id,user_id,name,type,question,options,created_at,scope) VALUES('lens',?,'L','noul','Relevant?','{}','t','browser')").run(A.userId);
  const call = client(env);
  const catalog = (await (await call("/api/browser/catalog", { cookie: A.cookie })).json()) as { libraryId: string };
  const fp = lensFingerprint({ type: "noul", question: "Relevant?", options: [], levels: [], criteria: { yes: "", no: "" } } as never);
  const created = await call("/api/browser/evaluations", {
    cookie: A.cookie,
    body: {
      requestId: "req",
      libraryId: catalog.libraryId,
      sessionId: "s",
      kind: "lens",
      lens: { id: "lens", fingerprint: fp },
      targets: [{ targetKey: "k", url: "https://x.dev", title: "X", capture: { source: "dom", capturedAt: "2026-10-02T00:00:00.000Z", completeness: "complete", reasons: [], facts: [], markdown: "jev:yes" } }],
    },
  });
  expect(created.status).toBe(201);
  const jobId = (db.sqlite.query("SELECT id FROM jobs").get() as { id: string }).id;
  const loaded = await loadOwnedJob(env.DB, jobId);
  const run = (appEnv: string) =>
    browserEvaluationHandler.run({
      env: { ...env, APP_ENV: appEnv } as Env,
      step: step as never,
      job: loaded.job,
      target: loaded.target!,
      config: JSON.parse(loaded.job.config),
    });
  return { db, env, run };
}

for (const appEnv of ["production", "preview"])
  test(`${appEnv}: background evaluation with fixture flags fails before any answer or usage`, async () => {
    const { db, env, run } = await queuedBrowserJob();
    await expect(run(appEnv)).rejects.toThrow("only available in local and test");
    expect(db.sqlite.query("SELECT answer FROM browser_targets").get()).toEqual({ answer: null });
    expect(db.sqlite.query("SELECT count(*) n FROM usage_events").get()).toEqual({ n: 0 });
    expect(capabilities({ ...env, APP_ENV: appEnv } as Env).jev).toBe(false);
  });

test("test/local: the fixture provider still answers when both flags are set", async () => {
  const { db, run } = await queuedBrowserJob();
  await run("test");
  expect(db.sqlite.query("SELECT answer FROM browser_targets").get()).toEqual({ answer: expect.stringContaining('"noul":0.95') });
  expect(db.sqlite.query("SELECT model FROM usage_events").get()).toEqual({ model: expect.stringContaining("fixture") });
});
