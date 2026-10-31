// FAC-153: a quota 429 names the exhausted quota (`code`) and says when its fixed window resets
// (`Retry-After`, seconds), and saves nothing. A batch from an API submission records its source;
// web calls record none.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testApiKey, testSession } from "./support/auth.test-instance";
import { libraryOf, quotaUsed } from "./support/library";
import { expect429, setUsed, stayInsideWindow } from "./support/quota";

let db: TestD1, env: Env, queued: { id: string }[], call: ReturnType<typeof client>;
let A: { userId: string; cookie: string };

const send = (path: string, body: unknown) => call(path, { cookie: A.cookie, body });
const nothingSaved = async () => {
  expect(await libraryOf(call, A)).toMatchObject({ links: [], batches: [] });
  expect(queued).toHaveLength(0);
};

beforeEach(async () => {
  await stayInsideWindow(3600);
  await stayInsideWindow(60);
  db = await TestD1.migrated();
  ({ env, queued } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
});

describe("an exhausted quota names itself and when it resets", () => {
  test("links quota: add and import answer code `links` and save nothing", async () => {
    setUsed(db, `links:${A.userId}`, 500, 3600);
    await expect429(() => send("/api/links", { url: "https://quota.example/a" }), "links", 3600);
    await expect429(() => send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] }), "links", 3600);
    await nothingSaved();
  });

  test("jobs quota: add and import answer code `jobs`, save nothing and keep the links quota intact", async () => {
    setUsed(db, `jobs:${A.userId}`, 300, 3600);
    await expect429(() => send("/api/links", { url: "https://quota.example/a" }), "jobs", 3600);
    await expect429(() => send("/api/import", { urls: ["https://quota.example/1", "https://quota.example/2"] }), "jobs", 3600);
    await nothingSaved();
    expect(await quotaUsed(call, A)).toEqual({ links: 0, jobs: 300 });
  });

  test("the write-per-minute limit answers 429 with its own code and the same Retry-After shape", async () => {
    setUsed(db, `writes:${A.userId}`, 120, 60);
    await expect429(() => send("/api/tags", { name: "x" }), "writes", 60);
  });
});

describe("the batch source", () => {
  const configs = async () => (await libraryOf(call, A)).batches.map((b) => JSON.parse(b.config));

  test("an API submission records its key in the batch Activity shows", async () => {
    const key = await testApiKey(env, A.userId, "Shortcuts");
    const res = await call("/api/v1/links", { origin: null, headers: { authorization: `Bearer ${key.key}` }, body: { urls: ["https://source.example/a"] } });
    expect(res.status).toBe(202);
    expect(await configs()).toEqual([{ source: "api", apiKeyId: key.id, apiKeyName: "Shortcuts" }]);
  });

  test("web calls record no source", async () => {
    expect((await send("/api/links", { url: "https://source.example/web" })).status).toBe(201);
    expect((await send("/api/import", { urls: ["https://source.example/1"] })).status).toBe(200);
    expect(await configs()).toEqual([{}, {}]);
  });
});
