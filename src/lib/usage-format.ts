import type { FeatureUsage } from "../types";

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** "1.2M tokens"; nothing for none. */
export const formatTokens = (tokens: number) => (tokens > 0 ? `${compact.format(tokens)} tokens` : "");

/** Browser time as the largest sensible unit: "850 ms", "42 s", "3.5 min", "1.2 h"; nothing for none. */
export function formatBrowserTime(ms: number) {
  if (ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const trim = (n: number) => String(Math.round(n * 10) / 10);
  return ms < 3_600_000 ? `${trim(ms / 60_000)} min` : `${trim(ms / 3_600_000)} h`;
}

/** Small amounts keep their digits ($0.0009): an estimate that rounds to $0.00 would hide the spend. */
export const formatUsd = (usd: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: usd > 0 && usd < 1 ? 4 : 2 }).format(usd);

/** What a feature used, in the units it is billed in: tokens and/or browser time. */
export const featureUnits = (f: Pick<FeatureUsage, "inputTokens" | "outputTokens" | "browserMs">) =>
  [formatTokens(f.inputTokens + f.outputTokens), formatBrowserTime(f.browserMs)].filter(Boolean).join(" · ");

/** The cost cell: the priced total, how many calls had no price, or a dash when nothing was billed. */
export function featureCost(f: Pick<FeatureUsage, "usd" | "unknownCostCalls">) {
  const unpriced = f.unknownCostCalls ? `${f.unknownCostCalls} unpriced` : "";
  return { amount: f.usd > 0 ? formatUsd(f.usd) : unpriced ? "" : "—", unpriced };
}

/** Minutes until a window resets, at least 1. */
export const minutesUntil = (iso: string, now = Date.now()) => Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
