// Drives the real Worker fetch handler, LinkWorkflow, dispatch and the Jev queue consumer against in-memory
// SQLite (all migrations). Only the network-facing preview and content extraction are faked.
import { TestD1 } from "./support/d1";
import { testSession } from "./support/auth.test-instance";
import { Database } from "bun:sqlite";
import { spyOn, setSystemTime } from "bun:test";
import * as metadata from "../worker/metadata";
import * as adapters from "../worker/adapters";
import { needsAttention } from "../src/attention";
import { responseFailure } from "../worker/failures";
import { webAdapter } from "../worker/adapters/web";
import type { Link } from "../src/types";
import wrangler from "../wrangler.jsonc";
import { isJevQueue, queueFor, type BatchKind } from "../worker/job-routing";

/** The local Jev queue consumer's settings, as deployed: its batch size times its concurrency caps Jev calls. */
export const jevConsumer = (wrangler.queues.consumers as { queue: string; max_batch_size: number; max_concurrency: number; max_retries: number }[])
  .find((c) => isJevQueue(c.queue))!;
/** A message waiting in the Jev queue. `attempts` counts its deliveries, like Message.attempts. */
export type QueuedMessage = { id: string; body: { id: string }; attempts: number };

type Meta = { status: "ready" | "failed"; description?: string; title?: string; title_source?: string } | { throws: string } | { http: number; type?: string; headers?: Record<string, string> };
type Content = { markdown: string } | { throws: string } | { error: unknown } | { pending: true } | { wait: Promise<string> };
// A list is consumed one item per call (the last item sticks), to script transient failures.
export const fakes: {
  meta: Meta | Meta[];
  placeholder: boolean;
  content: Content | Content[];
  calls: { meta: number; content: number; browser: number };
  onMeta?: () => Promise<void>;
  onContent?: () => Promise<void>;
  /** Run the real web adapter against this Browser Rendering answer instead of the fake content. */
  browser?: (action: string, options: Record<string, any>) => Response | Promise<Response>;
  /** Make the link's adapter a discovering (social-style) one that throws this error. */
  discoverError?: string;
  /** Make the link's adapter a discovering one that finds this. */
  discover?: () => unknown;
  /** Make D1 statements matching this pattern fail like a busy database. */
  failSql?: RegExp;
  /** Like failSql, but only the first matching write fails. */
  failSqlOnce?: RegExp;
  /** Runs after a read and before a write (or a batch's writes), to interleave other requests. */
  onSql?: (sql: string, phase: "read" | "write") => Promise<void>;
} = {
  meta: { status: "ready" },
  placeholder: false,
  content: { markdown: "# page" },
  calls: { meta: 0, content: 0, browser: 0 },
};
const next = <T>(v: T | T[]): T => (Array.isArray(v) ? (v.length > 1 ? v.shift()! : v[0]!) : v);
const metadataFake = {
  extractMetadata: async (url: string) => {
    fakes.calls.meta++;
    await fakes.onMeta?.();
    const meta = next(fakes.meta);
    if ("throws" in meta) throw new Error(meta.throws);
    // A failed preview is the 403 bot wall unless an explicit HTTP answer is scripted.
    const http = "http" in meta ? meta : meta.status === "failed" ? { http: 403 } : null;
    if (http) {
      const failure = responseFailure(new Response(null, { status: http.http, headers: { "content-type": http.type ?? "text/html", ...http.headers } }));
      if (failure) throw failure;
    }
    const domain = new URL(url).hostname;
    return { url, domain, title: "status" in meta && meta.title !== undefined ? meta.title : fakes.placeholder ? domain : `Title of ${domain}`, description: ("status" in meta && meta.description) || "", image: null, favicon: null, status: "ready" as const };
  },
};
const adaptersFake = {
  adapterFor: () => fakes.browser ? webAdapter : fakes.discover ? ({ name: "x", discover: async () => fakes.discover!() }) : fakes.discoverError ? ({
    name: "x",
    discover: async () => { throw new Error(fakes.discoverError); },
  }) : ({
    name: "web",
    extract: async () => {
      fakes.calls.content++;
      await fakes.onContent?.();
      const content = next(fakes.content);
      if ("throws" in content) throw new Error(content.throws);
      if ("error" in content) throw content.error;
      if ("pending" in content) return new Promise(() => {});
      if ("wait" in content) return { markdown: await content.wait, source: "web" }; // ignores the abort signal
      return { markdown: content.markdown, source: "web" };
    },
  }),
};

