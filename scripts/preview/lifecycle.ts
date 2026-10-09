import { names } from "./model";
import type { Cloudflare } from "./cloudflare";

export async function settleDeployment(cf: Cloudflare, repositoryId: string, pr: string,
  state: { action: string; sha: string }, expectedSha: string) {
  if (state.action === "deploy" && state.sha === expectedSha) return true;
  if (state.action === "cleanup") await cleanup(cf, repositoryId, pr);
  else {
    // Keep accounts/content across ordinary pushes. Suppress the stale public endpoint;
    // the next serialized successful deploy explicitly re-enables workers_dev.
    const n = names(repositoryId, pr);
    await cf.api(`/workers/scripts/${n.worker}/subdomain`, "POST", { enabled: false, previews_enabled: false });
  }
  return false;
}

function resourceId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{32,36}$/.test(value)) throw new Error("Invalid resource ID");
  return value;
}
export async function resources(cf: Cloudflare, repositoryId: string, pr: string, create: boolean) {
  const n = names(repositoryId, pr);
  let db = await cf.named("/d1/database", "name", n.db);
  let queue = await cf.named("/queues", "queue_name", n.queue);
  let bucket = (await cf.api(`/r2/buckets/${n.bucket}`, "GET", undefined, true))?.result;
  if (bucket && bucket.name !== n.bucket) throw new Error("R2 identity mismatch");
  if (create) {
    db ??= (await cf.api("/d1/database", "POST", { name: n.db })).result;
    queue ??= (await cf.api("/queues", "POST", { queue_name: n.queue })).result;
    bucket ??= (await cf.api("/r2/buckets", "POST", { name: n.bucket })).result;
  }
  if (db && db.name !== n.db || queue && queue.queue_name !== n.queue || bucket && bucket.name !== n.bucket) throw new Error("Resource identity mismatch");
  if (db) resourceId(db.uuid);
  if (queue) {
    resourceId(queue.queue_id);
    const detail = (await cf.api(`/queues/${queue.queue_id}`)).result;
    if (detail.queue_name !== n.queue) throw new Error("Queue identity mismatch");
    for (const consumer of detail.consumers ?? []) {
      if (consumer.script_name !== n.worker) throw new Error("Queue has a foreign consumer; refusing to mutate");
    }
    queue = detail;
  }
  return { db, queue, bucket };
}

export async function cleanup(cf: Cloudflare, repositoryId: string, pr: string) {
  const n = names(repositoryId, pr);
  const { db, queue, bucket } = await resources(cf, repositoryId, pr, false);
  // Stop asynchronous writers before destroying storage. Missing resources alone are benign;
  // permissions/network errors abort and are retried by rerunning the same workflow.
  for (const consumer of queue?.consumers ?? []) {
    await cf.api(`/queues/${resourceId(queue.queue_id)}/consumers/${resourceId(consumer.consumer_id)}`, "DELETE", undefined, true);
  }
  await cf.api(`/workflows/${n.workflow}`, "DELETE", undefined, true);
  await cf.api(`/workers/scripts/${n.worker}`, "DELETE", undefined, true);
  if (queue) await cf.api(`/queues/${resourceId(queue.queue_id)}`, "DELETE", undefined, true);
  if (bucket) {
    // Re-read the first page after deletion: no cursor can skip objects as the set shrinks.
    for (let page = 0; ; page++) {
      if (page >= 10000) throw new Error("R2 cleanup limit reached; rerun cleanup");
      const batch = await cf.api(`/r2/buckets/${n.bucket}/objects?per_page=1000`);
      if (!Array.isArray(batch.result)) throw new Error("Invalid R2 object list");
      if (!batch.result.length) break;
      for (const object of batch.result) {
        if (typeof object.key !== "string" || [".", "..", ""].includes(object.key)) throw new Error("Invalid R2 key; remove this object through the R2 dashboard");
        // Encode the entire key: slashes, ?, # and ../ must remain object-key data.
        await cf.api(`/r2/buckets/${n.bucket}/objects/${encodeURIComponent(object.key)}`, "DELETE", undefined, true);
      }
    }
    await cf.api(`/r2/buckets/${n.bucket}`, "DELETE", undefined, true);
  }
  if (db) await cf.api(`/d1/database/${resourceId(db.uuid)}`, "DELETE", undefined, true);
}
