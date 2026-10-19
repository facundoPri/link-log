// QA-only Worker entry: the real Linklog Worker (worker/index.ts, LinkWorkflow) with deterministic edges.
// Nothing here changes product code; it only wraps what the product reaches outside itself:
//  - global fetch: DoH lookups and preview fetches for fixture hosts are answered from qa/video/fixtures.ts,
//    the fake TypeSafe Jev endpoint is answered locally, and every other outbound fetch is refused
//    (QA_ALLOW_NET=1 lifts that), so a run can never reach a real site or a paid API by accident;
//  - env.BROWSER: a fake Browser Rendering binding whose quickAction answers from the same catalog;
//  - the Workflow step: with QA_FAST_RETRIES=1 every retry backoff is 1 s (product timing otherwise).
import worker, { LinkWorkflow as ProductWorkflow } from "../../worker/index";
import { fixtureJev } from "../../worker/ai/fixture";
import { FIXTURE_IP, fixtureFor, type BrowserSpec, type PreviewSpec } from "./fixtures";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

type QaEnv = Env & { QA_ALLOW_NET?: string; QA_FAST_RETRIES?: string };

const realFetch = globalThis.fetch.bind(globalThis);
/** The latest env seen, for the retry counters (R2). Bindings are the same for every request. */
let current: QaEnv | null = null;
const memoryCounters = new Map<string, number>();

