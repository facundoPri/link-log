import { contentPrefix } from "./store";
import { stopWorkflow } from "./jobs";
import { parseBatchKind, runsInJevQueue } from "./job-routing";
import { INTERRUPTED_USAGE } from "./usage";

export const LINK_DELETED = "Cancelled: link deleted";
const LINK_DELETED_AFTER_JEV = `${LINK_DELETED}. Jev was already called (may have been billed).`;

/**
 * Deletes an owner's links and everything they own (ADR 0003). Their unfinished jobs, running ones included, are
 * cancelled as LINK_DELETED and outlive the link (0029): Activity still lists them under the link's title. Owned
 * rows go through ON DELETE CASCADE.
 *
 * Running Workflow jobs are stopped first, as Activity's Cancel does. That is only hygiene: the cancel itself fences
 * every write a job still in flight makes (each requires the job running), Jev answers included, and content stored
 * in R2 afterwards is removed by putLinkContent. So a workflow that can't be stopped doesn't block the delete.
 * Ids that are not the owner's are ignored, indistinguishable from missing ones.
 */
export async function deleteLinks(env: Env, userId: string, ids: string[]) {
  const wanted = JSON.stringify([...new Set(ids)]);
  const owned = "link_id IN (SELECT id FROM links WHERE user_id=? AND id IN (SELECT value FROM json_each(?)))";
  const running = await env.DB.prepare(`SELECT j.id,b.kind FROM jobs j JOIN batches b ON b.id=j.batch_id WHERE j.${owned} AND j.status='running'`)
    .bind(userId, wanted).all<{ id: string; kind: string }>();
  for (const job of running.results) {
    if (runsInJevQueue(parseBatchKind(job.kind))) continue;
    await stopWorkflow(env, job.id).catch((error: unknown) =>
      console.log(JSON.stringify({ event: "link_delete_stop_failed", job_id: job.id, detail: String(error).slice(0, 300) })));
  }
  const now = new Date().toISOString();
  const cancelled = `job_id IN (SELECT id FROM jobs WHERE ${owned} AND step='Cancelled' AND completed_at=?)`;
  const [cancel, , , , removed] = await env.DB.batch<{ id: string }>([
    env.DB.prepare(
      `UPDATE jobs SET status='failed',step='Cancelled',error=CASE WHEN jev_call IS NOT NULL THEN ? ELSE ? END,reason=NULL,attempt_started_at=NULL,completed_at=? WHERE ${owned} AND status IN ('queued','running','waiting')`,
    ).bind(LINK_DELETED_AFTER_JEV, LINK_DELETED, now, userId, wanted),
    // A provider call cut short may still be billed; Usage records it like a cancel does.
    env.DB.prepare(`UPDATE usage_events SET ${INTERRUPTED_USAGE} WHERE status='started' AND ${cancelled}`).bind(userId, wanted, now),
    env.DB.prepare(`DELETE FROM provider_leases WHERE ${cancelled}`).bind(userId, wanted, now),
    env.DB.prepare(`UPDATE jobs SET link_title=(SELECT coalesce(title,url) FROM links WHERE links.id=jobs.link_id) WHERE ${owned}`).bind(userId, wanted),
    env.DB.prepare("DELETE FROM links WHERE user_id=? AND id IN (SELECT value FROM json_each(?)) RETURNING id").bind(userId, wanted),
  ]);
  const deleted = removed!.results.map((r) => r.id);
  if (cancel!.meta.changes) console.log(JSON.stringify({ event: "link_delete_cancelled_jobs", links: deleted.length, jobs: cancel!.meta.changes }));
  return { deleted, cancelled: cancel!.meta.changes };
}

/**
 * Stores a link's content. A workflow can still write after its link was deleted (a cancel whose terminate came
 * late, a step attempt the engine abandoned); the object is then removed again, so the deletion sweep that ran
 * before the write leaves no orphan behind.
 */
export async function putLinkContent(env: Env, linkId: string, key: string, markdown: string) {
  await env.CONTENT.put(key, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  if (!(await env.DB.prepare("SELECT 1 FROM links WHERE id=?").bind(linkId).first())) await env.CONTENT.delete(key);
}

/**
 * Removes the R2 objects of deleted links, under the owner-scoped prefix and the legacy one used before FAC-41.
 * It runs after the rows are gone, inside waitUntil's post-response budget, so each listed page is deleted at once
 * and a few prefixes are swept at a time. A failure is logged and never brings a link back.
 */
export async function deleteLinkContent(env: Env, userId: string, linkIds: string[]) {
  const prefixes = linkIds.flatMap((id) => [contentPrefix(userId, id), `links/${id}/`]);
  const sweep = async () => {
    for (let prefix = prefixes.shift(); prefix !== undefined; prefix = prefixes.shift()) {
      try {
        let cursor: string | undefined;
        do {
          const page = await env.CONTENT.list({ prefix, cursor });
          if (page.objects.length) await env.CONTENT.delete(page.objects.map((o) => o.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      } catch (error) {
        console.error(JSON.stringify({ event: "link_content_cleanup_failed", link_id: prefix.split("/").at(-2), legacy: prefix.startsWith("links/"), detail: String(error).slice(0, 300) }));
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, sweep));
}
