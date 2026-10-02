import type { Job } from "./types";
import { duration } from "./lib/format";

// Plain reasons shown to users. Technical detail (HTTP status, content type, raw error) goes to Workers Logs.
export const FAILURE_MESSAGES = {
  blocked: "The site blocks automated access.",
  not_found: "The page no longer exists.",
  not_html: "This link is a file (like a PDF), not a web page.",
  rate_limited: "The site is limiting requests right now.",
  timeout: "The site took too long to respond.",
  site_error: "The site had a problem.",
  unreachable: "The site could not be reached.",
  empty: "The page returned no content. You can paste it manually.",
  too_large: "The content is larger than 2 MB. You can upload a manual version.",
  unknown: "Something went wrong.",
} as const;
export type FailureReason = keyof typeof FAILURE_MESSAGES;

export const failureMessage = (reason: string | null | undefined) =>
  reason && reason in FAILURE_MESSAGES ? FAILURE_MESSAGES[reason as FailureReason] : null;

// What Activity shows under a job: the current attempt with its elapsed time against the attempt's
// time budget, and the reason of the previous failed attempt while retrying.
export function jobProgress(
  j: Pick<Job, "status" | "step" | "attempt" | "max_attempts" | "reason" | "preview_reason" | "attempt_started_at" | "attempt_budget_ms">,
  now = Date.now(),
) {
  if (j.status === "done")
    return { step: null, note: j.preview_reason ? `No preview: ${failureMessage(j.preview_reason)}` : null };
  if (j.status === "failed" || !j.attempt) return { step: j.status === "failed" ? null : j.step, note: null };
  const parts = [j.step];
  if (j.max_attempts && j.max_attempts > 1) parts.push(`Attempt ${j.attempt} of ${j.max_attempts}`);
  if (j.attempt_started_at && j.attempt_budget_ms)
    parts.push(`${duration(Math.min(Math.max(now - j.attempt_started_at, 0), j.attempt_budget_ms))} of ${duration(j.attempt_budget_ms)}`);
  else if (j.attempt > 1 && j.reason) parts.push("Waiting to retry");
  return {
    step: parts.join(" · "),
    note: j.attempt > 1 && j.reason ? `Previous attempt: ${failureMessage(j.reason)}` : null,
  };
}
