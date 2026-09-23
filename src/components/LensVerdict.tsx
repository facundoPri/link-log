import type { Lens, LensResult } from "../types";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function lensBucket(
  lens: Lens,
  result: LensResult,
): "yes" | "unsure" | "no" | string {
  const a = result.answer;
  if (a.type === "noul")
    return a.noul >= lens.threshold
      ? "yes"
      : a.noul >= 0.5
        ? "unsure"
        : "no";
  if (a.type === "choice") return a.choice;
  return "score";
}

export function lensSelectedKeys(lens: Lens, result: LensResult): string[] {
  const a = result.answer;
  if (a.type !== "multi") return [];
  return lens.options
    .filter((o) => (a.probabilities[o.key] ?? 0) >= lens.threshold)
    .map((o) => o.key);
}

export function LensVerdict({
  lens,
  result,
  size = "md",
}: {
  lens: Lens;
  result: LensResult;
  size?: "sm" | "md";
}) {
  const a = result.answer;
  if (a.type !== lens.type) return null;
  const text = size === "sm" ? "text-2xs" : "text-xs";
  if (a.type === "noul") {
    const bucket = lensBucket(lens, result);
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 font-medium tabular",
          text,
          bucket === "yes"
            ? "rounded-sm bg-brand/15 px-1 text-brand"
            : bucket === "unsure"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
        )}
      >
        {bucket === "yes" ? "Yes" : bucket === "unsure" ? "Unsure" : "No"}
        <span className="font-normal opacity-70">
          {Math.round(a.noul * 100)}%
        </span>
      </span>
    );
  }
  if (a.type === "choice") {
    const opt = lens.options.find((o) => o.key === a.choice);
    const optLabel = (key: string) =>
      lens.options.find((o) => o.key === key)?.label ?? key;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="secondary" className={cn("font-normal tabular", text)}>
            {opt?.label ?? a.choice}
            <span className="opacity-60">{Math.round(a.confidence * 100)}%</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {Object.entries(a.probabilities).map(([k, v]) => (
            <div key={k} className="tabular">
              {optLabel(k)} · {Math.round(v * 100)}%
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (a.type === "multi") {
    const selected = lensSelectedKeys(lens, result);
    const shown = selected.slice(0, 2);
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex cursor-default items-center gap-1", text)}>
            {shown.map((k) => (
              <Badge key={k} variant="secondary" className="font-normal">
                {lens.options.find((o) => o.key === k)?.label ?? k}
              </Badge>
            ))}
            {selected.length > 2 && (
              <Badge variant="secondary" className="font-normal tabular">
                +{selected.length - 2}
              </Badge>
            )}
            {!selected.length && (
              <span className="text-muted-foreground">None</span>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {lens.options.map((o) => (
            <div key={o.key} className="tabular">
              {o.label} · {Math.round((a.probabilities[o.key] ?? 0) * 100)}%
            </div>
          ))}
        </TooltipContent>
      </Tooltip>
    );
  }
  // score
  const max = Math.max(lens.levels.length - 1, 1);
  const filled = Math.round(a.score);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex cursor-default items-center gap-1.5", text)}>
          <span className="tabular font-medium">
            {a.score.toFixed(1)}
            <span className="text-muted-foreground"> / {max}</span>
          </span>
          <span className="flex gap-px">
            {lens.levels.map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-2.5 rounded-[2px]",
                  i < filled ? "bg-brand" : "bg-muted",
                )}
              />
            ))}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {lens.levels.map((lv, i) => (
          <div key={i} className="tabular">
            {lv.label} · {Math.round((a.probabilities[String(i)] ?? 0) * 100)}%
          </div>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
