import { domainOf, normalizeUrl } from "../src/url";
import { LIMITS, chargeOrThrow } from "./limits";

/** Where a batch of added links came from, kept in the batch's config. Web calls pass none. */
export type BatchSource = { source: "api"; apiKeyId: string; apiKeyName: string };

/** `batchId` is set when this call queued the link's Extraction (in the one batch it created). */
export type AddResult = { input: string; id: string; created: boolean; batchId?: string } | { input: string; error: string };

/**
 * Adds URLs to the owner's library the way All links does (normalization, URL rules, per-owner
 * dedupe), updates last-saved recency, and queues one extraction batch for the links it created.
 *
 * Quotas are admitted before anything is written: new links count against the link and job
 * quotas, so an exhausted quota answers 429 with nothing saved. The links, their batch and their
 * jobs are then written in ONE D1 batch, which D1 runs as a transaction (a failing statement rolls
 * back the whole sequence): a failure leaves no link without its extraction, and the whole charge
 * is given back. What dedupe or a concurrent insert of the same URL did not use is refunded.
 *
 * A link of this owner that has never had a job and has no content (left by an interrupted
 * operation before this was atomic) gets its extraction queued when the URL is saved again,
 * exactly once even under concurrency.
 *
 * After the commit, the Queue send is best effort: the jobs are durable in D1 (the outbox) and
 * cron recovery resends queued jobs if the send fails. Invalid URLs are reported per input and
 * never charged.
 *
 * An exhausted quota throws a LimitError naming it (`links` or `jobs`) and its seconds to reset.
 * An optional `source` is stored in the created batch's config (web calls store none).
 *
 * `normalized` says the inputs already went through normalizeUrl (a caller that had to check them
 * first): they are used as they are. Normalizing again would apply normalizeUrl's input length
 * limit to the percent-encoded form, which can be longer than the input it was made from.
 */
