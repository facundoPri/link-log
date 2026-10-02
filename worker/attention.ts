import type { Link } from "../src/types";

/** How each step of a settled job ended; a step that did not run is left out. */
export type StepOutcomes = { preview?: "ok" | "failed"; content?: "ok" | "failed"; content_reason?: string | null };
type State = Pick<Link, "status" | "preview_reason" | "content_key" | "attention_kind" | "attention_reason">;

// Needs attention is only decided when a job settles, never while it is queued, running or retrying.
// A final failure raises it unless the previous version is still shown; the same step's success clears it.
// Content comes first: once it recovers, a preview that is still failed takes its place.
export function nextAttention(link: State, outcome: StepOutcomes): Pick<Link, "attention_kind" | "attention_reason"> {
  const clear = { attention_kind: null, attention_reason: null };
  let { attention_kind, attention_reason } = link;
  if (outcome.content === "failed") {
    if (!link.content_key) return { attention_kind: "content", attention_reason: outcome.content_reason ?? null };
    // A failed re-extract that still shows the previous content adds nothing, not even for its preview.
    return outcome.preview === "ok" && attention_kind === "preview" ? clear : { attention_kind, attention_reason };
  }
  const preview = { attention_kind: "preview" as const, attention_reason: link.preview_reason };
  if (attention_kind === "content" && outcome.content === "ok")
    ({ attention_kind, attention_reason } = link.status === "failed" ? preview : clear);
  if (outcome.preview === "failed" && link.status === "failed" && attention_kind !== "content") return preview;
  if (outcome.preview === "ok" && attention_kind === "preview") return clear;
  return { attention_kind, attention_reason };
}

const readAttentionState = (db: D1Database, linkId: string) =>
  db.prepare("SELECT status,preview_reason,content_key,attention_kind,attention_reason FROM links WHERE id=?").bind(linkId).first<State>();

/** Fences a Workflow's write on its job still running, inside the statement: a cancelled job writes nothing. */
export const jobRunning = "EXISTS (SELECT 1 FROM jobs WHERE id=? AND status='running')";
// Settles against the live row: a state that only stays the same is never written back, and a change only
// applies if nobody (Dismiss) changed the attention since it was read; otherwise it is read again.
// With a job, every write also requires that job to be still running (a cancelled job settles nothing).
export async function settleAttention(db: D1Database, linkId: string, outcome: StepOutcomes, jobId?: string) {
  for (let i = 0; i < 3; i++) {
    const link = await readAttentionState(db, linkId);
    if (!link) return;
    const next = nextAttention(link, outcome);
    if (next.attention_kind === link.attention_kind && next.attention_reason === link.attention_reason) return;
    const changed = await db.prepare(`UPDATE links SET attention_kind=?,attention_reason=?,attention_at=? WHERE id=? AND attention_kind IS ? AND attention_reason IS ?${jobId ? ` AND ${jobRunning}` : ""}`)
      .bind(next.attention_kind, next.attention_reason, next.attention_kind ? new Date().toISOString() : null, linkId, link.attention_kind, link.attention_reason, ...(jobId ? [jobId] : [])).run();
    if (changed.meta.changes) return;
    if (jobId && !(await db.prepare(`SELECT 1 WHERE ${jobRunning}`).bind(jobId).first())) return;
  }
}

// nextAttention for a final content failure, written as SQL over the live row so it can share the failure's
// transaction: without content it raises content attention; with the previous content kept it leaves the
// attention as it is, except that a preview that worked in this job clears a preview warning.
export function contentFailureAttentionSql(reason: string | null, previewOk: boolean) {
  const clears = previewOk ? "attention_kind='preview'" : "0";
  return {
    sql: `attention_kind=CASE WHEN content_key IS NULL THEN 'content' WHEN ${clears} THEN NULL ELSE attention_kind END,
attention_reason=CASE WHEN content_key IS NULL THEN ? WHEN ${clears} THEN NULL ELSE attention_reason END,
attention_at=CASE WHEN content_key IS NULL THEN CASE WHEN attention_kind IS 'content' AND attention_reason IS ? THEN attention_at ELSE ? END WHEN ${clears} THEN NULL ELSE attention_at END`,
    params: [reason, reason, new Date().toISOString()],
  };
}
