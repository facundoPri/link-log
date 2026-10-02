import { domainOf, normalizeUrl } from "../src/url";
import { enqueue } from "./jobs";
import { charge, LIMITS, LimitError } from "./limits";

export type AddResult = { input: string; id: string; created: boolean } | { input: string; error: string };

/**
 * Adds URLs to the owner's library the way All links does (normalization, URL rules, per-owner
 * dedupe) and queues one extraction batch for the links it created.
 *
 * Quotas are admitted before anything is written: new links count against both the link and the
 * job quota, so an exhausted quota answers 429 with nothing saved (no link left without its
 * extraction). What dedupe or a concurrent insert of the same URL did not use is given back.
 * Invalid URLs are reported per input and never charged.
 */
export async function addLinks(env: Env, userId: string, inputs: string[]): Promise<AddResult[]> {
  type Parsed = { input: string; url: string } | { input: string; error: string };
  const parsed = inputs.map((input): Parsed => {
    try {
      return { input, url: normalizeUrl(input) };
    } catch (error) {
      return { input, error: error instanceof Error && error.message ? error.message : "Invalid link." };
    }
  });
  const find = (url: string) =>
    env.DB.prepare("SELECT id FROM links WHERE user_id=? AND (original_url=? OR url=?)")
      .bind(userId, url, url)
      .first<{ id: string }>();
  const known = new Map<string, string | null>();
  for (const p of parsed) if ("url" in p && !known.has(p.url)) known.set(p.url, (await find(p.url))?.id ?? null);
  const fresh = [...known].filter(([, id]) => !id).map(([url]) => url);

  const charged = await charge(env.DB, [
    { key: `links:${userId}`, limit: LIMITS.linksPerUser, cost: fresh.length },
    { key: `jobs:${userId}`, limit: LIMITS.jobsPerUser, cost: fresh.length },
  ]);
  if (!charged) throw new LimitError("Link or processing limit reached. Try again later.");

  const created: string[] = [];
  try {
    const now = new Date().toISOString();
    for (const url of fresh) {
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO links (id,user_id,original_url,url,domain,title,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM links WHERE user_id=? AND (original_url=? OR url=?)) RETURNING id",
      )
        .bind(crypto.randomUUID(), userId, url, url, domainOf(url), domainOf(url), now, userId, url, url)
        .first<{ id: string }>();
      if (inserted) {
        known.set(url, inserted.id);
        created.push(inserted.id);
      } else {
        // Lost a race with a concurrent insert of the same URL by the same owner.
        const winner = await find(url);
        if (!winner) throw new Error("Could not save the link.");
        known.set(url, winner.id);
      }
    }
    if (created.length) await enqueue(env, userId, created, "extract", undefined, undefined, true);
  } finally {
    await charged.release(fresh.length - created.length);
  }
  const createdSet = new Set(created);
  return parsed.map((p) => ("url" in p ? { input: p.input, id: known.get(p.url)!, created: createdSet.has(known.get(p.url)!) && isFirst(parsed, p) } : p));
}

/** A URL listed twice in one request is created once; the later entries are duplicates. */
function isFirst(parsed: ({ input: string; url: string } | { input: string; error: string })[], item: { url: string }) {
  return parsed.find((p) => "url" in p && p.url === item.url) === item;
}
