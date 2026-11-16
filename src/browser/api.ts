import { queryOptions } from "@tanstack/react-query";
import {
  toEvaluationTarget,
  type BrowserCatalog,
  type ClaimTarget,
  type EvaluationRequest,
  type EvaluationStatus,
} from "@linklog/browser-protocol";

import type { WriteMethod } from "../api";
import { announceUnauthorized } from "../auth-client";

export class OfflineError extends Error {}

type Answer<T> = Promise<{ status: number; data: T & { error?: string; code?: string } }>;

/** Same-origin request that keeps the HTTP status (idempotent flows branch on 404/409). */
async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Answer<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      signal,
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

/** A write. Reads are the query options below: the only way to read is through the query cache, with its signal. */
export const call = <T>(path: string, method: WriteMethod, body?: unknown) => request<T>(path, method, body);

/** The catalog. Read it with `queryClient.fetchQuery(catalogQuery)`. */
export const catalogQuery = queryOptions({
  queryKey: ["browser-catalog"],
  queryFn: async ({ signal }): Promise<BrowserCatalog> => {
    const { status, data } = await request<BrowserCatalog>("/browser/catalog", "GET", undefined, signal);
    if (status !== 200) throw new Error(data.error || "Could not load the browser catalog.");
    return data;
  },
});

/**
 * One evaluation request's status, as `{ status, data }` (the 404/409 branches need the status). Always
 * fresh and not kept: the polls that read it own the result. Read it with `queryClient.fetchQuery`.
 */
export const evaluationStatusQuery = (requestId: string) =>
  queryOptions({
    queryKey: ["browser-evaluation", requestId],
    queryFn: ({ signal }) => request<EvaluationStatus>(`/browser/evaluations/${requestId}`, "GET", undefined, signal),
    staleTime: 0,
    gcTime: 0,
  });

export function evaluationTargets(targets: ClaimTarget[]): EvaluationRequest["targets"] {
  return targets.map(toEvaluationTarget);
}

export async function postEvaluation(body: EvaluationRequest) {
  return call<EvaluationStatus>("/browser/evaluations", "POST", body);
}

/** Cancels queued work for exactly these targets (never the rest of the request). */
export async function cancelTargets(requestId: string, targetKeys: string[]) {
  for (let i = 0; i < targetKeys.length; i += 100)
    await call(`/browser/evaluations/${requestId}`, "DELETE", { targetKeys: targetKeys.slice(i, i + 100) });
}
