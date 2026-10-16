import { Hono } from "hono";
import type { Job, JobUsage, UsageEvent } from "../../src/types";
import { json, library } from "../store";
import { enqueue } from "../jobs";
import { preservedContentStateSql } from "../content-state";
import { OCR_USAGE_COLUMNS } from "../usage";
import { badRequest, ownerOf, type AppEnv } from "../http/context";
import { ownedBatch } from "./shared";

type JobUsageRow = {
  job_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  browser_ms: number | null;
  duration_ms: number | null;
  model: string | null;
  usd: number | null;
  unknown_cost_calls: number;
  ocr_images: number;
  ocr_input_tokens: number | null;
  ocr_output_tokens: number | null;
  ocr_model: string | null;
  ocr_usd: number | null;
  ocr_unknown_cost_calls: number;
};
type UsageTotalsRow = {
  input_tokens: number | null;
  output_tokens: number | null;
  browser_ms: number | null;
  calls: number;
  usd: number | null;
  unknown_cost_calls: number;
};
// Titles come from the owner's own link or browser capture only.
const OWNED_TITLE_JOINS =
  "LEFT JOIN links l ON l.id=j.link_id AND l.user_id=?1 LEFT JOIN browser_targets bt ON bt.id=j.target_id AND bt.request_id IN (SELECT request_id FROM browser_requests WHERE user_id=?1)";

/** Batches, jobs and usage of the signed-in owner. */
export const activityRoutes = new Hono<AppEnv>()
  .post("/batches", async (c) => {
    const env = c.env, userId = ownerOf(c), body = c.get("body");
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) throw badRequest("Invalid selection.");
    if (!["extract", "autotag", "lens"].includes(String(body.kind))) throw badRequest("Invalid action.");
    if (body.kind === "lens" && typeof body.lensId !== "string") throw badRequest("Pick a lens.");
    const batchId = await enqueue(env, userId, body.ids as string[], body.kind as "extract" | "autotag" | "lens", body.lensId as string | undefined);
    return json({ ...(await library(env, userId)), batchId });
  })
  .delete("/batches/:id", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const batch = await ownedBatch(env.DB, userId, c.req.param("id"));
    const pending = await env.DB.prepare("SELECT link_id FROM jobs WHERE batch_id=? AND status='queued' AND link_id IS NOT NULL")
      .bind(batch.id).all<{ link_id: string }>();
    // Constant bound parameters (D1: max 100 per statement): the links are selected by subquery,
    // before their queued jobs are marked cancelled in the same batch.
    const statements: D1PreparedStatement[] = [];
    if (batch.kind === "extract" && pending.results.length)
      statements.push(
        env.DB.prepare(
          `UPDATE links SET content_state=${preservedContentStateSql("missing")},content_error=NULL WHERE user_id=? AND content_state='queued' AND id IN (SELECT link_id FROM jobs WHERE batch_id=? AND status='queued' AND link_id IS NOT NULL)`,
        ).bind(userId, batch.id),
      );
    statements.push(
      env.DB.prepare("UPDATE jobs SET status='failed',step='Cancelled',error='Cancelled',completed_at=? WHERE batch_id=? AND status='queued'")
        .bind(new Date().toISOString(), batch.id),
    );
    await env.DB.batch(statements);
    return json({ ...(await library(env, userId)), cancelled: pending.results.length });
  })
  .get("/batches/:id", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const batch = await ownedBatch(env.DB, userId, c.req.param("id"));
    const [jobs, usage] = await Promise.all([
      env.DB.prepare(`SELECT j.*,coalesce(l.title,bt.title) title FROM jobs j ${OWNED_TITLE_JOINS} WHERE j.batch_id=?2 ORDER BY j.created_at`)
        .bind(userId, batch.id).all<Job>(),
      env.DB.prepare(
        `SELECT job_id,sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,sum(duration_ms) duration_ms,max(model) model,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls,${OCR_USAGE_COLUMNS} FROM usage_events WHERE user_id=? AND batch_id=? AND status IN ('done','failed') GROUP BY job_id`,
      ).bind(userId, batch.id).all<JobUsageRow>(),
    ]);
    const byJob = new Map<string, JobUsage>();
    for (const row of usage.results) {
      let u = byJob.get(row.job_id);
      if (!u)
        byJob.set(row.job_id, (u = { input_tokens: 0, output_tokens: 0, browser_ms: 0, duration_ms: 0, model: row.model, usd: null, unknown_cost_calls: 0, ocr: null }));
      u.input_tokens += row.input_tokens ?? 0;
      u.output_tokens += row.output_tokens ?? 0;
      u.browser_ms += row.browser_ms ?? 0;
      u.duration_ms += row.duration_ms ?? 0;
      u.model ??= row.model;
      if (row.usd !== null) u.usd = (u.usd ?? 0) + row.usd;
      u.unknown_cost_calls += row.unknown_cost_calls;
      if (row.ocr_images)
        u.ocr = {
          images: row.ocr_images,
          input_tokens: row.ocr_input_tokens ?? 0,
          output_tokens: row.ocr_output_tokens ?? 0,
          model: row.ocr_model,
          usd: row.ocr_usd,
          unknown_cost_calls: row.ocr_unknown_cost_calls,
        };
    }
    return json({ jobs: jobs.results.map((j) => ({ ...j, usage: byJob.get(j.id) ?? null })) });
  })
  .get("/usage", async (c) => {
    const env = c.env, userId = ownerOf(c);
    const [events, grouped] = await Promise.all([
      env.DB.prepare(
        `SELECT u.id,u.batch_id,u.job_id,u.link_id,u.provider,u.service,u.model,u.operation,u.status,u.input_tokens,u.output_tokens,u.browser_ms,u.estimated_usd,u.rate_snapshot,u.created_at,u.duration_ms,u.error,coalesce(l.title,bt.title) title FROM usage_events u LEFT JOIN jobs j ON j.id=u.job_id ${OWNED_TITLE_JOINS.replace("l.id=j.link_id", "l.id=u.link_id")} WHERE u.user_id=?1 ORDER BY u.created_at DESC LIMIT 1000`,
      ).bind(userId).all<UsageEvent>(),
      env.DB.prepare(
        "SELECT sum(input_tokens) input_tokens,sum(output_tokens) output_tokens,sum(browser_ms) browser_ms,count(*) calls,sum(estimated_usd) usd,sum(estimated_usd IS NULL) unknown_cost_calls FROM usage_events WHERE user_id=? AND status IN ('done','failed')",
      ).bind(userId).all<UsageTotalsRow>(),
    ]);
    const totals = { usd: null as number | null, input_tokens: 0, output_tokens: 0, browser_ms: 0, calls: 0, unknown_cost_calls: 0 };
    for (const row of grouped.results) {
      totals.input_tokens += row.input_tokens ?? 0;
      totals.output_tokens += row.output_tokens ?? 0;
      totals.browser_ms += row.browser_ms ?? 0;
      totals.calls += row.calls;
      totals.unknown_cost_calls += row.unknown_cost_calls ?? 0;
      if (row.usd !== null) totals.usd = (totals.usd ?? 0) + row.usd;
    }
    return json({
      events: events.results.map((e) => ({ ...e, usd: e.status === "done" || e.status === "failed" ? e.estimated_usd : null })),
      totals,
    });
  });
