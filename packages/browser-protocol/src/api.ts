import type { Answer } from "./lens.ts";
import type { GroupColor, PageFact } from "./browser.ts";

/** Backend limits reused by the browser flow. Keep in sync with worker/ai/jev.ts. */
export const BROWSER_LIMITS = {
  maxTargets: 100,
  maxCaptureChars: 160_000,
  /** Split POSTs well under the Worker's 2.1 MB request cap. */
  maxRequestChars: 1_600_000,
  maxDestinations: 10,
  maxSaveItems: 50,
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

export type SaveItem = {
  key: string;
  url: string;
  title: string;
  favicon: string | null;
  capture?: EvaluationCapture;
};

export type SaveResult = {
  key: string;
  status: "created" | "duplicate" | "rejected";
  id?: string;
  error?: string;
};
