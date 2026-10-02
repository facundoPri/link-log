import type { Capabilities, Link } from "./types";

// Only a settled link counts: while a job is still working on it (queued, running or retrying another
// step), a failed preview is not final yet. A pending preview is processing or neutral, never failed.
export const needsAttention = (l: Pick<Link, "status" | "content_state" | "processing">) =>
  !l.processing && (l.status === "failed" || l.content_state === "failed");
// The API refuses a preview retry while a job is active, so only offer it when idle.
export const canRetryPreview = (l: Pick<Link, "status" | "processing">) =>
  !l.processing && (l.status === "failed" || l.status === "pending");
// Auto-tag and lenses need Jev; the API refuses them up front when it is not configured.
export const jevUnavailable = (c: Pick<Capabilities, "jev" | "provider">) =>
  c.jev ? null : c.provider === "typesafe" ? "Jev is not configured: API key missing." : "Jev is not configured.";