const { default: worker, LinkWorkflow } = await import("../worker/index");
export const { dispatch } = await import("../worker/jobs");

function d1(db: Database) {
  const adapter = new TestD1(db);
  const check = (sql: string) => {
    if (fakes.failSql?.test(sql)) throw new Error("D1_ERROR: database unavailable (SQLITE_BUSY)");
    if (fakes.failSqlOnce?.test(sql)) { fakes.failSqlOnce = undefined; throw new Error("D1_ERROR: database unavailable (SQLITE_BUSY)"); }
  };
  const stmt = (sql: string, params: unknown[] = []) => {
    const execute = () => { check(sql); return adapter.run(sql, params); };
    const read = async () => { const result = execute(); await fakes.onSql?.(sql, "read"); return result; };
    return {
      sql, bind: (...p: unknown[]) => stmt(sql,p),
      all: read,
      first: async (column?: string) => { const row = (await read()).results[0]; return row ? column ? row[column] : row : null; },
      raw: async () => (await read()).results.map(row => Object.values(row)),
      run: async () => { await fakes.onSql?.(sql, "write"); return execute(); },
      _exec: execute,
    };
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { sql: string; _exec: () => unknown }[]) => {
      for (const s of list) await fakes.onSql?.(s.sql, "write");
      return db.transaction(() => list.map(s => s._exec()))();
    },
  };
}

let clock = Date.parse("2026-09-29T12:00:00.000Z");
export const tick = (ms: number) => setSystemTime(new Date((clock += ms)));
const spies: { mockRestore(): void }[] = [];
export const resetClock = () => { for (const s of spies.splice(0)) s.mockRestore(); setSystemTime(); };

