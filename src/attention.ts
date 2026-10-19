import type { Capabilities, Link } from "./types";
import { metadataText } from "./metadata-text";
import { failureMessage } from "./failures";

// Persisted by the API when a step fails for good (never while queued, running or retrying). It stays
// while a retry runs, so the link doesn't leave the list until the failed step succeeds or is dismissed.
export const needsAttention = (l: Pick<Link, "attention_kind">) => l.attention_kind !== null;
export const attentionMessage = (l: Pick<Link, "attention_kind" | "attention_reason">) =>
  `${l.attention_kind === "content" ? "Couldn't get the content" : "Couldn't get the preview"}: ${failureMessage(l.attention_reason) ?? "Something went wrong."}`;
// With content that failed for good, the preview (title + description) can stand in for it (FAC-56).
export const canUsePreview = (l: Pick<Link, "attention_kind" | "content_key" | "processing" | "title" | "description" | "domain" | "url" | "title_source">) =>
  l.attention_kind === "content" && !l.content_key && !l.processing && !!metadataText(l);
// The API refuses a preview retry while a job is active, so only offer it when idle.
export const canRetryPreview = (l: Pick<Link, "status" | "processing">) =>
  !l.processing && (l.status === "failed" || l.status === "pending");
// Auto-tag and lenses need Jev; the API refuses them up front when it is not configured.
export const jevUnavailable = (c: Pick<Capabilities, "jev" | "provider">) =>
  c.jev ? null : c.provider === "typesafe" ? "Jev is not configured: API key missing." : "Jev is not configured.";
