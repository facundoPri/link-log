import {
  toEvaluationTarget,
  type BrowserCatalog,
  type ClaimTarget,
  type EvaluationRequest,
  type EvaluationStatus,
} from "@linklog/browser-protocol";

import { announceUnauthorized } from "../auth-client";

export class OfflineError extends Error {}

/** Same-origin call that keeps the HTTP status (idempotent flows branch on 404/409). */
export async function call<T>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T & { error?: string; code?: string } }> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new OfflineError("The local Linklog API is unreachable.");
  }
  if (response.status === 503 || response.status === 502) throw new OfflineError("The local Linklog API is unavailable.");
  // The session ended (expiry, revocation, sign-out elsewhere): the gate shows the sign-in screen.
  if (response.status === 401) announceUnauthorized();
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { status: response.status, data };
}

export async function fetchCatalog(): Promise<BrowserCatalog> {
  const { status, data } = await call<BrowserCatalog>("/browser/catalog");
  if (status !== 200) throw new Error(data.error || "Could not load the browser catalog.");
  return data;
}

export function evaluationTargets(targets: ClaimTarget[]): EvaluationRequest["targets"] {
  return targets.map(toEvaluationTarget);
}

export async function postEvaluation(body: EvaluationRequest) {
  return call<EvaluationStatus>("/browser/evaluations", "POST", body);
}

export async function evaluationStatus(requestId: string) {
  return call<EvaluationStatus>(`/browser/evaluations/${requestId}`);
}

/** Cancels queued work for exactly these targets (never the rest of the request). */
export async function cancelTargets(requestId: string, targetKeys: string[]) {
  for (let i = 0; i < targetKeys.length; i += 100)
    await call(`/browser/evaluations/${requestId}`, "DELETE", { targetKeys: targetKeys.slice(i, i + 100) });
}
