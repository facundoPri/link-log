import { domainOf, normalizeUrl } from "../src/url";

/**
 * Adds one URL to the library the way All links does: same normalization, URL rules
 * and dedupe. The caller enqueues the normal extraction for created links.
 */
export async function addLink(env: Env, input: string): Promise<{ id: string; created: boolean }> {
  const url = normalizeUrl(input);
  const existing = await env.DB.prepare("SELECT id FROM links WHERE original_url=? OR url=?")
    .bind(url, url)
    .first<{ id: string }>();
  if (existing) return { id: existing.id, created: false };
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO links (id,original_url,url,domain,title,created_at) VALUES (?,?,?,?,?,?) RETURNING id",
  )
    .bind(crypto.randomUUID(), url, url, domainOf(url), domainOf(url), new Date().toISOString())
    .first<{ id: string }>();
  if (inserted) return { id: inserted.id, created: true };
  // Lost a race with a concurrent insert of the same URL.
  const winner = await env.DB.prepare("SELECT id FROM links WHERE original_url=? OR url=?")
    .bind(url, url)
    .first<{ id: string }>();
  if (!winner) throw new Error("Could not save the link.");
  return { id: winner.id, created: false };
}
