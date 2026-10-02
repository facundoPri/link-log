// R9: saving links (add, import, Browser save) is all-or-nothing under a database failure, the
// Queue send after the commit is recoverable, and links an earlier interrupted save left without a
// job get exactly one extraction when saved again.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { addLinks } from "../worker/links";
import { recover } from "../worker/jobs";

let db: TestD1, env: Env, queued: { id: string }[], user: { userId: string; cookie: string };
beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, queued } = makeEnv(db));
  user = await testSession(env, "a@example.test");
});

const state = () => ({
  links: (db.sqlite.query("SELECT count(*) n FROM links").get() as { n: number }).n,
  jobs: (db.sqlite.query("SELECT count(*) n FROM jobs").get() as { n: number }).n,
  batches: (db.sqlite.query("SELECT count(*) n FROM batches").get() as { n: number }).n,
  withoutJob: (db.sqlite.query("SELECT count(*) n FROM links l WHERE NOT EXISTS(SELECT 1 FROM jobs j WHERE j.link_id=l.id)").get() as { n: number }).n,
  quota: Object.fromEntries((db.sqlite.query("SELECT key,count FROM app_rate_limits").all() as { key: string; count: number }[]).map((r) => [r.key.split(":")[0], r.count])),
  queued: queued.length,
});
/** A real statement failure inside the write: D1 aborts when this URL's link row is inserted. */
const failOn = (url: string) =>
  db.sqlite.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON links WHEN NEW.original_url='${url}' BEGIN SELECT RAISE(ABORT, 'injected D1 failure'); END`);
const heal = () => db.sqlite.exec("DROP TRIGGER inject_fault");
const urls = ["https://fault.example/first", "https://fault.example/second"];

describe("a failure while saving rolls everything back", () => {
  test("second INSERT fails: no link, job, batch or queue message, nothing charged; the retry saves both once", async () => {
    failOn(urls[1]!);
    await expect(addLinks(env, user.userId, urls)).rejects.toThrow("injected D1 failure");
    expect(state()).toEqual({ links: 0, jobs: 0, batches: 0, withoutJob: 0, quota: { links: 0, jobs: 0 }, queued: 0 });
    heal();
    const retry = await addLinks(env, user.userId, urls);
    expect(retry.map((r) => "created" in r && r.created)).toEqual([true, true]);
    expect(state()).toEqual({ links: 2, jobs: 2, batches: 1, withoutJob: 0, quota: { links: 2, jobs: 2 }, queued: 2 });
    // Saving again changes nothing.
    await addLinks(env, user.userId, urls);
    expect(state()).toEqual({ links: 2, jobs: 2, batches: 1, withoutJob: 0, quota: { links: 2, jobs: 2 }, queued: 2 });
  });

  test("the HTTP import and Browser save routes answer with an error and save nothing", async () => {
    const call = client(env);
    failOn(urls[1]!);
    expect((await call("/api/import", { cookie: user.cookie, body: { urls } })).ok).toBe(false);
    expect((await call("/api/browser/save", { cookie: user.cookie, body: { urls } })).ok).toBe(false);
    expect((await call("/api/links", { cookie: user.cookie, body: { url: urls[1] } })).ok).toBe(false);
    expect(state()).toMatchObject({ links: 0, jobs: 0, batches: 0, queued: 0 });
  });
});

test("Queue unavailable after the commit: the request succeeds and cron recovery sends the jobs", async () => {
  env.JOBS.sendBatch = async () => {
    throw new Error("queue down");
  };
  const saved = await addLinks(env, user.userId, urls);
  expect(saved.every((r) => "created" in r && r.created)).toBe(true);
  expect(state()).toMatchObject({ links: 2, jobs: 2, withoutJob: 0, queued: 0 });
  const sent: { id: string }[] = [];
  env.JOBS.sendBatch = async (messages: { body: { id: string } }[]) => void sent.push(...messages.map((m) => m.body));
  await recover(env);
  expect(sent.length).toBe(2);
});

describe("links left without a job by an earlier interrupted save", () => {
  const orphan = () =>
    db.sqlite
      .query("INSERT INTO links(id,user_id,original_url,url,domain,title,created_at) VALUES('orphan',?,?,?,'fault.example','x','t')")
      .run(user.userId, urls[0]!, urls[0]!);

  test("saving the URL again queues its extraction once, charging one job and no link", async () => {
    orphan();
    const [result] = await addLinks(env, user.userId, [urls[0]!]);
    expect(result).toMatchObject({ id: "orphan", created: false });
    expect(state()).toMatchObject({ links: 1, jobs: 1, batches: 1, withoutJob: 0, quota: { jobs: 1 }, queued: 1 });
    await addLinks(env, user.userId, [urls[0]!]);
    expect(state()).toMatchObject({ jobs: 1, quota: { jobs: 1 }, queued: 1 });
  });

  test("concurrent saves of an orphan and a new URL: one job each, refunds for the losers", async () => {
    orphan();
    await Promise.all([1, 2, 3].map(() => addLinks(env, user.userId, urls)));
    expect(state()).toMatchObject({ links: 2, jobs: 2, withoutJob: 0, quota: { links: 1, jobs: 2 }, queued: 2 });
  });
});
