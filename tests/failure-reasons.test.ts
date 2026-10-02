import { expect, test } from "bun:test";
import { classify, LinkFailure, responseFailure } from "../worker/failures";
import { FAILURE_MESSAGES, jobProgress } from "../src/failures";

const res = (status: number, type = "text/html", headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { "content-type": type, ...headers } });
const pick = (f: LinkFailure | null) => f && { reason: f.reason, retryable: f.retryable, http_status: f.detail.http_status, message: f.message };

test("preview responses: blocked, not found and non-HTML fail fast; 429 and 5xx are retried", () => {
  expect(pick(responseFailure(res(403)))).toEqual({ reason: "blocked", retryable: false, http_status: 403, message: FAILURE_MESSAGES.blocked });
  expect(pick(responseFailure(res(401)))?.reason).toBe("blocked");
  expect(pick(responseFailure(res(503, "text/html", { "cf-mitigated": "challenge" })))).toMatchObject({ reason: "blocked", retryable: false });
  expect(pick(responseFailure(res(404)))).toMatchObject({ reason: "not_found", retryable: false });
  expect(pick(responseFailure(res(410)))).toMatchObject({ reason: "not_found", retryable: false });
  expect(pick(responseFailure(res(200, "application/pdf")))).toMatchObject({ reason: "not_html", retryable: false, http_status: 200 });
  expect(responseFailure(res(200, "application/pdf"))?.detail.content_type).toBe("application/pdf");
  expect(pick(responseFailure(res(429)))).toMatchObject({ reason: "rate_limited", retryable: true });
  expect(pick(responseFailure(res(408)))).toMatchObject({ reason: "timeout", retryable: true });
  expect(pick(responseFailure(res(500)))).toMatchObject({ reason: "site_error", retryable: true });
  expect(pick(responseFailure(res(503)))).toMatchObject({ reason: "site_error", retryable: true });
  expect(pick(responseFailure(res(451)))).toMatchObject({ reason: "unknown", retryable: false });
  expect(responseFailure(res(200, "text/html; charset=utf-8"))).toBeNull();
});

test("thrown errors: timeouts, network and Markdown HTTP errors map to plain reasons", () => {
  expect(pick(classify(new DOMException("The operation timed out.", "TimeoutError")))).toMatchObject({ reason: "timeout", retryable: true });
  expect(pick(classify(new Error("Navigation timeout of 30000 ms exceeded")))).toMatchObject({ reason: "timeout", retryable: true });
  expect(pick(classify(new Error("DNS unavailable")))).toMatchObject({ reason: "unreachable", retryable: true });
  expect(pick(classify(new TypeError("fetch failed")))).toMatchObject({ reason: "unreachable", retryable: true });
  expect(pick(classify(new Error("Private host")))).toMatchObject({ reason: "unreachable", retryable: false });
  expect(pick(classify(new Error("Not a public destination")))).toMatchObject({ reason: "unreachable", retryable: false });
  expect(pick(classify(new Error("Markdown: HTTP 503")))).toMatchObject({ reason: "site_error", retryable: true, http_status: 503 });
  expect(pick(classify(new Error("Markdown: HTTP 429")))).toMatchObject({ reason: "rate_limited", retryable: true });
  expect(pick(classify(new Error("Markdown: HTTP 403")))).toMatchObject({ reason: "blocked", retryable: false });
  expect(pick(classify(new Error("boom")))).toMatchObject({ reason: "unknown", retryable: true, message: FAILURE_MESSAGES.unknown });
  // A LinkFailure that crossed a Workflow step boundary arrives as a plain Error with the same message.
  expect(pick(classify(new Error(FAILURE_MESSAGES.not_html)))).toMatchObject({ reason: "not_html", retryable: false });
  expect(classify(new Error("boom")).detail.technical).toBe("Error: boom");
});

test("Activity shows the current attempt and the previous reason only while retrying", () => {
  const base = { status: "running" as const, step: "Fetching preview", attempt: 1, max_attempts: 3, reason: null, preview_reason: null };
  expect(jobProgress(base)).toEqual({ step: "Fetching preview", note: null });
  expect(jobProgress({ ...base, attempt: 2, reason: "timeout" })).toEqual({
    step: "Fetching preview · Attempt 2 of 3",
    note: "Previous attempt: The site took too long to respond.",
  });
  expect(jobProgress({ ...base, status: "queued", step: "En cola", attempt: null, max_attempts: null })).toEqual({ step: "En cola", note: null });
  expect(jobProgress({ ...base, status: "done", preview_reason: "blocked" })).toEqual({ step: null, note: "No preview: The site blocks automated access." });
  expect(jobProgress({ ...base, status: "failed", reason: "timeout" })).toEqual({ step: null, note: null });
});
