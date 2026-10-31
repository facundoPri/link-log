// FAC-155: an integration submits URLs with `Authorization: Bearer lk_…` to POST /api/v1/links.
// The owner always comes from the verified key; the key reaches no other route; links go through
// the same add-links service as the web app, and the batch is labelled with the key in Activity.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testApiKey, testSession } from "./support/auth.test-instance";

type Result = { input: string; url: string; id: string; status: "created" | "duplicate" };
type Submitted = { results: Result[]; rejected: { input: string; error: string }[]; batchId?: string };
let db: TestD1, env: Env, queued: { id: string }[], call: ReturnType<typeof client>;
let A: { userId: string; cookie: string }, B: { userId: string; cookie: string };
let keyA: { id: string; key: string };

beforeEach(async () => {
  db = await TestD1.migrated();
  ({ env, queued } = makeEnv(db));
  call = client(env);
  A = await testSession(env, "a@example.test");
  B = await testSession(env, "b@example.test");
  keyA = await testApiKey(env, A.userId, "Shortcuts");
});

/** What an integration sends: a Bearer key, a JSON body and no browser Origin or cookie. */
const submit = (key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  call("/api/v1/links", { body, origin: null, headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...headers } });
const used = (key: string) => (db.sqlite.query("SELECT count FROM app_rate_limits WHERE key=?").get(key) as { count: number } | null)?.count ?? 0;
const rows = () =>
  db.sqlite.query("SELECT (SELECT count(*) FROM links) links,(SELECT count(*) FROM jobs) jobs,(SELECT count(*) FROM batches) batches").get();
const libraryOf = async (who: { cookie: string }) =>
  (await (await call("/api/library", { cookie: who.cookie })).json()) as {
    links: { id: string; url: string }[];
    batches: { id: string; kind: string; config: string; total: number; active: number; cancelled: number }[];
  };