function sleep(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/** Increments and returns how many times `key` was seen. Durable in R2 so it holds across isolates. */
async function hit(key: string): Promise<number> {
  const env = current;
  if (!env?.CONTENT) {
    const n = (memoryCounters.get(key) ?? 0) + 1;
    memoryCounters.set(key, n);
    return n;
  }
  const k = `qa/counters/${encodeURIComponent(key)}`;
  const n = Number((await (await env.CONTENT.get(k))?.text()) ?? 0) + 1;
  await env.CONTENT.put(k, String(n));
  return n;
}

const fill = (text: string, url: URL) => text.replaceAll("{path}", url.pathname.replace(/^\/+/, "") || "/");

async function previewResponse(spec: PreviewSpec, url: URL, signal: AbortSignal | null): Promise<Response> {
  if ("delayMs" in spec && spec.delayMs) await sleep(spec.delayMs, signal);
  switch (spec.kind) {
    case "html": {
      const title = fill(spec.title, url);
      const description = fill(spec.description ?? "A deterministic QA fixture page.", url);
      return new Response(
        `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"><meta property="og:site_name" content="QA fixtures"></head><body><h1>${title}</h1><p>${description}</p></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    case "pdf":
      return new Response("%PDF-1.4\n% QA fixture\n", { headers: { "content-type": "application/pdf" } });
    case "status":
      return new Response(`HTTP ${spec.status}`, { status: spec.status, headers: { "content-type": "text/html", ...spec.headers } });
    case "flaky":
      return (await hit(`preview ${url.href}`)) <= spec.failures
        ? new Response(`HTTP ${spec.status}`, { status: spec.status, headers: { "content-type": "text/html" } })
        : previewResponse(spec.then, url, signal);
  }
}

async function browserResponse(spec: BrowserSpec, url: URL): Promise<Response> {
  switch (spec.kind) {
    case "markdown":
      if (spec.delayMs) await sleep(spec.delayMs);
      return Response.json({ success: true, result: fill(spec.markdown, url) }, { headers: { "x-browser-ms-used": String(spec.browserMs ?? 900) } });
    case "error":
      if (spec.delayMs) await sleep(spec.delayMs);
      return Response.json({ success: false, errors: [{ code: spec.code ?? spec.status, message: spec.message }] }, { status: spec.status, headers: { "x-browser-ms-used": "0" } });
    case "flaky":
      return (await hit(`browser ${url.href}`)) <= spec.failures ? browserResponse(spec.error, url) : browserResponse(spec.then, url);
    case "hang":
      return new Promise<Response>(() => {});
  }
}

/** Fake TypeSafe Jev: the key `qa-fake-invalid` gets 401 (a wrong key); otherwise a `qa:jev-http=<status>` marker
 * in the content picks the error, and anything else gets fixture answers. Each call is logged (`qa_fake_typesafe`). */
async function fakeTypesafe(request: Request): Promise<Response> {
  const body = (await request.json()) as { state: unknown; questions: Parameters<typeof fixtureJev>[0]["questions"] };
  const badKey = request.headers.get("authorization") === "Bearer qa-fake-invalid";
  const status = badKey ? 401 : Number(JSON.stringify(body.state).match(/qa:jev-http=(\d{3})/)?.[1] ?? 0);
  console.log(JSON.stringify({ event: "qa_fake_typesafe", status: status || 200 }));
  if (status) {
    const message = status === 402 ? "Insufficient balance: out of credits" : status === 401 ? "Unauthorized: invalid API key" : "Internal provider error";
    return Response.json({ error: { message } }, { status });
  }
  return Response.json(await fixtureJev(body));
}

globalThis.fetch = async function qaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input as RequestInfo, init);
  const url = new URL(request.url);
  if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
    const name = url.searchParams.get("name") ?? "";
    const fixture = fixtureFor(name);
    if (!fixture && current?.QA_ALLOW_NET === "1") return realFetch(input as RequestInfo, init);
    // Non-fixture hosts resolve to nothing: they read as "could not be reached", never as a real site.
    const answer = fixture && fixture.dns !== "nxdomain" && url.searchParams.get("type") === "A" ? [{ name, type: 1, TTL: 60, data: FIXTURE_IP }] : [];
    return Response.json({ Status: !fixture || fixture.dns === "nxdomain" ? 3 : 0, Answer: answer }, { headers: { "content-type": "application/dns-json" } });
  }
  const fixture = fixtureFor(url.hostname);
  if (fixture) return previewResponse(fixture.preview, url, init?.signal ?? request.signal);
  if (url.hostname === "api.typesafe.ai" && current?.TYPESAFE_API_KEY?.startsWith("qa-fake")) return fakeTypesafe(request);
  if (current?.QA_ALLOW_NET === "1") return realFetch(input as RequestInfo, init);
  console.log(JSON.stringify({ event: "qa_blocked_fetch", host: url.hostname }));
  throw new TypeError(`QA harness blocked network access to ${url.hostname}`);
} as typeof fetch;

const fakeBrowser = {
  async quickAction(action: string, options: { url: string }) {
    const url = new URL(options.url);
    const fixture = fixtureFor(url.hostname);
    console.log(JSON.stringify({ event: "qa_browser_quick_action", action, host: url.hostname }));
    if (!fixture) return Response.json({ success: false, errors: [{ code: 404, message: "QA harness: not a fixture host" }] }, { status: 404 });
    return browserResponse(fixture.browser ?? { kind: "markdown", markdown: `# ${url.hostname}\n\nGeneric QA content for {path}.` }, url);
  },
};

function qaEnv(env: QaEnv): QaEnv {
  current = env;
  return Object.assign(Object.create(env), { ...env, BROWSER: fakeBrowser }) as QaEnv;
}

function fastStep(step: WorkflowStep): WorkflowStep {
  const faster = (config: unknown) => {
    if (!config || typeof config !== "object" || !("retries" in config)) return config;
    const c = config as { retries: { limit: number; delay: string | number; backoff?: string } };
    return { ...c, retries: { ...c.retries, delay: "1 second", backoff: "constant" } };
  };
  // The step is an RPC stub: any property read (even `.call` or `.bind`) becomes a remote method, so a Proxy
  // can't wrap it. Delegate the four methods explicitly instead.
  const s = step as unknown as Record<string, (...args: unknown[]) => unknown>;
  return {
    do: (name: string, a: unknown, b?: unknown) => (b === undefined ? s.do!(name, a) : s.do!(name, faster(a), b)),
    sleep: (name: string, duration: unknown) => s.sleep!(name, duration),
    sleepUntil: (name: string, until: unknown) => s.sleepUntil!(name, until),
    waitForEvent: (name: string, options: unknown) => s.waitForEvent!(name, options),
  } as unknown as WorkflowStep;
}

export class LinkWorkflow extends ProductWorkflow {
  constructor(ctx: ExecutionContext, env: QaEnv) {
    super(ctx as never, qaEnv(env));
  }
  override async run(event: WorkflowEvent<{ id: string }>, step: WorkflowStep) {
    return super.run(event, (this.env as QaEnv).QA_FAST_RETRIES === "1" ? fastStep(step) : step);
  }
}

export default {
  queue: (batch, env) => (worker.queue as (b: typeof batch, e: Env) => Promise<void>)(batch, qaEnv(env)),
  scheduled: (event, env, ctx) => worker.scheduled!(event, qaEnv(env), ctx),
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Harness probe: proves the QA entry (not the product one) is serving.
    if (url.pathname === "/api/__qa/health") return Response.json({ qa: true, fastRetries: env.QA_FAST_RETRIES === "1", jev: env.JEV_PROVIDER });
    return worker.fetch!(request, qaEnv(env), ctx);
  },
} satisfies ExportedHandler<QaEnv, { id: string }>;