export async function addLinks(
  env: Env,
  userId: string,
  inputs: string[],
  { source, normalized }: { source?: BatchSource; normalized?: boolean } = {},
): Promise<AddResult[]> {
  const now = new Date().toISOString();
  type Parsed = { input: string; url: string } | { input: string; error: string };
  const parsed = inputs.map((input): Parsed => {
    if (normalized) return { input, url: input };
    try {
      return { input, url: normalizeUrl(input) };
    } catch (error) {
      return { input, error: error instanceof Error && error.message ? error.message : "Invalid link." };
    }
  });
  type Existing = { id: string; orphan: number };
  // Every URL in ONE owner-scoped statement: the list is a single JSON parameter (D1 allows 100
  // bound parameters per statement), not one query per URL. A link saved under that original URL
  // wins over one whose resolved URL matches.
  const findAll = async (urls: string[]) => {
    const rows = urls.length
      ? (
          await env.DB.prepare(
            "SELECT id,original_url,url,(content_key IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE link_id=links.id)) orphan FROM links WHERE user_id=?1 AND (original_url IN (SELECT value FROM json_each(?2)) OR url IN (SELECT value FROM json_each(?2)))",
          )
            .bind(userId, JSON.stringify(urls))
            .all<Existing & { original_url: string; url: string }>()
        ).results
      : [];
    return urls.map((url) => {
      const row = rows.find((r) => r.original_url === url) ?? rows.find((r) => r.url === url);
      return [url, row ? { id: row.id, orphan: row.orphan } : null] as const;
    });
  };
  const known = new Map<string, Existing | null>(await findAll([...new Set(parsed.flatMap((p) => ("url" in p ? [p.url] : [])))]));
  const fresh = [...known].filter(([, row]) => !row).map(([url]) => ({ url, id: crypto.randomUUID(), jobId: crypto.randomUUID() }));
  const orphans = [...new Set([...known.values()].filter((row) => row?.orphan).map((row) => row!.id))].map((id) => ({ id, jobId: crypto.randomUUID() }));

  const linksKey = `links:${userId}`, jobsKey = `jobs:${userId}`;
  const charged = await chargeOrThrow(
    env.DB,
    [
      { key: linksKey, limit: LIMITS.linksPerUser, cost: fresh.length, code: "links" },
      { key: jobsKey, limit: LIMITS.jobsPerUser, cost: fresh.length + orphans.length, code: "jobs" },
    ],
    "Link or processing limit reached. Try again later.",
  );

  const createdLinks = new Set<string>();
  const queuedJobs: string[] = [];
  const queuedIn = new Map<string, string>();
  if (known.size) {
    const db = env.DB;
    const batchId = crypto.randomUUID();
    // D1 allows at most 100 bound parameters per statement, also inside a batch: every statement
    // below binds a constant number of values, so up to 100 URLs (and orphans) fit in ONE batch.
    const statements: D1PreparedStatement[] = [
      ...fresh.map((f) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO links (id,user_id,original_url,url,domain,title,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM links WHERE user_id=? AND (original_url=? OR url=?))",
          )
          .bind(f.id, userId, f.url, f.url, domainOf(f.url), domainOf(f.url), now, userId, f.url, f.url),
      ),
      ...(fresh.length || orphans.length ? [
        db.prepare("INSERT INTO batches(id,user_id,kind,config,created_at) VALUES(?,?,'extract',?,?)").bind(batchId, userId, JSON.stringify(source ?? {}), now),
        ...[...fresh, ...orphans].map((j) =>
          db
            .prepare(
              "INSERT INTO jobs(id,batch_id,link_id,created_at) SELECT ?,?,id,? FROM links WHERE id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE link_id=links.id)",
            )
            .bind(j.jobId, batchId, now, j.id, userId),
        ),
        db
          .prepare(`UPDATE links SET content_state='queued',content_error=NULL WHERE user_id=? AND id IN (SELECT link_id FROM jobs WHERE batch_id=?)`)
          .bind(userId, batchId),
        // A fully deduped call (every link already had a job) leaves no empty batch behind.
        db.prepare("DELETE FROM batches WHERE id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE batch_id=?)").bind(batchId, userId, batchId),
      ] : []),
      // Re-saving changes recency only. Resolve each URL with the same original-first rule
      // as findAll, including a concurrent insert that won over ours.
      db.prepare(`UPDATE links SET last_saved_at=max(coalesce(last_saved_at,created_at),?1)
        WHERE user_id=?2 AND id IN (SELECT coalesce(
          (SELECT id FROM links WHERE user_id=?2 AND original_url=value),
          (SELECT id FROM links WHERE user_id=?2 AND url=value LIMIT 1)
        ) FROM json_each(?3))`).bind(now, userId, JSON.stringify([...known.keys()])),
    ];
    let results: D1Result[];
    try {
      results = await db.batch(statements);
    } catch (error) {
      // Rolled back as a whole: nothing was written, nothing stays charged.
      await charged.release();
      throw error;
    }
    fresh.forEach((f, i) => results[i]!.meta.changes > 0 && createdLinks.add(f.id));
    [...fresh, ...orphans].forEach((j, i) => {
      if (results[fresh.length + 1 + i]!.meta.changes > 0) queuedJobs.push(j.jobId), queuedIn.set(j.id, batchId);
    });
    await charged.release({ [linksKey]: fresh.length - createdLinks.size, [jobsKey]: fresh.length + orphans.length - queuedJobs.length });
    try {
      if (queuedJobs.length) await env.JOBS.sendBatch(queuedJobs.map((id) => ({ body: { id } })));
    } catch {
      console.error("Queue dispatch deferred to outbox recovery");
    }
  }
  // Concurrent inserts of the same URL by this owner: the winner's row is the result.
  for (const [url, row] of await findAll(fresh.filter((f) => !createdLinks.has(f.id)).map((f) => f.url))) known.set(url, row);
  const idOf = (url: string) => fresh.find((f) => f.url === url && createdLinks.has(f.id))?.id ?? known.get(url)?.id;
  const seen = new Set<string>();
  return parsed.map((p) => {
    if (!("url" in p)) return p;
    const id = idOf(p.url);
    if (!id) return { input: p.input, error: "Could not save the link." };
    const created = createdLinks.has(id) && !seen.has(p.url);
    seen.add(p.url);
    const batchId = queuedIn.get(id);
    return { input: p.input, id, created, ...(batchId ? { batchId } : {}) };
  });
}
