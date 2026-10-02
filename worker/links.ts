import { domainOf, normalizeUrl } from "../src/url";
import { charge, LIMITS, LimitError } from "./limits";

export type AddResult = { input: string; id: string; created: boolean } | { input: string; error: string };

/**
 * Adds URLs to the owner's library the way All links does (normalization, URL rules, per-owner
 * dedupe) and queues one extraction batch for the links it created.
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
  type Existing = { id: string; orphan: number };
  const find = (url: string) =>
    env.DB.prepare(
      "SELECT id,(content_key IS NULL AND NOT EXISTS(SELECT 1 FROM jobs WHERE link_id=links.id)) orphan FROM links WHERE user_id=? AND (original_url=? OR url=?)",
    )
      .bind(userId, url, url)
      .first<Existing>();
  const known = new Map<string, Existing | null>();
  for (const p of parsed) if ("url" in p && !known.has(p.url)) known.set(p.url, await find(p.url));
  const fresh = [...known].filter(([, row]) => !row).map(([url]) => ({ url, id: crypto.randomUUID(), jobId: crypto.randomUUID() }));
  const orphans = [...new Set([...known.values()].filter((row) => row?.orphan).map((row) => row!.id))].map((id) => ({ id, jobId: crypto.randomUUID() }));

  const linksKey = `links:${userId}`, jobsKey = `jobs:${userId}`;
  const charged = await charge(env.DB, [
    { key: linksKey, limit: LIMITS.linksPerUser, cost: fresh.length },
    { key: jobsKey, limit: LIMITS.jobsPerUser, cost: fresh.length + orphans.length },
  ]);
  if (!charged) throw new LimitError("Link or processing limit reached. Try again later.");

  const createdLinks = new Set<string>();
  const queuedJobs: string[] = [];
  if (fresh.length || orphans.length) {
    const db = env.DB;
    const now = new Date().toISOString();
    const batchId = crypto.randomUUID();
    const linkIds = [...fresh.map((f) => f.id), ...orphans.map((o) => o.id)];
    const marks = linkIds.map(() => "?").join(",");
    const statements: D1PreparedStatement[] = [
      ...fresh.map((f) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO links (id,user_id,original_url,url,domain,title,created_at) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM links WHERE user_id=? AND (original_url=? OR url=?))",
          )
          .bind(f.id, userId, f.url, f.url, domainOf(f.url), domainOf(f.url), now, userId, f.url, f.url),
      ),
      // The batch exists only if it will hold a job (a fully deduped call writes nothing).
      db
        .prepare(
          `INSERT INTO batches(id,user_id,kind,config,created_at) SELECT ?,?,'extract','{}',? WHERE EXISTS(SELECT 1 FROM links l WHERE l.user_id=? AND l.id IN (${marks}) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.link_id=l.id))`,
        )
        .bind(batchId, userId, now, userId, ...linkIds),
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
    [...fresh, ...orphans].forEach((j, i) => results[fresh.length + 1 + i]!.meta.changes > 0 && queuedJobs.push(j.jobId));
    await charged.release({ [linksKey]: fresh.length - createdLinks.size, [jobsKey]: fresh.length + orphans.length - queuedJobs.length });
    try {
      if (queuedJobs.length) await env.JOBS.sendBatch(queuedJobs.map((id) => ({ body: { id } })));
    } catch {
      console.error("Queue dispatch deferred to outbox recovery");
    }
  }
  // Concurrent inserts of the same URL by this owner: the winner's row is the result.
  for (const f of fresh) if (!createdLinks.has(f.id)) known.set(f.url, await find(f.url));
  const idOf = (url: string) => fresh.find((f) => f.url === url && createdLinks.has(f.id))?.id ?? known.get(url)?.id;
  const seen = new Set<string>();
  return parsed.map((p) => {
    if (!("url" in p)) return p;
    const id = idOf(p.url);
    if (!id) return { input: p.input, error: "Could not save the link." };
    const created = createdLinks.has(id) && !seen.has(p.url);
    seen.add(p.url);
    return { input: p.input, id, created };
  });
}
