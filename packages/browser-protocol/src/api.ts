import type { Answer } from "./lens.ts";
import type { ClaimTarget, GroupColor, PageFact } from "./browser.ts";

/**
 * Backend limits reused by the browser flow. Keep in sync with worker/ai/jev.ts.
 * Jev cost is bounded per tab (one call each, content trimmed to maxCaptureChars);
 * the byte limit below is only the transport cap of one POST to our Worker.
 */
export const BROWSER_LIMITS = {
  maxTargets: 100,
  maxCaptureChars: 160_000,
  /** UTF-8 bytes of one JSON body, with margin under the Worker's 2.1 MB cap. */
  maxRequestBytes: 1_800_000,
  /** Room for everything in an evaluation body besides its targets. */
  requestOverheadBytes: 16_000,
  maxDestinations: 10,
  /** URLs per Save request (same as a library import batch). */
  maxSaveItems: 100,
  maxUrlChars: 4096,
  /** Links opened as tabs by one Open request. */
  maxOpenUrls: 50,
  maxTitleChars: 1000,
} as const;

export type EvaluationCapture = {
  source: "dom" | "metadata";
  capturedAt: string;
  completeness: "complete" | "partial";
  reasons: string[];
  facts: PageFact[];
  description: string;
  siteName: string;
  markdown: string;
};

export type EvaluationTarget = {
  targetKey: string;
  url: string;
  title: string;
  capture: EvaluationCapture;
};

export type Destination = { key: string; name: string; description: string };

export type EvaluationRequest = {
  requestId: string;
  libraryId: string;
  sessionId: string;
  targets: EvaluationTarget[];
} & (
  | { kind: "lens"; lens: { id: string; fingerprint: string } }
  | { kind: "autogroup"; destinations: Destination[]; catalogVersion: string }
);

export type TargetStatus = {
  targetKey: string;
  jobId: string;
  state: "queued" | "running" | "done" | "failed" | "expired" | "acked";
  answer?: Answer;
  model?: string;
  evaluatedAt?: string;
  error?: string;
};

export type EvaluationStatus = {
  requestId: string;
  batchId: string;
  kind: "lens" | "autogroup";
  targets: TargetStatus[];
};

export type PinnedGroup = {
  id: string;
  name: string;
  description: string;
  color: GroupColor;
  version: number;
  created_at: string;
  updated_at: string;
};

export type BrowserCatalog = {
  libraryId: string;
  groups: PinnedGroup[];
  retentionDays: number;
};

/** Save sends URLs only; the library fetches and extracts them like any added link. */
export type SaveResult = {
  url: string;
  status: "created" | "duplicate" | "rejected";
  id?: string;
  error?: string;
};

/** The body a claimed tab becomes in an evaluation request (fields trimmed to backend limits). */
export function toEvaluationTarget(t: Pick<ClaimTarget, "targetKey" | "url" | "title" | "capture">): EvaluationTarget {
  return {
    targetKey: t.targetKey,
    url: t.url.slice(0, BROWSER_LIMITS.maxUrlChars),
    title: (t.title || t.url).slice(0, BROWSER_LIMITS.maxTitleChars),
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
  };
}
