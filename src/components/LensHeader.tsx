import { ArrowDownWideNarrow, Pencil } from "lucide-react";
import type { Lens, LensResult } from "../types";
import { cn } from "../lib/utils";
import { lensBucket, lensSelectedKeys } from "./LensVerdict";
import { lensIcon } from "./Sidebar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
        active
          ? "border-brand/40 bg-brand/10 text-brand"
          : "text-foreground hover:bg-accent",
      )}
    >
      {label}
      <span className="text-muted-foreground tabular">{count}</span>
    </button>
  );
}

export function LensHeader({
  lens,
  results,
  filter,
  minLevel,
  scoreSort,
  onToggle,
  onMinLevel,
  onScoreSort,
  onEdit,
}: {
  lens: Lens;
  results: LensResult[];
  filter: Set<string>;
  minLevel: number | null;
  scoreSort: boolean;
  onToggle: (key: string) => void;
  onMinLevel: (n: number | null) => void;
  onScoreSort: (v: boolean) => void;
  onEdit: () => void;
}) {
  const counts = new Map<string, number>();
  for (const r of results) {
    if (lens.type === "noul") {
      const b = lensBucket(lens, r);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    } else if (lens.type === "choice") {
      const b = lensBucket(lens, r);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    } else if (lens.type === "multi") {
      const keys = lensSelectedKeys(lens, r);
      if (!keys.length)
        counts.set("none", (counts.get("none") ?? 0) + 1);
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const chips: { key: string; label: string }[] =
    lens.type === "noul"
      ? [
          { key: "yes", label: "Yes" },
          { key: "unsure", label: "Unsure" },
          { key: "no", label: "No" },
        ]
      : lens.type === "choice" || lens.type === "multi"
        ? lens.options.map((o) => ({ key: o.key, label: o.label }))
        : [];
  if (lens.type === "multi") chips.push({ key: "none", label: "None" });

  return (
    <div className="space-y-1.5 border-b bg-muted/30 px-4 py-2.5">
      <div className="flex items-center gap-2">
        {lensIcon(lens.type, "size-4 text-muted-foreground")}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {lens.name}
        </h2>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="size-3.5" />
          Edit
        </Button>
      </div>
      <p
        className="line-clamp-2 text-[13px] text-muted-foreground"
        title={lens.question}
      >
        {lens.question}
      </p>
      {lens.type === "score" ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Min level:{" "}
                {minLevel === null
                  ? "Any"
                  : `≥ ${lens.levels[Math.round(minLevel)]?.label ?? ""}`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onMinLevel(null)}>
                Min level: Any
              </DropdownMenuItem>
              {lens.levels.map((lv, i) => (
                <DropdownMenuItem key={i} onSelect={() => onMinLevel(i)}>
                  Min level: ≥ {lv.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <ArrowDownWideNarrow />
                {scoreSort ? "Score" : "Newest"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onSelect={() => onScoreSort(false)}>
                Newest
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onScoreSort(true)}>
                Score
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : results.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <Chip
              key={c.key}
              label={c.label}
              count={counts.get(c.key) ?? 0}
              active={filter.has(c.key)}
              onClick={() => onToggle(c.key)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No links analyzed yet.
        </p>
      )}
    </div>
  );
}
