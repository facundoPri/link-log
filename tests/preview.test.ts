import { describe, expect, test } from "bun:test";
import { Cloudflare } from "../scripts/preview/cloudflare";
import { authSecret, config, desired, names, type PullRequest } from "../scripts/preview/model";
import { cleanup, resources, settleDeployment } from "../scripts/preview/lifecycle";

const repo = "12345";
const pr = "5";
const n = names(repo, pr);
const dbId = "11111111-1111-1111-1111-111111111111";
const queueId = "2".repeat(32);
function pull(overrides: Partial<PullRequest> = {}): PullRequest {
  return { number: 5, state: "open", head: { sha: "a".repeat(40), repo: { id: 12345 } },
    base: { repo: { id: 12345 } }, labels: [{ name: "pr-preview" }], user: { login: "writer" }, ...overrides };
}
type Call = { method: string; path: string; body: any };
function mockCloud(handler: (call: Call) => { result?: unknown; status?: number; success?: boolean; result_info?: unknown }) {
  const calls: Call[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = new URL(String(url));
    const call = { method: init?.method ?? "GET", path: full.pathname.replace(`/client/v4/accounts/${"a".repeat(32)}`, "") + full.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const data = handler(call);
    return Response.json({ success: data.success ?? true, result: data.result, result_info: data.result_info }, { status: data.status ?? 200 });
  }) as typeof fetch;
  return { calls, cf: new Cloudflare("a".repeat(32), "fake-token", request) };
}
function existing(call: Call) {
  if (call.path.startsWith("/d1/database?")) return { result: [{ name: "linklog", uuid: "9".repeat(32) }, { name: n.db, uuid: dbId }] };
  if (call.path.startsWith("/queues?")) return { result: [{ queue_name: "linklog-jobs", queue_id: "9".repeat(32) }, { queue_name: n.queue, queue_id: queueId }] };
  if (call.path === `/queues/${queueId}` && call.method === "GET") return { result: { queue_name: n.queue, queue_id: queueId, consumers: [{ script_name: n.worker, consumer_id: "3".repeat(32) }] } };
  if (call.path === `/r2/buckets/${n.bucket}` && call.method === "GET") return { result: { name: n.bucket } };
  if (call.method === "DELETE") return { result: null };
  throw new Error(`Unexpected mock request ${call.method} ${call.path}`);
}

describe("preview trust and identity", () => {
  test("live label and state decide lifecycle, forks never deploy or clean up", () => {
    expect(desired(pull(), repo)).toBe("deploy");
    expect(desired(pull({ state: "closed" }), repo)).toBe("cleanup");
    expect(desired(pull({ labels: [] }), repo)).toBe("cleanup");
    expect(desired(pull({ head: { sha: "a".repeat(40), repo: { id: 999 } } }), repo)).toBe("skip");
    expect(desired(pull({ state: "closed", head: { sha: "a".repeat(40), repo: { id: 999 } } }), repo)).toBe("skip");
  });
  test("rejects ref, shell and path injection before generating resource names", () => {
    for (const value of ["../linklog", "5; echo secret", "$(env)", "-1", "0", "1\n2", "1/2", "01"]) {
      expect(() => names(repo, value)).toThrow();
      expect(() => names(value, pr)).toThrow();
    }
    expect(() => desired(pull({ head: { sha: "main;env", repo: { id: 12345 } } }), repo)).toThrow();
    expect(() => desired(pull(), "99")).toThrow();
  });
  test("auth stays stable per PR, distinct across PRs/repos, never stored in config", () => {
    const seed = "a-random-preview-only-seed-value-123456789";
    expect(authSecret(seed, repo, pr)).toBe(authSecret(seed, repo, pr));
    expect(authSecret(seed, repo, pr)).not.toBe(authSecret(seed, repo, "6"));
    expect(authSecret(seed, repo, pr)).not.toBe(authSecret(seed, "678", pr));
    expect(() => authSecret("short", repo, pr)).toThrow();
    const cfg = config(repo, pr, dbId, "preview-account", "auth@example.com");
    expect(cfg.vars.BETTER_AUTH_URL).toBe(`https://${n.worker}.preview-account.workers.dev`);
    expect(JSON.stringify(cfg)).not.toContain(seed);
    expect(cfg.d1_databases[0]?.database_name).toBe(n.db);
    expect(cfg.queues.consumers[0]?.queue).toBe(cfg.queues.producers[0]?.queue);
    expect(cfg.workflows[0]?.name).not.toBe("linklog-process-link");
    expect(cfg.ai.binding).toBe("AI");
    expect(cfg.browser.binding).toBe("BROWSER");
    expect(cfg.send_email[0]?.name).toBe("EMAIL");
    expect(() => config(repo, pr, dbId, "evil.workers.dev/path", "auth@example.com")).toThrow();
  });
});

