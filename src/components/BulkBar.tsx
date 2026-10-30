import { ChevronDown, MoreHorizontal, X } from "lucide-react";
import type { ActionState, BulkAction } from "../bulkActions";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BulkResultCard, type BulkResult } from "./BulkResults";

// The desktop selection surface: results of earlier runs stack above the bar, which exists only while links
// are selected. Narrow and mobile layouts keep SelectionBar.
export function BulkDock({
  selected,
  visibleCount,
  states,
  results,
  onInvoke,
  onSelectAll,
  onClear,
  onOpenPalette,
  onSelectFailed,
  onDismissResult,
}: {
  selected: number;
  visibleCount: number;
  states: ActionState[];
  results: BulkResult[];
  onInvoke: (action: BulkAction) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onOpenPalette: () => void;
  onSelectFailed: (result: BulkResult) => void;
  onDismissResult: (result: BulkResult) => void;
}) {
  if (!selected && !results.length) return null;
  const promoted = states.filter((s) => s.action.promoted);
  return (
    <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
      {results.map((r) => (
        <BulkResultCard
          key={r.batchId}
          result={r}
          onSelectFailed={() => onSelectFailed(r)}
          onDismiss={() => onDismissResult(r)}
        />
      ))}
      {selected > 0 && (
        <div
          aria-label="Selected link actions"
          className="selection-bar flex items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tabular">
                {selected} selected
                <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={onSelectAll}>Select all {visibleCount} visible</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onClear}>Clear selection</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-5" />
          {promoted.map((s, i) => {
            const Icon = s.action.icon;
            return (
              <Tooltip key={s.action.id}>
                <TooltipTrigger asChild>
                  <span className="block">
                    <Button
                      size="sm"
                      variant={i === 0 ? "default" : "ghost"}
                      disabled={s.disabled}
                      // The visible badge and key are not part of the name, so it stays "Auto-tag", "Lens", "Extract context".
                      aria-label={s.action.label}
                      aria-keyshortcuts={s.action.shortcut}
                      onClick={() => onInvoke(s.action)}
                    >
                      <Icon className="size-3.5" />
                      {s.action.label}
                      {s.badge && (
                        <span className="rounded bg-muted px-1 text-2xs tabular text-muted-foreground">{s.badge}</span>
                      )}
                      {s.action.shortcut && (
                        <Kbd className={i === 0 ? "bg-white/20 text-current" : ""}>{s.action.shortcut}</Kbd>
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                {s.reason && <TooltipContent>{s.reason}</TooltipContent>}
              </Tooltip>
            );
          })}
          <Button size="sm" variant="ghost" onClick={onOpenPalette}>
            <MoreHorizontal className="size-3.5" />
            More
            <Kbd>⌘K</Kbd>
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
