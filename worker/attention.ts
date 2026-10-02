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

export const readAttentionState = (db: D1Database, linkId: string) =>
  db.prepare("SELECT status,preview_reason,content_key,attention_kind,attention_reason FROM links WHERE id=?").bind(linkId).first<State>();

// The SET clause for a new attention state; attention_at keeps its time while the state is unchanged.
export function attentionSet(next: Pick<Link, "attention_kind" | "attention_reason">) {
  return {
    sql: "attention_kind=?,attention_reason=?,attention_at=CASE WHEN attention_kind IS ? AND attention_reason IS ? THEN attention_at ELSE ? END",
    params: [next.attention_kind, next.attention_reason, next.attention_kind, next.attention_reason, next.attention_kind ? new Date().toISOString() : null],
  };
}

export async function settleAttention(db: D1Database, linkId: string, outcome: StepOutcomes) {
  const link = await readAttentionState(db, linkId);
  if (!link) return;
  const set = attentionSet(nextAttention(link, outcome));
  await db.prepare(`UPDATE links SET ${set.sql} WHERE id=?`).bind(...set.params, linkId).run();
}
