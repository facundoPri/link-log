import { ArrowDownWideNarrow, Ellipsis, Loader2, RotateCw } from "lucide-react";
import {
  IN_FLIGHT,
  lensBucket,
  lensSelectedKeys,
  type BrowserTab,
  type LensFilter,
  type LensRecord,
} from "@linklog/browser-protocol";
import type { Lens } from "../../types";
import { cn } from "../../lib/utils";
import { lensIcon } from "../Sidebar";
import { isUnreadable } from "./BrowserLensStatus";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function Chip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors",
        active ? "border-brand/40 bg-brand/10 text-brand" : "text-foreground hover:bg-accent",
      )}
    >
      {label}
      <span className="text-muted-foreground tabular">{count}</span>
    </button>
  );
}

export type LensProgress = { done: number; pending: number; failed: number; unreadable: number; total: number };

export function lensProgress(lens: Lens, tabs: BrowserTab[], results: Record<string, Record<string, LensRecord>>): LensProgress {
  const p: LensProgress = { done: 0, pending: 0, failed: 0, unreadable: 0, total: tabs.length };
  for (const tab of tabs) {
    const r = results[tab.tabInstanceId]?.[lens.id];
    if (r?.state === "done") p.done++;
    else if (r && IN_FLIGHT.includes(r.state)) p.pending++;
    else if (r?.state === "failed" || r?.state === "expired") p.failed++;
    else if (isUnreadable(tab, r)) p.unreadable++; // shown as "Unreadable" in the rows too
    else p.pending++;
  }
  return p;
}

/**
 * One row per active lens. AND across lenses, OR between options of one lens.
 * Filters narrow what is shown, never which tabs are evaluated.
 */
export function LensFilterBar({
  lenses,
  tabs,
  results,
  filters,
  sortLensId,
  onFilter,
  onSort,
  onRetryFailed,
  onReevaluate,
  onClean,
  onEdit,
  onDeactivate,
  jevReason,
}: {
  lenses: Lens[];
  tabs: BrowserTab[];
  results: Record<string, Record<string, LensRecord>>;
  filters: Record<string, LensFilter>;
  sortLensId: string | null;
  onFilter: (filter: LensFilter) => void;
  onSort: (lensId: string | null) => void;
  onRetryFailed: (lens: Lens) => void;
  onReevaluate: (lens: Lens) => void;
  onClean: (lens: Lens) => void;
  onEdit: (lens: Lens) => void;
  onDeactivate: (lens: Lens) => void;
  /** Why nothing can be evaluated now (Jev not configured), or null. */
  jevReason: string | null;
}) {
  return (
    <div className="divide-y border-b">
      {lenses.map((lens) => {
        const filter = filters[lens.id] ?? { lensId: lens.id, keys: [], minLevel: null };
        const counts = new Map<string, number>();
        for (const tab of tabs) {
          const r = results[tab.tabInstanceId]?.[lens.id];
          if (r?.state !== "done" || !r.answer) continue;
          const keys =
            lens.type === "multi"
              ? (() => {
                  const k = lensSelectedKeys(lens, { answer: r.answer });
                  return k.length ? k : ["none"];
                })()
              : [lensBucket(lens, { answer: r.answer })];
          for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        const chips =
          lens.type === "noul"
            ? [
                { key: "yes", label: "Yes" },
                { key: "unsure", label: "Unsure" },
                { key: "no", label: "No" },
              ]
            : lens.type === "score"
              ? []
              : [...lens.options.map((o) => ({ key: o.key, label: o.label })), ...(lens.type === "multi" ? [{ key: "none", label: "None" }] : [])];
        const progress = lensProgress(lens, tabs, results);
        const toggle = (key: string) =>
          onFilter({ ...filter, keys: filter.keys.includes(key) ? filter.keys.filter((k) => k !== key) : [...filter.keys, key] });
        return (
          <div key={lens.id} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2" data-lens-filter={lens.id}>
            <div className="flex min-w-0 items-center gap-1.5">
              {lensIcon(lens.type, "size-3.5 text-brand")}
              <span className="max-w-40 truncate text-[13px] font-medium">{lens.name}</span>
              <span className="inline-flex items-center gap-1 text-2xs tabular text-muted-foreground">
                {progress.pending > 0 && !jevReason && <Loader2 className="size-3 animate-spin" />}
                {progress.done}/{progress.total}
                {progress.unreadable > 0 && <span className="opacity-80">· {progress.unreadable} unreadable</span>}
              </span>
              {jevReason && <span className="text-2xs text-muted-foreground">{jevReason}</span>}
              {progress.failed > 0 && !jevReason && (
                <button
                  type="button"
                  onClick={() => onRetryFailed(lens)}
                  className="inline-flex h-5 items-center gap-1 rounded-md bg-destructive/10 px-1.5 text-2xs text-destructive hover:bg-destructive/15"
                >
                  <RotateCw className="size-3" />
                  Retry {progress.failed} failed
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <Chip key={c.key} label={c.label} count={counts.get(c.key) ?? 0} active={filter.keys.includes(c.key)} onClick={() => toggle(c.key)} />
              ))}
              {lens.type === "score" && (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-6 text-xs">
                        Min: {filter.minLevel === null ? "Any" : `≥ ${lens.levels[filter.minLevel]?.label ?? filter.minLevel}`}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem onSelect={() => onFilter({ ...filter, minLevel: null })}>Any level</DropdownMenuItem>
                      {lens.levels.map((lv, i) => (
                        <DropdownMenuItem key={i} onSelect={() => onFilter({ ...filter, minLevel: i })}>
                          ≥ {lv.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant={sortLensId === lens.id ? "secondary" : "ghost"}
                    size="sm"
                    className="h-6 text-xs"
                    aria-pressed={sortLensId === lens.id}
                    onClick={() => onSort(sortLensId === lens.id ? null : lens.id)}
                  >
                    <ArrowDownWideNarrow className="size-3.5" />
                    Sort by score
                  </Button>
                </>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label={`${lens.name} options`}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={!!jevReason} onClick={() => onReevaluate(lens)}>
                  Re-evaluate this window
                </DropdownMenuItem>
                {jevReason && (
                  <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">{jevReason}</DropdownMenuLabel>
                )}
                <DropdownMenuItem onClick={() => onEdit(lens)}>Edit lens…</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onClean(lens)}>Clean results…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onDeactivate(lens)}>Turn off</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
    </div>
  );
}
