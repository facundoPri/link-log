import type { Link } from "./types";

// A pending preview never counts: it is either processing (active job) or neutral
// (cancelled, interrupted or never run).
export const needsAttention = (l: Pick<Link, "status" | "content_state">) =>
  l.status === "failed" || l.content_state === "failed";
// The API refuses a preview retry while a job is active, so only offer it when idle.
export const canRetryPreview = (l: Pick<Link, "status" | "processing">) =>
  l.status === "failed" || (l.status === "pending" && !l.processing);
