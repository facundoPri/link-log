// R5: the private API caps request bodies in bytes, also for chunked bodies without Content-Length.
import { expect, test } from "bun:test";
import worker from "../worker/index";
import { TestD1 } from "./support/d1";
import { makeEnv, TEST_ORIGIN } from "./support/env";
import { testSession } from "./support/auth.test-instance";
import { MAX_BODY_BYTES } from "../worker/http/middleware";

function streamed(text: string) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 64 * 1024) controller.enqueue(bytes.slice(i, i + 64 * 1024));
      controller.close();
    },
  });
}

async function post(env: Env, cookie: string, body: string) {
  const request = new Request(`${TEST_ORIGIN}/api/browser/groups`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_ORIGIN, cookie, "cf-connecting-ip": "203.0.113.5" },
    body: streamed(body),
    // @ts-expect-error Bun/undici need half duplex for stream bodies.
    duplex: "half",
  });
  expect(request.headers.get("content-length")).toBeNull();
  return worker.fetch(request as never, env, { waitUntil() {}, passThroughOnException() {} } as never);
}

test("a multibyte body over the byte cap answers 413 even though it is short in characters", async () => {
  const db = await TestD1.migrated();
  const { env } = makeEnv(db);
  const { cookie } = await testSession(env, "a@example.test");
  // 3 bytes per character: ~720k characters, ~2.16 MB.
  const body = JSON.stringify({ name: "x", color: "blue", padding: "€".repeat(720_000) });
  expect(body.length).toBeLessThan(MAX_BODY_BYTES);
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(MAX_BODY_BYTES);
  const response = await post(env, cookie, body);
  expect(response.status).toBe(413);
  expect(db.sqlite.query("SELECT count(*) n FROM browser_groups").get()).toEqual({ n: 0 }); // before the fix: 201 and a saved group
  // Under the cap, multibyte text is decoded intact.
  const ok = await post(env, cookie, JSON.stringify({ name: "Café €", color: "blue" }));
  expect(ok.status).toBe(201);
  expect(db.sqlite.query("SELECT name FROM browser_groups").get()).toEqual({ name: "Café €" });
});