export async function setup(options: { placeholder?: boolean } = {}) {
  for (const s of spies.splice(0)) s.mockRestore();
  spies.push(spyOn(metadata, "extractMetadata").mockImplementation(metadataFake.extractMetadata), spyOn(adapters, "adapterFor").mockImplementation(adaptersFake.adapterFor as typeof adapters.adapterFor));
  fakes.placeholder = !!options.placeholder;
  tick(0);
  fakes.meta = { status: "ready" };
  fakes.content = { markdown: "# page" };
  fakes.calls = { meta: 0, content: 0, browser: 0 };
  fakes.onMeta = undefined;
  fakes.onContent = undefined;
  fakes.browser = undefined;
  fakes.failSql = undefined;
  fakes.failSqlOnce = undefined;
  fakes.onSql = undefined;
  fakes.discoverError = undefined;
  fakes.discover = undefined;
  const db = new Database(":memory:");
  const adapter = new TestD1(db);
  await adapter.migrate();
  const r2 = new Map<string, string>();
  const sent: { body: { id: string } }[] = [];
  const jevSent: QueuedMessage[] = [];
  // Every Jev queue delivery and how it ended: acknowledged, retried (with its delay), or its invocation killed.
  const deliveries: { job: string; message: string; attempts: number; outcome: "ack" | "retry" | "killed"; delaySeconds?: number }[] = [];
  const dropped: QueuedMessage[] = [];
  // `timeoutMs` ends a consumer invocation like the platform's time limit: its unacknowledged messages are
  // redelivered while the abandoned invocation keeps running here (a real one would be gone).
  const queue: { timeoutMs?: number } = {};
  // Workflow instances as cancel sees them. `terminate`: "stop" ends the instance after its current step
  // (the step's own writes still land, nothing after it runs); "ignore" lets the workflow carry on, like a
  // terminate that came too late; "ended" and "throw" make terminate fail with an ended or a live instance.
  const workflows = { terminate: "stop" as "stop" | "ignore" | "ended" | "throw", terminated: [] as string[] };
  const stopped = new Set<string>();
  const instrumented = d1(db);
  const env = {
    APP_ENV: "test",
    BETTER_AUTH_URL: "http://localhost",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
    EMAIL: { send: async () => ({ messageId: "test" }) },

    DB: { prepare: instrumented.prepare, batch: instrumented.batch, exec: (sql: string) => adapter.exec(sql) },
    CONTENT: {
      put: async (k: string, v: string) => void r2.set(k, v),
      get: async (k: string) => (r2.has(k) ? { text: async () => r2.get(k)! } : null),
      list: async () => ({ objects: [], truncated: false }),
      delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => r2.delete(k)),
    },
    JOBS: { sendBatch: async (m: { body: { id: string } }[]) => void sent.push(...m) },
    JEV_JOBS: { sendBatch: async (m: { body: { id: string } }[]) => void jevSent.push(...m.map(({ body }) => ({ id: crypto.randomUUID(), body, attempts: 1 }))) },
    JEV_PROVIDER: "fixture",
    BROWSER: { quickAction: async (action: string, options: Record<string, any>) => (fakes.calls.browser++, fakes.browser!(action, options)) },
    PROCESS_LINK: {
      create: async () => {},
      get: async (id: string) => ({
        terminate: async () => {
          if (workflows.terminate === "ended") throw new Error("Cannot terminate instance since its on a finite state");
          if (workflows.terminate === "throw") throw new Error("Network connection lost");
          workflows.terminated.push(id);
          if (workflows.terminate === "stop") stopped.add(id);
        },
        status: async () => ({ status: workflows.terminate === "ended" ? "complete" : stopped.has(id) ? "terminated" : "running" }),
      }),
    },
  } as unknown as Env;
  // Auth needs raw/returning as well as the race-aware shim used by lifecycle tests.
  const authEnv = { ...env, DB: adapter.d1 };
  const session = await testSession(authEnv, "lifecycle@example.test");
  const api = async (path: string, method = "GET", body?: unknown) => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: { "content-type": "application/json", origin: "http://localhost", cookie: session.cookie },
        body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      }) as never,
      env,
      { waitUntil: (p: Promise<unknown>) => void waits.push(p) } as never,
    );
    await Promise.all(waits);
    return { status: res.status, data: (await res.json()) as any };
  };
  // Minimal Workflow step: runs callbacks inline with ctx.attempt (1-based), honouring an explicit retry
  // limit and NonRetryableError. It records each retried step's config and attempts. With
  // `engine.timeoutMs`, a step with a timeout races its callback like the engine does (outside the callback).
  const engine: { timeoutMs?: number } = {};
  const steps: { name: string; retries?: { limit: number; delay: unknown; backoff?: string }; attempts: number }[] = [];
  const step = {
    do: async (name: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === "function" ? a : b) as (ctx: unknown) => Promise<unknown>;
      const config = typeof a === "object" ? (a as any) : {};
      const limit = config.retries?.limit ?? 0;
      const record = { name, retries: config.retries, attempts: 0 };
      steps.push(record);
      for (let i = 0; ; i++) {
        record.attempts++;
        try {
          const run = fn({ step: { name, count: 1 }, attempt: i + 1, config });
          if (!engine.timeoutMs || !config.timeout) return await run;
          return await Promise.race([run, new Promise((_, reject) => setTimeout(() => reject(Object.assign(
            new Error(`Execution timed out after ${engine.timeoutMs}ms`), { name: "WorkflowTimeoutError" })), engine.timeoutMs))]);
        }
        catch (e) { if (i >= limit || (e as Error)?.name === "NonRetryableError") throw e; }
      }
    },
    sleep: async () => {},
  };
  const runWorkflow = async (jobId: string) => {
    const wf = new (LinkWorkflow as any)();
    wf.env = env;
    const ended = () => Object.assign(new Error("Workflow terminated"), { name: "Terminated" });
    const own = {
      do: async (name: string, a: unknown, b?: unknown) => {
        if (stopped.has(jobId)) throw ended();
        const result = await step.do(name, a, b);
        if (stopped.has(jobId)) throw ended();
        return result;
      },
      sleep: step.sleep,
    };
    try { await wf.run({ payload: { id: jobId } }, own); } catch { /* record-failure already ran */ }
  };
  // One consumer invocation of the Jev queue with these messages, through the Worker's real queue handler.
  // A message neither acknowledged nor retried is acknowledged when the handler returns, and retried when it
  // throws or is killed. A retried message comes back with one more attempt, up to the queue's max_retries.
  const deliver = async (batch: QueuedMessage[]) => {
    const settled = new Map<QueuedMessage, { outcome: "ack" | "retry"; delaySeconds?: number }>();
    const mark = (m: QueuedMessage, outcome: "ack" | "retry", delaySeconds?: number) => void (settled.has(m) || settled.set(m, { outcome, delaySeconds }));
    const messages = batch.map((m) => ({
      id: m.id, timestamp: new Date(), body: m.body, attempts: m.attempts,
      ack: () => mark(m, "ack"),
      retry: (o?: { delaySeconds?: number }) => mark(m, "retry", o?.delaySeconds),
    }));
    const handled = (worker as any).queue({ queue: jevConsumer.queue, messages, ackAll: () => batch.forEach((m) => mark(m, "ack")), retryAll: () => batch.forEach((m) => mark(m, "retry")) }, env, { waitUntil: () => {} });
    const ended = await (queue.timeoutMs ? Promise.race([handled.then(() => "returned", () => "threw"), Bun.sleep(queue.timeoutMs).then(() => "killed")]) : handled.then(() => "returned", () => "threw"));
    for (const m of batch) {
      const result = ended === "killed" && !settled.has(m) ? { outcome: "killed" as const } : settled.get(m) ?? { outcome: ended === "returned" ? "ack" as const : "retry" as const };
      deliveries.push({ job: m.body.id, message: m.id, attempts: m.attempts, ...result });
      if (result.outcome === "ack") continue;
      if (m.attempts > jevConsumer.max_retries) dropped.push(m);
      else jevSent.push({ ...m, attempts: m.attempts + 1 });
    }
  };
  // Drains the Jev queue like the platform: up to max_concurrency invocations at once, each with up to
  // max_batch_size messages, until no message (new, promoted or retried) is left.
  const drainJev = async () => {
    const lane = async () => { while (jevSent.length) await deliver(jevSent.splice(0, jevConsumer.max_batch_size)); };
    while (jevSent.length) await Promise.all(Array.from({ length: jevConsumer.max_concurrency }, lane));
  };
  // Runs one job the way its queue would: a Workflow for the jobs queue, a single delivery for the Jev queue.
  const runJob = async (jobId: string) => {
    const { kind } = db.query("SELECT b.kind FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.id=?").get(jobId) as { kind: BatchKind };
    if (queueFor(env, { kind }) === env.JEV_JOBS) await deliver([{ id: crypto.randomUUID(), body: { id: jobId }, attempts: 1 }]);
    else await runWorkflow(jobId);
  };
  const runQueued = async () => {
    const ids = sent.splice(0).map((m) => m.body.id);
    for (const id of ids) await runWorkflow(id);
    await drainJev();
  };
  // What the UI sees after a reload: GET /api/library plus the shared Needs attention predicate.
  const view = async (id: string) => {
    const lib = (await api("/library")).data;
    const l = lib.links.find((x: Link) => x.id === id) as Link;
    const job = db.query("SELECT status,step,error FROM jobs WHERE link_id=? ORDER BY rowid DESC LIMIT 1").get(id) as any;
    return {
      status: l.status,
      content: l.content_state,
      processing: l.processing,
      previewing: l.previewing,
      attention: needsAttention(l),
      attention_kind: l.attention_kind,
      attention_reason: l.attention_reason,
      err: l.content_error,
      preview_reason: l.preview_reason,
      content_reason: l.content_reason,
      job: job ? `${job.status}/${job.step}` : null,
    };
  };
  return { db, env, api, userId: session.userId, runQueued, runJob, runWorkflow, deliver, drainJev, view, sent, jevSent, deliveries, dropped, queue, steps, engine, r2, workflows };
}
