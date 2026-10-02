// End-to-end auth + isolation check on the real local runtime (workerd, local D1/R2/Queue/Workflow),
// through the Bun UI proxy, with a throwaway state dir and its own ports. Real logins only.
//   bun run test:e2e      (LINKLOG_E2E_UI_PORT / LINKLOG_E2E_API_PORT to change ports 3197/8897)
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lensFingerprint } from "@linklog/browser-protocol";
import { waitForMail } from "./lib/local-mail";

const uiPort = Number(process.env.LINKLOG_E2E_UI_PORT || 3197);
const apiPort = Number(process.env.LINKLOG_E2E_API_PORT || 8897);
const stateDir = mkdtempSync(join(tmpdir(), "linklog-e2e-"));
Object.assign(process.env, {
  LINKLOG_UI_PORT: String(uiPort),
  LINKLOG_API_PORT: String(apiPort),
  LINKLOG_PERSIST_TO: stateDir,
  LINKLOG_APP_ENV: "test",
  LINKLOG_WRANGLER_LOCAL: "1",
});
const { wranglerDevArgs } = await import("./dev");
const UI = `http://127.0.0.1:${uiPort}`;
const API = `http://127.0.0.1:${apiPort}`;
const PASSWORD = "e2e correct horse battery";
const results: string[] = [];
const pass = (name: string) => (results.push(name), console.log(`PASS ${name}`));

let worker: ReturnType<typeof Bun.spawn> | undefined;
let ui: ReturnType<typeof Bun.spawn> | undefined;
const logs: string[] = [];

