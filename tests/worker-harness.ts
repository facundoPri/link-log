// Drives the real Worker fetch handler, LinkWorkflow and dispatch against in-memory SQLite
// (all migrations). Only the network-facing preview and content extraction are faked.
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { mock, setSystemTime } from "bun:test";
import * as metadata from "../worker/metadata";
import * as adapters from "../worker/adapters";
import { needsAttention } from "../src/attention";
import type { Link } from "../src/types";

type Meta = { status: "ready" | "failed" } | { throws: string };
export const fakes: { meta: Meta; content: { markdown: string } | { throws: string } } = {
  meta: { status: "ready" },
  content: { markdown: "# page" },
};
mock.module("../worker/metadata", () => ({
  ...metadata,
  extractMetadata: async (url: string) => {
    const meta = fakes.meta;
    if ("throws" in meta) throw new Error(meta.throws);
    const domain = new URL(url).hostname;
    return { url, domain, title: meta.status === "ready" ? `Title of ${domain}` : domain, description: "", image: null, favicon: null, status: meta.status };
  },
}));
mock.module("../worker/adapters", () => ({
  ...adapters,
  adapterFor: () => ({
    extract: async () => {
      const content = fakes.content;
      if ("throws" in content) throw new Error(content.throws);
      return { markdown: content.markdown, source: "web" };
    },
  }),
}));

const { default: worker, LinkWorkflow } = await import("../worker/index");
export const { dispatch } = await import("../worker/jobs");

function d1(db: Database) {
  const stmt = (sql: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: db.query(sql).all(...(params as never[])) }),
    first: async () => db.query(sql).get(...(params as never[])) ?? null,
    run: async () => ({ meta: { changes: db.query(sql).run(...(params as never[])).changes } }),
    _exec: () => db.query(sql).run(...(params as never[])),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (list: { _exec: () => { changes: number } }[]) =>
      db.transaction(() => list.map((s) => ({ meta: { changes: s._exec().changes } })))(),
  };
}

let clock = Date.parse("2026-09-29T12:00:00.000Z");
export const tick = (ms: number) => setSystemTime(new Date((clock += ms)));
export const resetClock = () => setSystemTime();

export async function setup() {
  tick(0);
  fakes.meta = { status: "ready" };
  fakes.content = { markdown: "# page" };
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const f of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort())
    db.exec(await Bun.file(`migrations/${f}`).text());
  const r2 = new Map<string, string>();
  const sent: { body: { id: string } }[] = [];
  const env = {
    DB: d1(db),
    CONTENT: {
      put: async (k: string, v: string) => void r2.set(k, v),
      get: async (k: string) => (r2.has(k) ? { text: async () => r2.get(k)! } : null),
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => {},
    },
    JOBS: { sendBatch: async (m: { body: { id: string } }[]) => void sent.push(...m) },
    JEV_PROVIDER: "fixture",
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
  // Minimal Workflow step: runs callbacks inline, honouring an explicit retry limit.
  const step = {
    do: async (_name: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      const limit = typeof a === "object" ? ((a as any).retries?.limit ?? 0) : 0;
      for (let i = 0; ; i++) {
        try { return await fn(); } catch (e) { if (i >= limit) throw e; }
      }
    },
    sleep: async () => {},
  };
  const runJob = async (jobId: string) => {
    const wf = new (LinkWorkflow as any)();
    wf.env = env;
    try { await wf.run({ payload: { id: jobId } }, step); } catch { /* record-failure already ran */ }
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
      err: l.content_error,
      job: job ? `${job.status}/${job.step}` : null,
    };
  };
  return { db, env, api, runQueued, runJob, view, sent };
}