describe("submitting with a valid key", () => {
  test("new URLs are saved for the key's owner and answer 202 with one result per URL and the batch", async () => {
    const res = await submit(keyA.key, { urls: ["https://api.example/a", "https://api.example/b"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Submitted;
    expect(body.results.map((r) => [r.input, r.url, r.status])).toEqual([
      ["https://api.example/a", "https://api.example/a", "created"],
      ["https://api.example/b", "https://api.example/b", "created"],
    ]);
    expect(body.rejected).toEqual([]);
    expect(typeof body.batchId).toBe("string");

    const library = await libraryOf(A);
    expect(library.links.map((l) => l.id).sort()).toEqual(body.results.map((r) => r.id).sort());
    expect(library.batches.map((b) => [b.id, b.kind, b.total])).toEqual([[body.batchId!, "extract", 2]]);
    expect(queued).toHaveLength(2);
  });
});

describe("Duplicates and invalid inputs", () => {
  test("a Duplicate refreshes recency, queues no Extraction, is not charged and has no batch", async () => {
    const first = (await (await submit(keyA.key, { urls: ["https://api.example/a"] })).json()) as Submitted;
    await submit(keyA.key, { urls: ["https://api.example/b"] });
    queued.length = 0;
    const charged = [used(`links:${A.userId}`), used(`jobs:${A.userId}`)];

    const res = await submit(keyA.key, { urls: ["https://api.example/a"] });
    expect(res.status).toBe(202);
    expect((await res.json()) as Submitted).toEqual({
      results: [{ input: "https://api.example/a", url: "https://api.example/a", id: first.results[0]!.id, status: "duplicate" }],
      rejected: [],
    });
    expect(queued).toHaveLength(0);
    expect([used(`links:${A.userId}`), used(`jobs:${A.userId}`)]).toEqual(charged);
    expect((await libraryOf(A)).links.map((l) => l.url)).toEqual(["https://api.example/a", "https://api.example/b"]);
  });

  test("the same URL twice in one request gives one result; invalid inputs are rejected and never stored", async () => {
    const res = await submit(keyA.key, { urls: ["https://api.example/same", "https://api.example/same", "not a url", "ftp://api.example/x"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Submitted;
    expect(body.results.map((r) => [r.url, r.status])).toEqual([["https://api.example/same", "created"]]);
    expect(body.rejected.map((r) => r.input)).toEqual(["not a url", "ftp://api.example/x"]);
    expect(body.rejected.every((r) => r.error.length > 0)).toBe(true);
    expect(JSON.stringify(await libraryOf(A))).not.toContain("not a url");
  });

  test("a body that is not `{ urls: string[] }` (1 to 100) is 400 and saves nothing", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `https://api.example/${i}`);
    for (const body of [{}, { urls: [] }, { urls: "https://api.example/a" }, { urls: [42] }, { urls: tooMany }, ["https://api.example/a"]])
      expect((await submit(keyA.key, body)).status).toBe(400);
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
  });
});

describe("authentication", () => {
  let logs: string[];
  const quiet = async (run: () => Promise<void>) => {
    logs = [];
    const { warn, error, log } = console;
    console.warn = console.error = console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
    try {
      await run();
    } finally {
      Object.assign(console, { warn, error, log });
    }
  };
  const expect401 = async (res: Response) => {
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  };
  const body = { urls: ["https://api.example/a"] };

  test("missing, malformed, unknown and Revoked API keys are 401, logged without the key, and save nothing", async () => {
    await quiet(async () => {
      await expect401(await submit(null, body));
      await expect401(await submit(null, body, { authorization: keyA.key }));
      await expect401(await submit(null, body, { authorization: `Basic ${keyA.key}` }));
      await expect401(await submit(null, body, { "x-api-key": keyA.key }));
      await expect401(await submit(`lk_${"x".repeat(64)}`, body));
      expect((await call(`/api/api-keys/${keyA.id}/revoke`, { cookie: A.cookie, body: {} })).status).toBe(200);
      await expect401(await submit(keyA.key, body));
    });
    const rejections = logs.filter((l) => l.includes("api_key_rejected")).map((l) => JSON.parse(l).reason);
    expect(rejections).toEqual(["missing", "missing", "missing", "missing", "invalid", "invalid"]);
    expect(logs.join("\n")).not.toContain(keyA.key.slice(9));
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
  });

  test("after regenerating, the new key submits under the same name and the old one is 401", async () => {
    const res = await call(`/api/api-keys/${keyA.id}/regenerate`, { cookie: A.cookie, body: {} });
    const { apiKey, secret } = (await res.json()) as { apiKey: { id: string }; secret: string };
    await quiet(async () => {
      await expect401(await submit(keyA.key, body));
    });
    const { batchId } = (await (await submit(secret, body)).json()) as Submitted;
    const batch = (await libraryOf(A)).batches.find((b) => b.id === batchId)!;
    expect(JSON.parse(batch.config)).toEqual({ source: "api", apiKeyId: apiKey.id, apiKeyName: "Shortcuts" });
  });

  test("a session cookie alone does not authorize the public API", async () => {
    await quiet(async () => {
      await expect401(await call("/api/v1/links", { cookie: A.cookie, body }));
    });
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
  });
});

describe("an API key reaches no private route", () => {
  test("library, links, Activity and key management answer 401 to a key, even from the app's origin", async () => {
    const saved = (await (await submit(keyA.key, { urls: ["https://api.example/a"] })).json()) as Submitted;
    const linkId = saved.results[0]!.id, batchId = saved.batchId!;
    const bearer = { authorization: `Bearer ${keyA.key}` };
    const attempts: [string, string, unknown?][] = [
      ["GET", "/api/library"],
      ["POST", "/api/links", { url: "https://api.example/private" }],
      ["POST", "/api/import", { urls: ["https://api.example/private"] }],
      ["PATCH", `/api/links/${linkId}`, { title: "x" }],
      ["DELETE", `/api/links/${linkId}`, {}],
      ["GET", `/api/links/${linkId}/content`],
      ["GET", "/api/tags"],
      ["POST", "/api/tags", { name: "x" }],
      ["POST", "/api/batches", { ids: [linkId], kind: "extract" }],
      ["GET", `/api/batches/${batchId}`],
      ["DELETE", `/api/batches/${batchId}`, {}],
      ["DELETE", `/api/jobs/${batchId}`, {}],
      ["GET", "/api/usage"],
      ["GET", "/api/api-keys"],
      ["POST", "/api/api-keys", { name: "Stolen" }],
      ["POST", `/api/api-keys/${keyA.id}/revoke`, {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(path, { method, body, headers: bearer });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
    // Other paths under the public prefix are no way into the private group.
    for (const path of ["/api/v1/library", "/api/v1/api-keys", `/api/v1/batches/${batchId}`])
      expect([path, (await call(path, { headers: bearer })).status]).toEqual([path, 404]);
    // Better Auth does not turn the key into a session, and its own key endpoints stay unreachable.
    expect(await (await call("/api/auth/get-session", { headers: bearer })).json()).toBeNull();
    expect((await call("/api/auth/api-key/list", { headers: bearer })).status).toBe(404);

    const library = await libraryOf(A);
    expect(library.links.map((l) => l.url)).toEqual(["https://api.example/a"]);
    expect(library.batches.map((b) => b.active)).toEqual([1]);
    const keys = (await (await call("/api/api-keys", { cookie: A.cookie })).json()) as { apiKeys: { status: string }[] };
    expect(keys.apiKeys.map((k) => k.status)).toEqual(["active"]);
  });
});

describe("ownership", () => {
  test("a key always saves to its owner, ignoring an owner in the body and another user's cookie", async () => {
    const res = await call("/api/v1/links", {
      cookie: B.cookie,
      origin: null,
      headers: { authorization: `Bearer ${keyA.key}` },
      body: { urls: ["https://api.example/mine"], userId: B.userId, owner: B.userId },
    });
    expect(res.status).toBe(202);
    expect((await libraryOf(A)).links.map((l) => l.url)).toEqual(["https://api.example/mine"]);
    expect((await libraryOf(B)).links).toEqual([]);
  });

  test("a URL the other user saved is created for the key's owner; the other user's library is untouched", async () => {
    expect((await call("/api/links", { cookie: B.cookie, body: { url: "https://api.example/shared" } })).status).toBe(201);
    const before = await libraryOf(B);
    const res = (await (await submit(keyA.key, { urls: ["https://api.example/shared"] })).json()) as Submitted;
    expect(res.results.map((r) => r.status)).toEqual(["created"]);
    expect(before.links.map((l) => l.id)).not.toContain(res.results[0]!.id);
    expect(await libraryOf(B)).toEqual(before);
  });
});

describe("limits", () => {
  const setUsed = (key: string, count: number, window: number) =>
    db.sqlite.query("INSERT OR REPLACE INTO app_rate_limits(key,window_start,count) VALUES(?,?,?)").run(key, Math.floor(Date.now() / 1000 / window) * window, count);
  /** Seconds to the next fixed window boundary, as seen at `ms`. */
  const untilReset = (window: number, ms: number) => Math.ceil((Math.floor(ms / 1000 / window) + 1) * window - ms / 1000);
  async function expect429(request: () => Promise<Response>, code: string, window: number) {
    const before = Date.now();
    const res = await request();
    const after = Date.now();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code?: string }).code).toBe(code);
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThanOrEqual(untilReset(window, after));
    expect(retryAfter).toBeLessThanOrEqual(untilReset(window, before));
  }
  const one = () => submit(keyA.key, { urls: ["https://api.example/limited"] });

  test("each key allows 60 requests a minute, then 429 `api_key` with Retry-After; another key is unaffected", async () => {
    for (let i = 0; i < 60; i++) expect((await submit(keyA.key, { urls: ["not a url"] })).status).toBe(202);
    await expect429(one, "api_key", 60);
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
    const other = await testApiKey(env, A.userId, "Server");
    expect((await submit(other.key, { urls: ["https://api.example/limited"] })).status).toBe(202);
  });

  test("the owner's links and jobs quotas answer with their codes and save nothing", async () => {
    setUsed(`links:${A.userId}`, 500, 3600);
    await expect429(one, "links", 3600);
    setUsed(`links:${A.userId}`, 0, 3600);
    setUsed(`jobs:${A.userId}`, 300, 3600);
    await expect429(one, "jobs", 3600);
    expect(rows()).toEqual({ links: 0, jobs: 0, batches: 0 });
    expect(queued).toHaveLength(0);
  });
});

test("no CORS headers are sent, on a preflight or on a cross-site submit", async () => {
  const evil = { origin: "https://evil.example", "sec-fetch-site": "cross-site" };
  const preflight = await call("/api/v1/links", {
    method: "OPTIONS",
    origin: null,
    headers: { ...evil, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
  });
  expect(preflight.ok).toBe(false);
  const post = await submit(keyA.key, { urls: ["https://api.example/a"] }, evil);
  for (const res of [preflight, post]) expect([...res.headers.keys()].filter((h) => h.startsWith("access-control-"))).toEqual([]);
});

describe("Activity", () => {
  test("the API batch records its key and is cancelled through the existing route; the other user cannot", async () => {
    const { batchId } = (await (await submit(keyA.key, { urls: ["https://api.example/1", "https://api.example/2"] })).json()) as Submitted;
    const batch = (await libraryOf(A)).batches.find((b) => b.id === batchId)!;
    expect(JSON.parse(batch.config)).toEqual({ source: "api", apiKeyId: keyA.id, apiKeyName: "Shortcuts" });

    expect((await libraryOf(B)).batches).toEqual([]);
    expect((await call(`/api/batches/${batchId}`, { method: "DELETE", cookie: B.cookie, body: {} })).status).toBe(404);
    const cancelled = await call(`/api/batches/${batchId}`, { method: "DELETE", cookie: A.cookie, body: {} });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { cancelled: number }).cancelled).toBe(2);
    expect((await libraryOf(A)).batches.find((b) => b.id === batchId)).toMatchObject({ active: 0, cancelled: 2 });
  });
});
