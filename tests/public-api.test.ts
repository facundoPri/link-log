// FAC-155: an integration submits URLs with `Authorization: Bearer lk_…` to POST /api/v1/links.
// The owner always comes from the verified key; the key reaches no other route; links go through
// the same add-links service as the web app, and the batch is labelled with the key in Activity.
import { beforeEach, describe, expect, test } from "bun:test";
import { TestD1 } from "./support/d1";
import { client, makeEnv } from "./support/env";
import { testApiKey, testSession } from "./support/auth.test-instance";
import { libraryOf as library, quotaUsed } from "./support/library";
import { expect429, setUsed, stayInsideWindow } from "./support/quota";

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
const libraryOf = (who: { cookie: string }) => library(call, who);
/** Nothing was saved or queued, as the owner's library and the Extraction queue show it. */
const nothingSaved = async () => {
  expect(await libraryOf(A)).toMatchObject({ links: [], batches: [] });
  expect(queued).toHaveLength(0);
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
    const charged = await quotaUsed(call, A);

    const res = await submit(keyA.key, { urls: ["https://api.example/a"] });
    expect(res.status).toBe(202);
    expect((await res.json()) as Submitted).toEqual({
      results: [{ input: "https://api.example/a", url: "https://api.example/a", id: first.results[0]!.id, status: "duplicate" }],
      rejected: [],
    });
    expect(queued).toHaveLength(0);
    expect(await quotaUsed(call, A)).toEqual(charged);
    expect((await libraryOf(A)).links.map((l) => l.url)).toEqual(["https://api.example/a", "https://api.example/b"]);
  });

  test("a Link saved without any Extraction job is queued again: still a duplicate, with a batch, charging one job", async () => {
    const first = (await (await submit(keyA.key, { urls: ["https://api.example/a"] })).json()) as Submitted;
    db.sqlite.exec("DELETE FROM jobs"); // setup: what an interrupted save used to leave behind
    queued.length = 0;
    const before = await quotaUsed(call, A);

    const body = (await (await submit(keyA.key, { urls: ["https://api.example/a"] })).json()) as Submitted;
    expect(body.results.map((r) => [r.id, r.status])).toEqual([[first.results[0]!.id, "duplicate"]]);
    expect(typeof body.batchId).toBe("string");
    expect(queued).toHaveLength(1);
    expect(await quotaUsed(call, A)).toEqual({ links: before.links, jobs: before.jobs + 1 });
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

  test("a body that is not `{ urls: string[] }` is 400 and saves nothing", async () => {
    const tooManyStrings = Array.from({ length: 1001 }, (_, i) => `https://api.example/${i}`);
    for (const body of [{}, { urls: [] }, { urls: "https://api.example/a" }, { urls: [42] }, { urls: tooManyStrings }, ["https://api.example/a"]])
      expect((await submit(keyA.key, body)).status).toBe(400);
    await nothingSaved();
  });

  test("a string longer than 8192 characters is 400 naming the limit and saves nothing, even next to valid ones", async () => {
    const res = await submit(keyA.key, { urls: ["https://api.example/a", `http://api.example/x${")".repeat(1_000_000)}`] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Each string can be at most 8192 characters.");
    await nothingSaved();
  });
});

describe("URLs inside text", () => {
  test("every URL in a string is saved once across the request; the result input is the string it came from", async () => {
    const text = "Example page: [https://api.example/a](<https://api.example/a>) and https://api.example/b.";
    const res = await submit(keyA.key, { urls: [text, "https://api.example/b", "api.example/c"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Submitted;
    expect(body.results.map((r) => [r.input, r.url, r.status])).toEqual([
      [text, "https://api.example/a", "created"],
      [text, "https://api.example/b", "created"],
      ["api.example/c", "https://api.example/c", "created"],
    ]);
    expect(body.rejected).toEqual([]);
    expect((await libraryOf(A)).links.map((l) => l.url).sort()).toEqual(["https://api.example/a", "https://api.example/b", "https://api.example/c"]);
  });

  test("strings without a valid URL are rejected with a reason and never stored; the others are saved", async () => {
    const res = await submit(keyA.key, { urls: ["call me maybe", "ftp://api.example/x see mailto:a@api.example", "ok https://api.example/a"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Submitted;
    expect(body.results.map((r) => r.url)).toEqual(["https://api.example/a"]);
    expect(body.rejected.map((r) => r.input)).toEqual(["call me maybe", "ftp://api.example/x see mailto:a@api.example"]);
    expect(body.rejected.every((r) => r.error.length > 0)).toBe(true);
    expect(JSON.stringify(await libraryOf(A))).not.toContain("call me maybe");
  });

  test("a URL that breaks a URL rule is rejected with that rule's reason; prose keeps the generic one", async () => {
    const res = await submit(keyA.key, { urls: ["https://user:pw@api.example/x", "see https://localhost/y", "just words", "ok https://api.example/a"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Submitted;
    expect(body.rejected.map((r) => [r.input, r.error])).toEqual([
      ["https://user:pw@api.example/x", "Use a public http or https link."],
      ["see https://localhost/y", "Use a public http or https link."],
      ["just words", "No valid http or https link found."],
    ]);
  });

  test("zero valid URLs is 400 listing what was rejected, and saves nothing", async () => {
    const res = await submit(keyA.key, { urls: ["nothing here", "ftp://api.example/x"] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; rejected: { input: string; error: string }[] };
    expect(body.error).toBe("No valid http or https link found.");
    expect(body.rejected.map((r) => r.input)).toEqual(["nothing here", "ftp://api.example/x"]);
    await nothingSaved();
  });

  test("the 100 limit counts URLs after extraction: 101 is 400 and saves nothing, 100 in a few strings is fine", async () => {
    const urls = Array.from({ length: 101 }, (_, i) => `https://api.example/${i}`);
    const res = await submit(keyA.key, { urls: [urls.slice(0, 50).join(" "), urls.slice(50).join("\n")] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("Send at most 100 links per request.");
    await nothingSaved();

    const ok = await submit(keyA.key, { urls: [urls.slice(0, 50).join(" "), urls.slice(50, 100).join("\n")] });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as Submitted).results).toHaveLength(100);
  });

  test("repeats do not count toward the limit", async () => {
    const res = await submit(keyA.key, { urls: Array.from({ length: 150 }, () => "https://api.example/same https://api.example/same") });
    expect(res.status).toBe(202);
    expect(((await res.json()) as Submitted).results).toHaveLength(1);
  });
});

describe("work per request", () => {
  // Distinct URLs are capped at 100, but repeats collapse before that, so the cost of a request
  // cannot hang on the number of distinct URLs. Budgets are generous: the old code took seconds.
  const heavy = `http://api.example/p?${Array.from({ length: 430 }, (_, i) => `utm_${i}=`).join("&")}`;

  test("many repeats of a URL with hundreds of tracking parameters are answered quickly", async () => {
    const started = performance.now();
    const res = await submit(keyA.key, { urls: Array.from({ length: 250 }, () => `${heavy} ${heavy}`) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as Submitted).results.map((r) => r.url)).toEqual(["http://api.example/p"]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("strings at the length limit, ending in a long run of closing parentheses, are answered quickly", async () => {
    const text = `http://api.example/x${")".repeat(8192 - "http://api.example/x".length)}`;
    const started = performance.now();
    const res = await submit(keyA.key, { urls: Array.from({ length: 250 }, () => text) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as Submitted).results.map((r) => r.url)).toEqual(["http://api.example/x"]);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("1000 URLs found are fine, repeats included", async () => {
    const res = await submit(keyA.key, { urls: Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => "https://api.example/same").join(" ")) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as Submitted).results).toHaveLength(1);
  });

  test("more than 1000 URLs found, repeats included, is 400 and saves nothing", async () => {
    const same = "https://api.example/same";
    for (const urls of [
      [...Array.from({ length: 500 }, () => `${same} ${same}`), same],
      [...Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => same).join(" ")), same],
    ]) {
      const res = await submit(keyA.key, { urls });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("Send at most 1000 links per request, repeats included.");
    }
    await nothingSaved();
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
    // api_key_rejected is the one record of a rejection; the plugin's own error line is dropped.
    expect(logs.filter((l) => l.includes("[auth]"))).toEqual([]);
    await nothingSaved();
  });

  test("a failed key lookup is 503 (retry), not 401; the key works again once the database does", async () => {
    await quiet(async () => {
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (/apikey/i.test(sql)) throw new Error("D1_ERROR: Network connection lost."); // setup: a D1 outage on the key table
        return prepare(sql);
      }) as typeof db.prepare;
      const down = await submit(keyA.key, body);
      expect(down.status).toBe(503);
      expect(((await down.json()) as { error: string }).error).toBe("Could not check the API key. Try again.");
      db.prepare = prepare;
      expect((await submit(keyA.key, body)).status).toBe(202);
    });
    expect(logs.filter((l) => l.includes("api_key_lookup_failed"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(keyA.key.slice(9));
  });

  test("a failed key lookup is logged with its cause but never the key", async () => {
    await quiet(async () => {
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => {
        if (/apikey/i.test(sql)) throw new Error("D1_ERROR: Network connection lost.");
        return prepare(sql);
      }) as typeof db.prepare;
      expect((await submit(keyA.key, body)).status).toBe(503);
      db.prepare = prepare;
    });
    const line = logs.find((l) => l.includes("api_key_lookup_failed"))!;
    expect(JSON.parse(line).detail).toContain("Network connection lost");
    expect(line).not.toContain(keyA.key.slice(9));
  });

  test("an unknown or revoked key costs one key lookup; a bearer that cannot be a key costs none", async () => {
    await call(`/api/api-keys/${keyA.id}/revoke`, { cookie: A.cookie, body: {} });
    let reads = 0;
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (/apikey/i.test(sql)) reads++;
      return prepare(sql);
    }) as typeof db.prepare;
    const readsFor = async (key: string) => {
      reads = 0;
      await quiet(async () => void (await expect401(await submit(key, body))));
      return reads;
    };
    const results = [await readsFor(`lk_${"x".repeat(64)}`), await readsFor(keyA.key), await readsFor("lk_short"), await readsFor("x".repeat(67)), await readsFor(`lk_${"x".repeat(65)}`)];
    db.prepare = prepare;
    expect(results).toEqual([1, 1, 0, 0, 0]);
  });

  test("a key whose use cannot be recorded is 503, not 401; an unknown key stays 401", async () => {
    db.sqlite.exec("CREATE TRIGGER no_use BEFORE UPDATE ON apikey BEGIN SELECT RAISE(ABORT, 'update failed'); END");
    await quiet(async () => {
      expect((await submit(keyA.key, body)).status).toBe(503);
      expect((await submit(`lk_${"x".repeat(64)}`, body)).status).toBe(401);
    });
    await nothingSaved();
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
    await nothingSaved();
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
      ["GET", "/api/usage/summary"],
      ["GET", "/api/api-keys"],
      ["POST", "/api/api-keys", { name: "Stolen" }],
      ["POST", `/api/api-keys/${keyA.id}/revoke`, {}],
      ["POST", `/api/api-keys/${keyA.id}/regenerate`, {}],
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
  const one = () => submit(keyA.key, { urls: ["https://api.example/limited"] });
  // A test that starts just before a window resets would see its counters start over mid-test.
  beforeEach(async () => {
    await stayInsideWindow(60);
    await stayInsideWindow(3600);
  });

  test("each key allows 60 requests a minute, then 429 `api_key` with Retry-After; another key is unaffected", async () => {
    for (let i = 0; i < 60; i++) expect((await one()).status).toBe(202);
    await expect429(one, "api_key", 60);
    const library = await libraryOf(A);
    expect([library.links.length, library.batches.length]).toEqual([1, 1]); // only the first request saved; the 429 added nothing
    const other = await testApiKey(env, A.userId, "Server");
    expect((await submit(other.key, { urls: ["https://api.example/limited"] })).status).toBe(202);
  });

  test("the owner's links and jobs quotas answer with their codes and save nothing", async () => {
    setUsed(db, `links:${A.userId}`, 500, 3600);
    await expect429(one, "links", 3600);
    setUsed(db, `links:${A.userId}`, 0, 3600);
    setUsed(db, `jobs:${A.userId}`, 300, 3600);
    await expect429(one, "jobs", 3600);
    await nothingSaved();
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
