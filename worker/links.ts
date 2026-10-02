import { domainOf, normalizeUrl } from "../src/url";
import { consume, LIMITS, LimitError } from "./limits";

/**
 * Adds one URL to the owner's library the way All links does: same normalization, URL rules and
 * per-owner dedupe; new links count against the owner's link quota. The caller enqueues the normal
 * extraction for created links.
 */
export async function addLink(env: Env, userId: string, input: string): Promise<{ id: string; created: boolean }> {
  const url = normalizeUrl(input);
  const find = () =>
    env.DB.prepare("SELECT id FROM links WHERE user_id=? AND (original_url=? OR url=?)")
      .bind(userId, url, url)
      .first<{ id: string }>();
  const existing = await find();
  if (existing) return { id: existing.id, created: false };
  if (!(await consume(env.DB, `links:${userId}`, LIMITS.linksPerUser)))
    throw new LimitError("Link limit reached. Try again later.");
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO links (id,user_id,original_url,url,domain,title,created_at) VALUES (?,?,?,?,?,?,?) RETURNING id",
  )
    .bind(crypto.randomUUID(), userId, url, url, domainOf(url), domainOf(url), new Date().toISOString())
    .first<{ id: string }>();
  if (inserted) return { id: inserted.id, created: true };
  // Lost a race with a concurrent insert of the same URL by the same owner.
  const winner = await find();
  if (!winner) throw new Error("Could not save the link.");
  return { id: winner.id, created: false };
}
