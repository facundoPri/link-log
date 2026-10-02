import type { Link } from "../src/types";

/** How each step of a settled job ended; a step that did not run is left out. */
export type StepOutcomes = { preview?: "ok" | "failed"; content?: "ok" | "failed"; content_reason?: string | null };
type State = Pick<Link, "status" | "preview_reason" | "content_key" | "attention_kind" | "attention_reason">;

// Needs attention is only decided when a job settles, never while it is queued, running or retrying.
// A final failure raises it unless the previous version is still shown; the same step's success clears it.
// Content comes first: once it recovers, a preview that is still failed takes its place.
export function nextAttention(link: State, outcome: StepOutcomes): Pick<Link, "attention_kind" | "attention_reason"> {
  if (outcome.content === "failed" && !link.content_key)
    return { attention_kind: "content", attention_reason: outcome.content_reason ?? null };
  let { attention_kind, attention_reason } = link;
  const preview = { attention_kind: "preview" as const, attention_reason: link.preview_reason };
  if (attention_kind === "content" && outcome.content === "ok")
    ({ attention_kind, attention_reason } = link.status === "failed" ? preview : { attention_kind: null, attention_reason: null });
  if (outcome.preview === "failed" && link.status === "failed" && attention_kind !== "content") return preview;
  if (outcome.preview === "ok" && attention_kind === "preview") return { attention_kind: null, attention_reason: null };
  return { attention_kind, attention_reason };
}

export async function settleAttention(db: D1Database, linkId: string, outcome: StepOutcomes) {
  const link = await db.prepare("SELECT status,preview_reason,content_key,attention_kind,attention_reason FROM links WHERE id=?")
    .bind(linkId).first<State>();
  if (!link) return;
  const next = nextAttention(link, outcome);
  if (next.attention_kind === link.attention_kind && next.attention_reason === link.attention_reason) return;
  await db.prepare("UPDATE links SET attention_kind=?,attention_reason=?,attention_at=? WHERE id=?")
    .bind(next.attention_kind, next.attention_reason, next.attention_kind ? new Date().toISOString() : null, linkId).run();
}
