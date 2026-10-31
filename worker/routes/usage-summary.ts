import { Hono } from "hono";
import type { Usage } from "../../src/types";
import { LIMITS, windowUsage } from "../limits";
import { json } from "../store";
import { ownerOf, type AppEnv } from "../http/context";

/**
 * Quota windows and this calendar month's (UTC) new Links of the signed-in owner, read live.
 * Duplicates create no Link and no job, so they never count. A deleted Link leaves its month's count.
 * API keys come from the extract batches that addLinks labelled with the key (Revoked API keys
 * included); Web is the month's total minus those.
 */
export const usageSummaryRoutes = new Hono<AppEnv>().get("/usage/summary", async (c) => {
  const db = c.env.DB, userId = ownerOf(c), now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const [links, jobs, total, byKey] = await Promise.all([
    windowUsage(db, `links:${userId}`, LIMITS.linksPerUser),
    windowUsage(db, `jobs:${userId}`, LIMITS.jobsPerUser),
    db.prepare("SELECT count(*) n FROM links WHERE user_id=? AND created_at>=? AND created_at<?").bind(userId, start, end).first<{ n: number }>(),
    // Only Links created this month, so a key's count never exceeds the total.
    db
      .prepare(
        `SELECT json_extract(b.config,'$.apiKeyId') key_id,max(json_extract(b.config,'$.apiKeyName')) name,count(DISTINCT j.link_id) n
         FROM batches b JOIN jobs j ON j.batch_id=b.id JOIN links l ON l.id=j.link_id AND l.user_id=b.user_id
         WHERE b.user_id=? AND b.kind='extract' AND json_extract(b.config,'$.source')='api'
           AND l.created_at>=? AND l.created_at<? GROUP BY key_id ORDER BY n DESC,key_id`,
      )
      .bind(userId, start, end)
      .all<{ key_id: string; name: string; n: number }>(),
  ]);
  const apiKeys = byKey.results.filter((r) => r.key_id).map((r) => ({ id: r.key_id, name: r.name, links: r.n }));
  const monthLinks = total?.n ?? 0;
  const body: Usage = {
    quotas: { links, jobs },
    month: { start, links: monthLinks, web: Math.max(0, monthLinks - apiKeys.reduce((sum, k) => sum + k.links, 0)), apiKeys },
  };
  return json(body);
});
