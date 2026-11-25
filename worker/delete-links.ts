import { contentPrefix } from "./store";

/**
 * Deletes an owner's links and everything they own (ADR 0003). Owned rows go through ON DELETE CASCADE, queued
 * and waiting jobs included: a queued job's message then finds no row, and the workflow's start is guarded on the
 * row still being queued, so nothing runs. The running-job check sits inside the DELETE, so a job that starts
 * meanwhile is seen and its link is reported as `running` instead. Ids that are not the owner's are ignored,
 * indistinguishable from missing ones.
 */
export async function deleteLinks(env: Env, userId: string, ids: string[]) {
  const wanted = JSON.stringify([...new Set(ids)]);
  const [owned, removed] = await env.DB.batch<{ id: string }>([
    env.DB.prepare("SELECT id FROM links WHERE user_id=? AND id IN (SELECT value FROM json_each(?))").bind(userId, wanted),
    env.DB.prepare(
      `DELETE FROM links WHERE user_id=? AND id IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.link_id=links.id AND jobs.status='running') RETURNING id`,
    ).bind(userId, wanted),
  ]);
  const deleted = removed!.results.map((r) => r.id);
  const gone = new Set(deleted);
  const running = owned!.results.map((r) => r.id).filter((id) => !gone.has(id));
  return { deleted, running };
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
