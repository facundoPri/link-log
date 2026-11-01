import { Hono } from "hono";
import type { Usage } from "../../src/types";
import { LIMITS, windowUsage } from "../limits";
import { json } from "../store";
import { monthUsage } from "../usage-features";
import { ownerOf, type AppEnv } from "../http/context";

/**
 * The links window, this calendar month's (UTC) new Links and what the month's work cost per feature,
 * of the signed-in owner, read live. Only links are capped; the per-feature totals are not.
 * Duplicates create no Link and no job, so they never count. Links are hard-deleted, so a deleted
 * Link drops out of its month's count.
 * Each of the month's Links counts once, under what created it: addLinks writes a Link and its
 * extract batch with the same timestamp, so the creating batch is the one whose created_at equals
 * the Link's. A later batch that only re-queued the Link (an interrupted save) did not create it.
 * A creating batch labelled with an API key puts the Link under that key; any other, or none left,
 * leaves it to Web. A key that still exists shows its current name; a deleted one the name of its
 * newest batch, marked "deleted". A Revoked API key keeps its row. One statement groups the Links
 * by what created them: the group with no key is Web, and the month's total is the sum of the
 * groups, so the three always add up.
 */
export const usageSummaryRoutes = new Hono<AppEnv>().get("/usage/summary", async (c) => {
  const db = c.env.DB, userId = ownerOf(c), now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const [links, features, groups] = await Promise.all([
    windowUsage(db, `links:${userId}`, LIMITS.linksPerUser),
    monthUsage(db, userId, start, end),
    db
      .prepare(
        `SELECT s.key_id,count(*) n,max(k.id) listed,max(k.enabled) enabled,
                coalesce(max(k.name),(SELECT json_extract(b2.config,'$.apiKeyName') FROM batches b2
                  WHERE b2.user_id=?1 AND b2.kind='extract' AND json_extract(b2.config,'$.apiKeyId')=s.key_id
                  ORDER BY b2.created_at DESC,b2.id DESC LIMIT 1)) name
         FROM (
           SELECT (SELECT json_extract(b.config,'$.apiKeyId') FROM jobs j JOIN batches b ON b.id=j.batch_id
                   WHERE j.link_id=l.id AND b.user_id=l.user_id AND b.kind='extract' AND b.created_at=l.created_at
                   ORDER BY b.id LIMIT 1) key_id
           FROM links l WHERE l.user_id=?1 AND l.created_at>=?2 AND l.created_at<?3
         ) s LEFT JOIN apikey k ON k.id=s.key_id AND k."referenceId"=?1
         GROUP BY s.key_id ORDER BY n DESC,s.key_id`,
      )
      .bind(userId, start, end)
      .all<{ key_id: string | null; name: string; n: number; listed: string | null; enabled: number | null }>(),
  ]);
  const apiKeys = groups.results.filter((r) => r.key_id !== null).map((r) => ({ id: r.key_id!, name: r.name, links: r.n, status: !r.listed ? ("deleted" as const) : r.enabled === 1 ? ("active" as const) : ("revoked" as const) }));
  const web = groups.results.find((r) => r.key_id === null)?.n ?? 0;
  const body: Usage = {
    quotas: { links },
    month: { start, links: web + apiKeys.reduce((sum, k) => sum + k.links, 0), web, apiKeys, ...features },
  };
  return json(body);
});