describe("resource lifecycle against mock Cloudflare API", () => {
  test("a racing synchronize disables the stale URL without deleting users or content", async () => {
    const { cf, calls } = mockCloud(() => ({ result: {} }));
    expect(await settleDeployment(cf, repo, pr, { action: "deploy", sha: "b".repeat(40) }, "a".repeat(40))).toBe(false);
    expect(calls).toEqual([{ method: "POST", path: `/workers/scripts/${n.worker}/subdomain`, body: { enabled: false, previews_enabled: false } }]);
  });
  test("same head settlement leaves cloud state untouched", async () => {
    const { cf, calls } = mockCloud(() => { throw new Error("Unexpected request"); });
    expect(await settleDeployment(cf, repo, pr, { action: "deploy", sha: "a".repeat(40) }, "a".repeat(40))).toBe(true);
    expect(calls).toHaveLength(0);
  });
  test("reuses only exact preview names and never creates during cleanup discovery", async () => {
    const { cf, calls } = mockCloud(existing);
    const found = await resources(cf, repo, pr, false);
    expect(found.db.uuid).toBe(dbId);
    expect(calls.every(call => call.method === "GET")).toBe(true);
  });
  test("creates missing resources once; partial state is recoverable by name", async () => {
    const { cf, calls } = mockCloud(call => {
      if (call.path.startsWith("/d1/database?")) return { result: [{ name: n.db, uuid: dbId }] };
      if (call.path.startsWith("/queues?")) return { result: [] };
      if (call.path === `/r2/buckets/${n.bucket}`) return { status: 404 };
      if (call.path === "/queues" && call.method === "POST") return { result: { queue_name: call.body.queue_name, queue_id: queueId } };
      if (call.path === "/r2/buckets" && call.method === "POST") return { result: { name: call.body.name } };
      return existing(call);
    });
    await resources(cf, repo, pr, true);
    expect(calls.filter(c => c.method === "POST").map(c => c.path)).toEqual(["/queues", "/r2/buckets"]);
  });
  test("stops writers, drains multiple R2 pages and deletes only exact preview storage", async () => {
    let pages = 0;
    const { cf, calls } = mockCloud(call => {
      if (call.path.endsWith("/objects?per_page=1000")) {
        pages++;
        return { result: pages < 3 ? [{ key: pages === 1 ? "a/b?x#z" : "../another" }] : [] };
      }
      return existing(call);
    });
    await cleanup(cf, repo, pr);
    const deletes = calls.filter(c => c.method === "DELETE").map(c => c.path);
    expect(deletes[0]).toBe(`/queues/${queueId}/consumers/${"3".repeat(32)}`);
    expect(deletes[1]).toBe(`/workflows/${n.workflow}`);
    expect(deletes[2]).toBe(`/workers/scripts/${n.worker}`);
    expect(deletes).toContain(`/r2/buckets/${n.bucket}/objects/a%2Fb%3Fx%23z`);
    expect(deletes).toContain(`/r2/buckets/${n.bucket}/objects/..%2Fanother`);
    expect(deletes.at(-1)).toBe(`/d1/database/${dbId}`);
    expect(deletes.some(path => path.includes("linklog"))).toBe(false);
    expect(pages).toBe(3);
  });
  test("missing resources are idempotent; authorization failures are not absence", async () => {
    const missing = mockCloud(call => call.path.includes("?") ? { result: [] } : { status: 404 });
    await cleanup(missing.cf, repo, pr);
    expect(missing.calls.filter(c => c.method === "DELETE").length).toBe(2);
    const denied = mockCloud(() => ({ status: 403, success: false }));
    await expect(cleanup(denied.cf, repo, pr)).rejects.toThrow("403");
    expect(denied.calls.some(c => c.method === "DELETE")).toBe(false);
  });
  test("foreign queue consumer blocks every deletion", async () => {
    const { cf, calls } = mockCloud(call => call.path === `/queues/${queueId}`
      ? { result: { queue_id: queueId, queue_name: n.queue, consumers: [{ script_name: "linklog" }] } } : existing(call));
    await expect(cleanup(cf, repo, pr)).rejects.toThrow("foreign consumer");
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
  });
  test("failure stopping workflows never proceeds to deleting storage", async () => {
    const { cf, calls } = mockCloud(call => call.path.startsWith("/workflows/") ? { status: 500, success: false } : existing(call));
    await expect(cleanup(cf, repo, pr)).rejects.toThrow("500");
    expect(calls.some(c => c.method === "DELETE" && c.path.startsWith("/d1/"))).toBe(false);
  });
  test("paginates discovery rather than assuming the first account page", async () => {
    const { cf, calls } = mockCloud(call => ({ result: call.path.includes("page=1&")
      ? Array.from({ length: 100 }, (_, i) => ({ name: `unrelated-${i}` })) : [{ name: n.db, uuid: dbId }] }));
    expect((await cf.named("/d1/database", "name", n.db)).uuid).toBe(dbId);
    expect(calls).toHaveLength(2);
  });
  test("server-selected short pages do not hide later resources", async () => {
    const { cf, calls } = mockCloud(call => ({
      result: call.path.includes("page=1&") ? Array.from({ length: 20 }, (_, i) => ({ name: `unrelated-${i}` })) : [{ name: n.db, uuid: dbId }],
      result_info: { per_page: 20, total_pages: 2 },
    }));
    expect((await cf.named("/d1/database", "name", n.db)).uuid).toBe(dbId);
    expect(calls).toHaveLength(2);
  });
});

test("workflow keeps PR execution out of the secret-bearing job and serializes mutations", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/pr-preview.yml").text()) as any;
  expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  expect(workflow.on.pull_request_target.types).toEqual(["labeled", "unlabeled", "synchronize", "reopened", "closed"]);
  const build = workflow.jobs.build;
  expect(build.environment).toBeUndefined();
  expect(JSON.stringify(build)).not.toContain("secrets.");
  const reconcile = workflow.jobs.reconcile;
  expect(reconcile.steps.filter((s: any) => s.uses?.startsWith("actions/checkout@")).map((s: any) => s.with.ref)).toEqual(["${{ github.sha }}"]);
  expect(JSON.stringify(reconcile)).not.toContain("bun run build");
  for (const job of Object.values(workflow.jobs) as any[]) for (const step of job.steps) {
    if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    if (step.run) expect(step.run).not.toContain("${{");
  }
});
