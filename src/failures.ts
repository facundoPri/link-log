import type { Job } from "./types";

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

// What Activity shows under a job: the current attempt while retrying, and the reason of the previous one.
export function jobProgress(j: Pick<Job, "status" | "step" | "attempt" | "max_attempts" | "reason" | "preview_reason">) {
  if (j.status === "done")
    return { step: null, note: j.preview_reason ? `No preview: ${failureMessage(j.preview_reason)}` : null };
  if (j.status === "failed") return { step: null, note: null };
  const retrying = !!j.attempt && !!j.max_attempts && j.attempt > 1;
  return {
    step: retrying ? `${j.step} · Attempt ${j.attempt} of ${j.max_attempts}` : j.step,
    note: retrying && j.reason ? `Previous attempt: ${failureMessage(j.reason)}` : null,
  };
}
