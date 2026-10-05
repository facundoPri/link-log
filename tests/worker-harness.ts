// Drives the real Worker fetch handler, LinkWorkflow and dispatch against in-memory SQLite
// (all migrations). Only the network-facing preview and content extraction are faked.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { mock, setSystemTime } from "bun:test";
import * as metadata from "../worker/metadata";
import * as adapters from "../worker/adapters";
import { needsAttention } from "../src/attention";
import { responseFailure } from "../worker/failures";
import { webAdapter } from "../worker/adapters/web";
import type { Link } from "../src/types";

type Meta = { status: "ready" | "failed"; description?: string } | { throws: string } | { http: number; type?: string; headers?: Record<string, string> };
type Content = { markdown: string } | { throws: string } | { error: unknown } | { pending: true } | { wait: Promise<string> };
// A list is consumed one item per call (the last item sticks), to script transient failures.
export const fakes: {
  meta: Meta | Meta[];
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
  content: { markdown: "# page" },
  calls: { meta: 0, content: 0, browser: 0 },
};
const next = <T>(v: T | T[]): T => (Array.isArray(v) ? (v.length > 1 ? v.shift()! : v[0]!) : v);
mock.module("../worker/metadata", () => ({
  ...metadata,
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
    return { url, domain, title: `Title of ${domain}`, description: ("status" in meta && meta.description) || "", image: null, favicon: null, status: "ready" as const };
  },
}));
mock.module("../worker/adapters", () => ({
  ...adapters,
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
}));

const { default: worker, LinkWorkflow } = await import("../worker/index");
export const { dispatch } = await import("../worker/jobs");

function d1(db: Database) {
  const check = (sql: string) => {
    if (fakes.failSql?.test(sql)) throw new Error("D1_ERROR: database unavailable (SQLITE_BUSY)");
    if (fakes.failSqlOnce?.test(sql)) {
      fakes.failSqlOnce = undefined;
      throw new Error("D1_ERROR: database unavailable (SQLITE_BUSY)");
    }
  };
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    sql,
    all: async () => {
      const results = db.query(sql).all(...(params as never[]));
      await fakes.onSql?.(sql, "read");
      return { results };
    },
    first: async () => {
      const row = db.query(sql).get(...(params as never[])) ?? null;
      await fakes.onSql?.(sql, "read");
      return row;
    },
    run: async () => (await fakes.onSql?.(sql, "write"), check(sql), { meta: { changes: db.query(sql).run(...(params as never[])).changes } }),
    _exec: () => (check(sql), db.query(sql).run(...(params as never[]))),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { sql: string; _exec: () => { changes: number } }[]) => {
      for (const s of list) await fakes.onSql?.(s.sql, "write");
      return db.transaction(() => list.map((s) => ({ meta: { changes: s._exec().changes } })))();
    },
  };
}

let clock = Date.parse("2026-09-29T12:00:00.000Z");
export const tick = (ms: number) => setSystemTime(new Date((clock += ms)));
export const resetClock = () => setSystemTime();

export async function setup() {
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
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(await Bun.file(`migrations/${f}`).text());
  const r2 = new Map<string, string>();
  const sent: { body: { id: string } }[] = [];
  // Workflow instances as cancel sees them. `terminate`: "stop" ends the instance after its current step
  // (the step's own writes still land, nothing after it runs); "ignore" lets the workflow carry on, like a
  // terminate that came too late; "ended" and "throw" make terminate fail with an ended or a live instance.
  const workflows = { terminate: "stop" as "stop" | "ignore" | "ended" | "throw", terminated: [] as string[] };
  const stopped = new Set<string>();
  const env = {
    DB: d1(db),
    CONTENT: {
      put: async (k: string, v: string) => void r2.set(k, v),
      get: async (k: string) => (r2.has(k) ? { text: async () => r2.get(k)! } : null),
      list: async () => ({ objects: [], truncated: false }),
      delete: async (keys: string | string[]) => void [keys].flat().forEach((k) => r2.delete(k)),
    },
    JOBS: { sendBatch: async (m: { body: { id: string } }[]) => void sent.push(...m) },
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
  const api = async (path: string, method = "GET", body?: unknown) => {
    const waits: Promise<unknown>[] = [];
    const res = await worker.fetch(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: { "content-type": "application/json" },
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
  const runJob = async (jobId: string) => {
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
  const runQueued = async () => {
    const ids = sent.splice(0).map((m) => m.body.id);
    for (const id of ids) await runJob(id);
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
  return { db, env, api, runQueued, runJob, view, sent, steps, engine, r2, workflows };
}
