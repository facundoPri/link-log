import type { FeatureUsage } from "../src/types";

// What Linklog spends per feature. One definition per feature says which batch kinds and metered
// services belong to it and how its runs are counted; the usage summary reads them, and a later
// per-plan cap is a limit per feature checked against the same counts. Nothing here is capped.
//
// Usage rows (`usage_events`) carry the tokens, browser time and estimated cost of every provider call;
// `jobs` and `batches` give the runs. Cost comes from `priceUsage`: a call it cannot price is counted
// in `unknownCostCalls`, never as free.
export type UsageFeatureKey = "extract" | "content" | "lens" | "autotag" | "ocr" | "autogroup";

type FeatureDefinition = {
  key: UsageFeatureKey;
  label: string;
  /**
   * Batch kinds whose jobs are this feature's runs (a Link extracted, tagged or evaluated). They also
   * narrow the services below to calls made for those kinds. Without kinds, each call to a service of
   * the feature is a run (a browser render, an image read).
   */
  kinds: readonly string[];
  /** `usage_events.service` values whose tokens, browser time and cost belong to the feature. */
  services: readonly string[];
};

export const USAGE_FEATURES: readonly FeatureDefinition[] = [
  // The preview is read with a plain fetch and has no metered call: it is counted as runs only. A retry
  // ("Retry preview", re-extraction) is another run.
  { key: "extract", label: "Extract (preview)", kinds: ["extract", "preview"], services: [] },
  // Browser Rendering Markdown / rendered HTML, billed by browser time. Every call counts, automatic retries included.
  { key: "content", label: "Content (browser)", kinds: [], services: ["browser-markdown", "browser-content"] },
  // Lens runs on saved Links and on open tabs, billed in Jev tokens.
  { key: "lens", label: "Lenses", kinds: ["lens", "browser-lens"], services: ["jev"] },
  // One run is one Link autotagged.
  { key: "autotag", label: "Autotag", kinds: ["autotag"], services: ["jev"] },
  // Images read with the vision model, billed in tokens.
  { key: "ocr", label: "OCR (images)", kinds: [], services: ["image-ocr"] },
  { key: "autogroup", label: "Autogroup (tabs)", kinds: ["browser-autogroup"], services: ["jev"] },
];

/** Metered services that cost nothing and belong to no feature (images are fetched from public CDNs). */
const FREE_SERVICES = ["image-fetch"];

const OTHER = { key: "other", label: "Other" } as const;

export type MonthUsage = { features: FeatureUsage[]; total: { usd: number; unknownCostCalls: number } };

const featureOf = (kind: string | null, service: string) =>
  USAGE_FEATURES.find((f) => f.services.includes(service) && (!f.kinds.length || (kind !== null && f.kinds.includes(kind))));

type EventRow = { kind: string | null; service: string; calls: number; input: number | null; output: number | null; browser_ms: number | null; usd: number | null; unknown: number };
type RunRow = { kind: string; n: number };

/** The owner's usage in [start, end), per feature. Finished calls only: a call still under way has no cost yet. */
export async function monthUsage(db: D1Database, userId: string, start: string, end: string): Promise<MonthUsage> {
  const [events, jobs] = await Promise.all([
    db
      .prepare(
        `SELECT b.kind,u.service,count(*) calls,sum(u.input_tokens) input,sum(u.output_tokens) output,sum(u.browser_ms) browser_ms,
                sum(u.estimated_usd) usd,sum(u.estimated_usd IS NULL) unknown
         FROM usage_events u LEFT JOIN batches b ON b.id=u.batch_id
         WHERE u.user_id=? AND u.status IN ('done','failed') AND u.created_at>=? AND u.created_at<?
         GROUP BY b.kind,u.service`,
      )
      .bind(userId, start, end)
      .all<EventRow>(),
    // A job that ran: running or done, or failed for any reason but cancelled while it waited.
    db
      .prepare(
        `SELECT b.kind,count(*) n FROM jobs j JOIN batches b ON b.id=j.batch_id
         WHERE b.user_id=? AND j.created_at>=? AND j.created_at<?
           AND (j.status IN ('running','done') OR (j.status='failed' AND j.step IS NOT 'Cancelled'))
         GROUP BY b.kind`,
      )
      .bind(userId, start, end)
      .all<RunRow>(),
  ]);
  const blank = (key: string, label: string): FeatureUsage => ({ key, label, runs: 0, inputTokens: 0, outputTokens: 0, browserMs: 0, usd: 0, unknownCostCalls: 0 });
  const rows = new Map<string, FeatureUsage>(USAGE_FEATURES.map((f) => [f.key, blank(f.key, f.label)]));
  const other = blank(OTHER.key, OTHER.label);
  for (const f of USAGE_FEATURES) if (f.kinds.length) rows.get(f.key)!.runs = jobs.results.filter((r) => f.kinds.includes(r.kind)).reduce((sum, r) => sum + r.n, 0);
  for (const e of events.results) {
    if (FREE_SERVICES.includes(e.service)) continue;
    const def = featureOf(e.kind, e.service);
    const row = def ? rows.get(def.key)! : other;
    if (!def?.kinds.length) row.runs += e.calls;
    row.inputTokens += e.input ?? 0;
    row.outputTokens += e.output ?? 0;
    row.browserMs += e.browser_ms ?? 0;
    row.usd += e.usd ?? 0;
    row.unknownCostCalls += e.unknown;
  }
  const features = [...rows.values(), ...(other.runs ? [other] : [])];
  return { features, total: { usd: features.reduce((sum, f) => sum + f.usd, 0), unknownCostCalls: features.reduce((sum, f) => sum + f.unknownCostCalls, 0) } };
}
