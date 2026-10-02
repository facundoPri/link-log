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
  service_unavailable: "The page reader is unavailable right now. Try again later.",
  login_wall: "Got a login page instead of the content.",
  unknown: "Something went wrong.",
} as const;
export type FailureReason = keyof typeof FAILURE_MESSAGES;

// Jev failures say whether the provider was called: before the call nothing is billed, after it may be.
export const JEV_FAILURE_MESSAGES = {
  storage_busy: "Failed before calling Jev (no cost): saved data was briefly unavailable.",
  before_call: "Failed before calling Jev (no cost).",
  account_stopped: "Stopped before calling Jev (no cost): Jev refused an earlier request in this batch. Check the API key or the account balance.",
  account: "Jev refused the request: check the API key or the account balance. It may have been billed.",
  provider_error: "Jev returned an error (may have been billed).",
  no_answer: "Jev did not answer in time (may have been billed).",
  network: "Could not reach Jev (may have been billed).",
  invalid_response: "Jev returned an invalid answer (may have been billed).",
  too_long: "Jev rejected the content for exceeding its token window. The full document is still saved and its tags were not changed. To classify it, split the content or paste a shorter version.",
  interrupted: "The Jev call was interrupted (may have been billed).",
  cancelled_sent: "Cancelled after calling Jev (may have been billed).",
} as const;
export type JevReason = keyof typeof JEV_FAILURE_MESSAGES;

export const failureMessage = (reason: string | null | undefined) =>
  !reason ? null
    : reason in FAILURE_MESSAGES ? FAILURE_MESSAGES[reason as FailureReason]
    : reason in JEV_FAILURE_MESSAGES ? JEV_FAILURE_MESSAGES[reason as JevReason]
    : null;

// What Activity shows under a job: the current attempt with its elapsed time against the attempt's
// time budget, and the reason of the previous failed attempt while retrying.
const WAITING_FOR: Record<string, string> = { extract: "extraction", preview: "the preview", autotag: "auto-tag", lens: "a lens" };
export function jobProgress(
  j: Pick<Job, "status" | "waiting_for" | "step" | "attempt" | "max_attempts" | "reason" | "preview_reason" | "attempt_started_at" | "attempt_budget_ms">,
  now = Date.now(),
) {
  if (j.status === "waiting")
    return { step: `Waiting for ${(j.waiting_for && WAITING_FOR[j.waiting_for]) || "another job on this link"}`, note: null };
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