async function waitFor(url: string, ok: (status: number) => boolean) {
  for (let i = 0; i < 600; i++) {
    try {
      if (ok((await fetch(url)).status)) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
async function capture(stream: ReadableStream<Uint8Array> | null) {
  if (!stream) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) logs.push(decoder.decode(chunk));
}
async function startWorker() {
  worker = Bun.spawn(wranglerDevArgs(), { stdout: "pipe", stderr: "pipe" });
  void capture(worker.stdout as ReadableStream<Uint8Array>);
  void capture(worker.stderr as ReadableStream<Uint8Array>);
  await waitFor(`${API}/api/library`, (s) => s === 401);
}
async function stopWorker() {
  worker?.kill();
  await worker?.exited;
}

const cookieOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => !c.endsWith("=")).join("; ");
async function viaUi(path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  return fetch(UI + path, {
    method,
    redirect: "manual",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { origin: init.origin ?? UI, "sec-fetch-site": "same-origin" } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
async function follow(link: string) {
  const url = new URL(link);
  assert.equal(url.origin, UI, "emailed links point at the public (proxy) origin");
  return viaUi(url.pathname + url.search);
}
async function d1(sql: string) {
  const run = Bun.spawnSync(["bunx", "wrangler", "d1", "execute", "linklog", "--local", "--persist-to", stateDir, "--json", "--command", sql], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return (JSON.parse(run.stdout.toString()) as { results: Record<string, unknown>[] }[])[0]!.results;
}

try {
  const migrate = Bun.spawnSync(["bunx", "wrangler", "d1", "migrations", "apply", "linklog", "--local", "--persist-to", stateDir], { stdout: "pipe", stderr: "pipe" });
  assert.equal(migrate.exitCode, 0, migrate.stderr.toString());
  await startWorker();
  ui = Bun.spawn(["bun", "src/index.ts"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  await waitFor(`${UI}/api/library`, (s) => s === 401);

  // 1. Password sign-up + verification through the proxy (redirect + Set-Cookie reach the browser).
  let since = Date.now();
  const signUp = await viaUi("/api/auth/sign-up/email", { body: { email: "a@e2e.test", password: PASSWORD, name: "A", callbackURL: "/" } });
  assert.equal(signUp.status, 200);
  assert.equal((await viaUi("/api/auth/sign-in/email", { body: { email: "a@e2e.test", password: PASSWORD } })).status, 403);
  const verified = await follow(await waitForMail("a@e2e.test", "verify", since));
  assert.equal(verified.status, 302);
  assert.equal(verified.headers.get("location"), "/");
  assert.match(verified.headers.getSetCookie().join(";"), /linklog\.session_token=.+HttpOnly/);
  let cookieA = cookieOf(verified);
  assert.equal((await viaUi("/api/library", { cookie: cookieA })).status, 200);
  pass("sign-up -> unverified sign-in refused -> emailed verification -> session via proxy");

  // 2. The session lives in D1 and survives a Worker restart (same state dir and secret).
  await stopWorker();
  await startWorker();
  assert.equal((await viaUi("/api/library", { cookie: cookieA })).status, 200);
  pass("session persists across Worker restart");

  // 3. Magic link for a new user B; single use.
  since = Date.now();
  assert.equal((await viaUi("/api/auth/sign-in/magic-link", { body: { email: "b@e2e.test", callbackURL: "/", errorCallbackURL: "/" } })).status, 200);
  const magic = await waitForMail("b@e2e.test", "magic", since);
  const magicHit = await follow(magic);
  assert.equal(magicHit.status, 302);
  const cookieB = cookieOf(magicHit);
  assert.ok(cookieB.includes("linklog.session_token="));
  const replay = await follow(magic);
  assert.equal(cookieOf(replay), "");
  assert.match(replay.headers.get("location") ?? "", /error=/);
  pass("magic link creates account, signs in once, replay rejected");

  // 4. Origin enforcement through the proxy.
  assert.equal((await viaUi("/api/links", { body: { url: "https://example.com/x" }, cookie: cookieA, origin: "https://evil.example" })).status, 403);
  assert.equal((await viaUi("/api/auth/sign-out", { body: {}, cookie: cookieA, origin: "https://evil.example" })).status, 403);
  pass("foreign Origin rejected by app routes and Better Auth");

  // 5. Two owners, same URL/tag/lens; foreign IDs rejected; R2 content private.
  const asUser = (cookie: string) => ({
    get: (p: string) => viaUi(p, { cookie }),
    send: (p: string, body: unknown = {}, method = "POST") => viaUi(p, { cookie, body, method }),
  });
  const A = asUser(cookieA), B = asUser(cookieB);
  const linkA = ((await (await A.send("/api/links", { url: "https://example.com/same", tags: ["shared"] })).json()) as { id: string }).id;
  const linkB = ((await (await B.send("/api/links", { url: "https://example.com/same", tags: ["shared"] })).json()) as { id: string }).id;
  assert.notEqual(linkA, linkB);
  assert.equal((await A.send("/api/lenses", { name: "Same lens", type: "noul", question: "?" })).status, 200);
  assert.equal((await B.send("/api/lenses", { name: "Same lens", type: "noul", question: "?" })).status, 200);
  const libA = (await (await A.get("/api/library")).json()) as { links: { id: string }[]; tags: { id: string }[]; lenses: { id: string }[]; batches: { id: string; active: number }[] };
  const libB = (await (await B.get("/api/library")).json()) as typeof libA;
  assert.deepEqual(libA.links.map((l) => l.id), [linkA]);
  assert.deepEqual(libB.links.map((l) => l.id), [linkB]);
  for (const [name, pending] of [
    ["content GET", B.get(`/api/links/${linkA}/content`)],
    ["content PUT", B.send(`/api/links/${linkA}/content`, { markdown: "x" }, "PUT")],
    ["link PATCH", B.send(`/api/links/${linkA}`, { tags: [] }, "PATCH")],
    ["link DELETE", B.send(`/api/links/${linkA}`, {}, "DELETE")],
    ["tag DELETE", B.send(`/api/tags/${libA.tags[0]!.id}`, {}, "DELETE")],
    ["lens DELETE", B.send(`/api/lenses/${libA.lenses[0]!.id}`, {}, "DELETE")],
    ["batch GET", B.get(`/api/batches/${libA.batches[0]!.id}`)],
    ["batch DELETE", B.send(`/api/batches/${libA.batches[0]!.id}`, {}, "DELETE")],
  ] as const)
    assert.equal((await pending).status, 404, name);
  assert.equal((await B.send("/api/batches", { ids: [linkA], kind: "extract" })).status, 400);
  pass("same URL/tag/lens per owner; B gets 404/400 on A's link, tag, lens, batch and content");

  // 6. Background processing (Queue -> Workflow) and R2 under the real runtime.
  for (let i = 0; i < 120; i++) {
    const [a, b] = await Promise.all([A.get("/api/library"), B.get("/api/library")]);
    const busy = [(await a.json()) as typeof libA, (await b.json()) as typeof libA].some((l) => l.batches.some((x) => x.active > 0));
    if (!busy) break;
    await Bun.sleep(1000);
  }
  assert.equal((await A.send(`/api/links/${linkA}/content`, { markdown: "# A private" }, "PUT")).status, 200);
  assert.deepEqual(await (await A.get(`/api/links/${linkA}/content`)).json(), { markdown: "# A private" });
  assert.equal((await B.get(`/api/links/${linkA}/content`)).status, 404);
  const [owners] = await d1(
    `SELECT (SELECT count(*) FROM jobs j JOIN links l ON l.id=j.link_id JOIN batches b ON b.id=j.batch_id WHERE l.user_id IS NOT b.user_id) cross_jobs,
            (SELECT count(*) FROM usage_events u JOIN batches b ON b.id=u.batch_id WHERE u.user_id IS NOT b.user_id) cross_usage,
            (SELECT count(*) FROM link_tags lt JOIN links l ON l.id=lt.link_id JOIN tags t ON t.id=lt.tag_id WHERE l.user_id IS NOT t.user_id) cross_tags,
            (SELECT count(*) FROM jobs WHERE status IN ('done','failed')) settled,
            (SELECT content_key FROM links WHERE id='${linkA}') key`,
  );
  assert.equal(owners!.cross_jobs, 0);
  assert.equal(owners!.cross_usage, 0);
  assert.equal(owners!.cross_tags, 0);
  assert.ok(String(owners!.key).startsWith("users/"), "R2 key is owner-prefixed");
  const usageA = (await (await A.get("/api/usage")).json()) as { events: { link_id: string | null }[] };
  const usageB = (await (await B.get("/api/usage")).json()) as typeof usageA;
  assert.ok(usageA.events.every((e) => e.link_id === null || e.link_id === linkA));
  assert.ok(usageB.events.every((e) => e.link_id === null || e.link_id === linkB));
  pass(`workflow jobs settled (${owners!.settled}) without cross-owner rows; R2 owner prefix; usage per owner`);

  // 6b. Browser view: per-account library id, a capture evaluated by Queue -> Workflow with the
  //     fixture Jev provider, and every Browser route closed to the other account.
  type Catalog = { libraryId: string; groups: { id: string }[] };
  const catA = (await (await A.get("/api/browser/catalog")).json()) as Catalog;
  const catB = (await (await B.get("/api/browser/catalog")).json()) as Catalog;
  assert.notEqual(catA.libraryId, catB.libraryId);
  assert.equal((await A.send("/api/lenses", { name: "Tab triage", type: "noul", question: "Worth keeping open?", scope: "browser" })).status, 200);
  const browserLens = ((await (await A.get("/api/library")).json()) as { lenses: { id: string; name: string; type: string; question: string; options: unknown[]; levels: unknown[]; criteria: unknown }[] }).lenses.find((l) => l.name === "Tab triage")!;
  const evaluation = {
    requestId: "e2e-req-a",
    libraryId: catA.libraryId,
    sessionId: "e2e-session",
    kind: "lens",
    lens: { id: browserLens.id, fingerprint: lensFingerprint(browserLens as never) },
    targets: [{ targetKey: "tab-1", url: "https://example.com/tab", title: "Tab", capture: { source: "dom", capturedAt: new Date().toISOString(), completeness: "complete", reasons: [], facts: [], markdown: "A page about testing jev:yes" } }],
  };
  assert.equal((await B.send("/api/browser/evaluations", { ...evaluation, lens: { id: browserLens.id, fingerprint: "x" }, libraryId: catB.libraryId })).status, 404, "B can't run A's lens");
  assert.equal((await A.send("/api/browser/evaluations", evaluation)).status, 201);
  let status: { targets: { state: string; answer?: { noul: number } }[] } = { targets: [] };
  for (let i = 0; i < 60; i++) {
    status = (await (await A.get("/api/browser/evaluations/e2e-req-a")).json()) as typeof status;
    if (status.targets[0]?.state === "done" || status.targets[0]?.state === "failed") break;
    await Bun.sleep(1000);
  }
  assert.equal(status.targets[0]?.state, "done", JSON.stringify(status));
  assert.equal(status.targets[0]?.answer?.noul, 0.95);
  assert.equal((await B.get("/api/browser/evaluations/e2e-req-a")).status, 404);
  assert.equal((await B.send("/api/browser/evaluations/e2e-req-a/ack", { targetKeys: ["tab-1"] })).status, 404);
  assert.equal((await B.send("/api/browser/evaluations/e2e-req-a", { targetKeys: ["tab-1"] }, "DELETE")).status, 404);
  assert.equal((await B.send("/api/browser/evaluations", { ...evaluation, libraryId: catB.libraryId })).status, 409, "A's request id is not B's");
  assert.equal((await A.send("/api/browser/groups", { id: "e2e-group", name: "Work", color: "blue" })).status, 201);
  assert.equal((await B.send("/api/browser/groups/e2e-group", { name: "x" }, "PATCH")).status, 404);
  assert.deepEqual(((await (await B.get("/api/browser/catalog")).json()) as Catalog).groups, []);
  assert.equal((await A.send("/api/browser/evaluations/e2e-req-a/ack", { targetKeys: ["tab-1"] })).status, 200);
  const [browserRows] = await d1(
    `SELECT (SELECT user_id FROM browser_requests WHERE request_id='e2e-req-a') req_owner,
            (SELECT count(*) FROM usage_events u JOIN jobs j ON j.id=u.job_id WHERE j.target_id IS NOT NULL AND u.user_id IS NOT (SELECT user_id FROM browser_requests WHERE request_id='e2e-req-a')) foreign_usage,
            (SELECT count(*) FROM usage_events u JOIN jobs j ON j.id=u.job_id WHERE j.target_id IS NOT NULL) browser_usage,
            (SELECT count(*) FROM browser_targets WHERE capture_key IS NOT NULL) snapshots,
            (SELECT user_id FROM browser_groups WHERE id='e2e-group') group_owner`,
  );
  const ownerA = ((await (await A.get("/api/auth/get-session")).json()) as { user: { id: string } }).user.id;
  assert.equal(browserRows!.req_owner, ownerA);
  assert.equal(browserRows!.group_owner, ownerA);
  assert.equal(browserRows!.foreign_usage, 0);
  assert.equal(browserRows!.browser_usage, 1);
  assert.equal(browserRows!.snapshots, 0, "acked snapshot removed from R2");
  const usageBrowserB = (await (await B.get("/api/usage")).json()) as { events: { provider: string }[] };
  assert.ok(usageBrowserB.events.every((e) => e.provider !== "fixture"));
  pass("Browser: per-account library id; A's capture evaluated via Queue/Workflow; B gets 404/409 on A's request, lens and group; usage per owner");

  // 7. Password reset revokes A's sessions; logout ends B's.
  since = Date.now();
  assert.equal((await viaUi("/api/auth/request-password-reset", { body: { email: "a@e2e.test", redirectTo: "/reset-password" } })).status, 200);
  const callback = await follow(await waitForMail("a@e2e.test", "reset", since));
  assert.equal(callback.status, 302);
  const token = new URL(callback.headers.get("location")!, UI).searchParams.get("token")!;
  assert.equal((await viaUi("/api/auth/reset-password", { body: { newPassword: "e2e a new password", token } })).status, 200);
  assert.equal((await viaUi("/api/library", { cookie: cookieA })).status, 401);
  const relogin = await viaUi("/api/auth/sign-in/email", { body: { email: "a@e2e.test", password: "e2e a new password" } });
  assert.equal(relogin.status, 200);
  cookieA = cookieOf(relogin);
  assert.equal((await viaUi("/api/library", { cookie: cookieA })).status, 200);
  assert.equal((await viaUi("/api/auth/sign-out", { body: {}, cookie: cookieB })).status, 200);
  assert.equal((await viaUi("/api/library", { cookie: cookieB })).status, 401);
  pass("reset revokes sessions, new password works, logout ends the session");

  // 8. D1-backed rate limit under concurrency (direct to the Worker with one client IP).
  const burst = await Promise.all(
    Array.from({ length: 10 }, () =>
      fetch(`${API}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: UI, "cf-connecting-ip": "198.51.100.77" },
        body: JSON.stringify({ email: "a@e2e.test", password: "wrong wrong wrong" }),
      }),
    ),
  );
  const statuses = burst.map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 429).length, 5, `statuses ${statuses}`);
  pass("10 concurrent sign-ins from one IP: exactly 5 allowed on real D1");

  // 9. Nothing sensitive in Worker output.
  const output = logs.join("");
  for (const secret of [PASSWORD, "e2e a new password", token, cookieA.split("=")[1]!, new URL(magic).searchParams.get("token")!])
    if (output.includes(secret)) {
      const line = output.split("\n").find((l) => l.includes(secret))!;
      throw new Error(`Worker output contains a secret: ${line.replaceAll(secret, "<redacted>").slice(0, 200)}`);
    }
  pass("Worker logs contain no passwords, tokens or cookies");

  console.log(`\nE2E OK (${results.length} checks). State ${stateDir}, UI ${UI}, API ${API}`);
} catch (error) {
  console.error("E2E FAILED:", error);
  console.error(logs.join("").split("\n").slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  ui?.kill();
  await stopWorker();
  rmSync(stateDir, { recursive: true, force: true });
}
