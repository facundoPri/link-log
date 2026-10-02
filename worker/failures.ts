import { FAILURE_MESSAGES, type FailureReason } from "../src/failures";

const RETRYABLE = new Set<FailureReason>(["rate_limited", "timeout", "site_error", "unreachable", "unknown"]);

/** A classified preview or content failure. Its message is the plain text users see. */
export class LinkFailure extends Error {
  readonly retryable: boolean;
  constructor(
    readonly reason: FailureReason,
    readonly detail: { http_status?: number; content_type?: string | null; technical?: string; retryable?: boolean } = {},
  ) {
    super(FAILURE_MESSAGES[reason]);
    this.retryable = detail.retryable ?? RETRYABLE.has(reason);
  }
}

export function statusReason(status: number): FailureReason {
  if (status === 401 || status === 403) return "blocked";
  if (status === 404 || status === 410) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "site_error";
  return "unknown";
}

/** Why a final (non-redirect) preview response can't be used, or null when it is an OK HTML page. */
export function responseFailure(response: Pick<Response, "ok" | "status" | "headers">): LinkFailure | null {
  const content_type = response.headers.get("content-type");
  const http = { http_status: response.status, content_type };
  // Cloudflare and similar bot walls answer 403 or 503 with a challenge marker.
  if (response.headers.get("cf-mitigated")) return new LinkFailure("blocked", http);
  if (!response.ok) {
    const reason = statusReason(response.status);
    return new LinkFailure(reason, { ...http, retryable: reason === "unknown" ? false : undefined });
  }
  if (!content_type?.includes("text/html")) return new LinkFailure("not_html", http);
  return null;
}

/** A Browser Rendering error answer (JSON envelope, never HTML): the HTTP status decides the reason. */
export function browserFailure(status: number, message: string | undefined): LinkFailure {
  const technical = `Browser Rendering HTTP ${status}${message ? `: ${message}` : ""}`;
  if (status >= 200 && status < 300) {
    const found = classify(new Error(message || "Browser Rendering failed"));
    return new LinkFailure(found.reason, { technical, retryable: found.retryable });
  }
  const reason = statusReason(status);
  return new LinkFailure(reason, { technical, http_status: status, retryable: reason === "unknown" ? false : undefined });
}

// Content adapters' own messages that are written for users. Anything else is shown as a plain reason.
export const ADAPTER_MESSAGES = {
  trackGone: "The requested subtitle track is no longer available.",
  transcriptEmpty: "The selected transcript was empty.",
  englishTranscriptEmpty: "The English transcript was empty.",
  youtubePostMissing: "The exact YouTube post was not present in the public page.",
  instagramLogin: "The exact Instagram post was not available without signing in.",
  xPostMissing: "The exact X post was not available in the public page.",
  xTextMissing: "The exact X post text was unavailable.",
} as const;
/** The allowlisted adapter message an error starts with (a fallback may append technical detail). */
export function adapterMessage(raw: string): string | null {
  return Object.values(ADAPTER_MESSAGES).find((m) => raw.startsWith(m)) ?? null;
}

/** Maps any thrown error to a reason. Unknown errors are treated as transient. */
export function classify(error: unknown): LinkFailure {
  if (error instanceof LinkFailure) return error;
  const technical = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const message = error instanceof Error ? error.message : String(error);
  const fixed = Object.entries(FAILURE_MESSAGES).find(([, text]) => text === message);
  if (fixed) return new LinkFailure(fixed[0] as FailureReason, { technical });
  if ((error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) || /timed? ?out|timeout|ERR_TIMED_OUT/i.test(message))
    return new LinkFailure("timeout", { technical });
  if (/^(Private address|Private host|Unsupported port|Not a public destination)$/.test(message))
    return new LinkFailure("unreachable", { technical, retryable: false });
  if (/DNS|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(message))
    return new LinkFailure("unreachable", { technical });
  const http = message.match(/\bHTTP (\d{3})\b/);
  if (http) {
    const status = Number(http[1]);
    const reason = statusReason(status);
    return new LinkFailure(reason, { technical, http_status: status, retryable: reason === "unknown" ? false : undefined });
  }
  return new LinkFailure("unknown", { technical });
}

/** One structured line per failed attempt, for Workers Logs. Only the domain, never the full URL. */
export function logFailure(
  failure: LinkFailure,
  at: { link_id: string; job_id: string | null; step: string; adapter: string | null; url: string; attempt: number; max_attempts: number; final: boolean },
) {
  let domain = "";
  try { domain = new URL(at.url).hostname; } catch { /* invalid URL */ }
  console.log(JSON.stringify({
    event: "link_step_failed",
    link_id: at.link_id,
    job_id: at.job_id,
    step: at.step,
    adapter: at.adapter,
    attempt: at.attempt,
    max_attempts: at.max_attempts,
    final: at.final,
    reason: failure.reason,
    retryable: failure.retryable,
    http_status: failure.detail.http_status ?? null,
    content_type: failure.detail.content_type ?? null,
    domain,
    detail: failure.detail.technical?.replace(/https?:\/\/\S+/g, "<url>").slice(0, 300) ?? null,
  }));
}

const PHASES: Record<string, string> = { "Fetching preview": "preview", "Extracting content": "content" };
/** A final failure raised outside the classified attempt: log it with the attempt data the job persisted. */
export async function logResidualFailure(env: Env, failure: LinkFailure, at: { link_id: string; job_id: string; url: string }) {
  const job = await env.DB.prepare("SELECT step,attempt,max_attempts,adapter FROM jobs WHERE id=?").bind(at.job_id)
    .first<{ step: string; attempt: number | null; max_attempts: number | null; adapter: string | null }>();
  logFailure(failure, {
    ...at,
    step: PHASES[job?.step ?? ""] ?? "extract",
    adapter: job?.adapter ?? null,
    attempt: job?.attempt ?? 1,
    max_attempts: job?.max_attempts ?? 1,
    final: true,
  });
}
