// FAC-153: a quota 429 names the exhausted quota (`code`) and says when its fixed window resets
// (`Retry-After`, seconds), and saves nothing. The add-links service records an optional source
// in the batch it creates; web calls record none.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { addLinks } from "../worker/links";

let db: TestD1, env: Env, queued: { id: string }[], call: ReturnType<typeof client>;
let A: { userId: string; cookie: string };

const send = (path: string, body: unknown) => call(path, { cookie: A.cookie, body });
const setUsed = (key: string, count: number, window: number) =>
  db.sqlite.query("INSERT OR REPLACE INTO app_rate_limits(key,window_start,count) VALUES(?,?,?)").run(key, Math.floor(Date.now() / 1000 / window) * window, count);
const used = (key: string) => (db.sqlite.query("SELECT count FROM app_rate_limits WHERE key=?").get(key) as { count: number } | null)?.count ?? 0;
const rows = () =>
  db.sqlite.query("SELECT (SELECT count(*) FROM links) links,(SELECT count(*) FROM jobs) jobs,(SELECT count(*) FROM batches) batches").get();
/** Seconds to the next fixed window boundary, as seen at `ms`. */
const untilReset = (window: number, ms: number) => Math.ceil((Math.floor(ms / 1000 / window) + 1) * window - ms / 1000);

/** Sends the request and checks the 429 body and that Retry-After matches the window reset. */
async function expect429(request: () => Promise<Response>, code: string, window: number) {
  const before = Date.now();
  const res = await request();
  const after = Date.now();
  expect(res.status).toBe(429);
  expect(((await res.json()) as { code?: string }).code).toBe(code);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(untilReset(window, after));
  expect(retryAfter).toBeLessThanOrEqual(untilReset(window, before));
}

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, queued } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
});

describe("an exhausted quota names itself and when it resets", () => {
  test("links quota: add and import answer code `links` and save nothing", async () => {
    setUsed(`links:${A.userId}`, 500, 3600);
    await expect429(() => send("/api/links", { url: "https://quota.example/a" }), "links", 3600);
    await expect429(() => send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] }), "links", 3600);
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
    expect(queued).toHaveLength(0);
  });

  test("jobs quota: add and import answer code `jobs`, save nothing and keep the links quota intact", async () => {
    setUsed(`jobs:${A.userId}`, 300, 3600);
    await expect429(() => send("/api/links", { url: "https://quota.example/a" }), "jobs", 3600);
    await expect429(() => send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] }), "jobs", 3600);
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
    expect(queued).toHaveLength(0);
    expect(used(`links:${A.userId}`)).toBe(0);
  });

  test("the write-per-minute limit answers 429 with its own code and the same Retry-After shape", async () => {
    setUsed(`writes:${A.userId}`, 120, 60);
    await expect429(() => send("/api/tags", { name: "x" }), "writes", 60);
  });
});

describe("the batch source", () => {
  const configs = () => (db.sqlite.query("SELECT config FROM batches").all() as { config: string }[]).map((b) => JSON.parse(b.config));

  test("a source given to addLinks is stored in the created batch's config", async () => {
    const source = { source: "api", apiKeyId: "key-1", apiKeyName: "Shortcuts" } as const;
    await addLinks(env, A.userId, ["https://source.example/a"], source);
    expect(configs()).toEqual([source]);
  });

  test("web calls store no source", async () => {
    expect((await send("/api/links", { url: "https://source.example/web" })).status).toBe(201);
    expect((await send("/api/import", { urls: ["https://source.example/1"] })).status).toBe(200);
    expect(configs()).toEqual([{}, {}]);
  });
});
