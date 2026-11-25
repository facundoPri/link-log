// Read-only access to production D1, or a PR preview's D1, for triage. Usage (from the repo root):
//   bun .agents/skills/triage-production/scripts/prod.ts sql "SELECT ..." [--json] [--preview <pr>]
//   bun .agents/skills/triage-production/scripts/prod.ts timeline <batch_or_job_id>... [--preview <pr>]
// Every statement goes through `wrangler d1 execute --remote`, against `DB --env production` or the
// PR preview's database; anything that is not a single read query is refused before Wrangler runs.
import { parseArgs } from "node:util";
import { names } from "../../../../scripts/preview/model";

// github.repository_id of facundoPri/link-log, which scripts/preview/ puts in every preview resource name.
const REPOSITORY_ID = "1384205267";

const WRITES = /\b(insert|update|delete|replace|drop|alter|create|attach|detach|vacuum|reindex|analyze)\b/i;

export function assertReadOnly(sql: string) {
  const body = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/;\s*$/, "");
  if (!/^(select|with|explain|pragma\s+table_info)\b/i.test(body)) throw new Error("Only SELECT, WITH, EXPLAIN or PRAGMA table_info queries run against remote D1.");
  if (body.includes(";")) throw new Error("One statement per call.");
  if (WRITES.test(body.replace(/'(?:[^']|'')*'/g, "''"))) throw new Error("The query contains a write keyword; triage is read-only.");
  return body;
}

/** Wrangler's database arguments: production, or the D1 of PR `pr`'s PR preview (`pr-preview` label). */
export function database(pr?: string) {
  return pr === undefined ? ["DB", "--env", "production"] : [names(REPOSITORY_ID, pr).db];
}

export async function query<T = Record<string, unknown>>(sql: string, pr?: string): Promise<T[]> {
  const proc = Bun.spawn(["bunx", "wrangler", "d1", "execute", ...database(pr), "--remote", "--json", "--command", assertReadOnly(sql)], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`wrangler d1 execute failed (${code}): ${(err || out).trim().slice(-800)}`);
  const parsed = JSON.parse(out) as { results: T[] }[];
  return parsed.flatMap((r) => r.results);
}

const ID = /^[0-9a-f-]{36}$/i;

/** Per-job timeline of the batches the ids belong to, in seconds from the first job's creation. */
async function timeline(ids: string[], pr?: string) {
  if (!ids.length || !ids.every((id) => ID.test(id))) throw new Error("timeline takes batch or job UUIDs.");
  const list = ids.map((id) => `'${id}'`).join(",");
  const rows = await query<{
    job: string; batch: string; kind: string; status: string; step: string; error: string | null;
    created_at: string; completed_at: string | null; call_at: string | null; call_ms: number | null; provider: string | null;
  }>(
    `SELECT j.id job, j.batch_id batch, b.kind, j.status, j.step, j.error, j.created_at, j.completed_at,
       u.created_at call_at, u.duration_ms call_ms, u.provider
     FROM jobs j JOIN batches b ON b.id=j.batch_id LEFT JOIN usage_events u ON u.job_id=j.id
     WHERE j.batch_id IN (SELECT batch_id FROM jobs WHERE id IN (${list}) UNION SELECT id FROM batches WHERE id IN (${list}))
     ORDER BY COALESCE(u.created_at, j.created_at)`,
    pr,
  );
  if (!rows.length) return console.log("No jobs found for those ids.");
  const t0 = Math.min(...rows.map((r) => Date.parse(r.created_at)));
  const at = (v: string | null) => (v ? ((Date.parse(v) - t0) / 1000).toFixed(2) : "-");
  console.log(`t0 = ${new Date(t0).toISOString()} (seconds below are relative to it)`);
  console.table(rows.map((r) => ({
    job: r.job.slice(0, 8), batch: r.batch.slice(0, 8), kind: r.kind, status: r.status,
    created: at(r.created_at), call: at(r.call_at), call_ms: r.call_ms ?? "-", done: at(r.completed_at),
    step: r.status === "failed" ? `${r.step}: ${(r.error ?? "").slice(0, 60)}` : r.step,
  })));
}

if (import.meta.main) {
  try {
    // strict: an unknown or malformed flag must fail, never fall back to production.
    const { positionals, values } = parseArgs({ allowPositionals: true, strict: true, options: { json: { type: "boolean" }, preview: { type: "string" } } });
    const [command, ...args] = positionals;
    const pr = values.preview;
    if (command === "sql" && args[0]) {
      const rows = await query(args[0], pr);
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else console.table(rows);
    } else if (command === "timeline") await timeline(args, pr);
    else {
      console.error('Usage: prod.ts sql "SELECT ..." [--json] [--preview <pr>] | prod.ts timeline <batch_or_job_id>... [--preview <pr>]');
      process.exit(2);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
