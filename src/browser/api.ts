import type {
  BrowserCatalog,
  ClaimTarget,
  EvaluationRequest,
  EvaluationStatus,
} from "@linklog/browser-protocol";

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
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  return { status: response.status, data };
}

export async function fetchCatalog(): Promise<BrowserCatalog> {
  const { status, data } = await call<BrowserCatalog>("/browser/catalog");
  if (status !== 200) throw new Error(data.error || "Could not load the browser catalog.");
  return data;
}

export function evaluationTargets(targets: ClaimTarget[]): EvaluationRequest["targets"] {
  return targets.map((t) => ({
    targetKey: t.targetKey,
    url: t.url.slice(0, 4096),
    title: (t.title || t.url).slice(0, 1000),
    capture: {
      source: t.capture.source,
      capturedAt: t.capture.capturedAt,
      completeness: t.capture.completeness,
      reasons: t.capture.reasons,
      facts: t.capture.facts,
      description: t.capture.description.slice(0, 2000),
      siteName: t.capture.siteName.slice(0, 200),
      markdown: t.capture.markdown,
    },
  }));
}

export async function postEvaluation(body: EvaluationRequest) {
  return call<EvaluationStatus>("/browser/evaluations", "POST", body);
}

export async function evaluationStatus(requestId: string) {
  return call<EvaluationStatus>(`/browser/evaluations/${requestId}`);
}
