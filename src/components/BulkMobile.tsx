import { ArrowLeft, ChevronUp, CircleAlert, Loader2, Plus, X } from "lucide-react";
import type { Lens } from "../types";
import { plural, type ActionState, type BulkAction, type BulkProgress } from "../bulkActions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { progressText } from "./BulkBar";
import { BulkResultsPopover, resultTitle, type BulkResult } from "./BulkResults";
import { lensIcon } from "./Sidebar";

// Mobile bar: clear on the left, the count over a one-tap select-all (or the running job), and a large Actions
// button. With nothing selected it stays only to report the last run.
export function BulkMobileBar({
  selected,
  visibleCount,
  allVisibleSelected,
  progress,
  results,
  onSelectAll,
  onClear,
  onOpenDrawer,
  onSelectFailed,
  onDismissResult,
}: {
  selected: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  progress: BulkProgress | null;
  results: BulkResult[];
  onSelectAll: () => void;
  onClear: () => void;
  onOpenDrawer: () => void;
  onSelectFailed: (result: BulkResult) => void;
  onDismissResult: (result: BulkResult) => void;
}) {
  if (!selected && !progress && !results.length) return null;
  const last = results.at(-1);
  const running = progress && (
    <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span className="truncate tabular">{progressText(progress)}</span>
    </span>
  );
  return (
    <div
      role="toolbar"
      aria-label="Selected link actions"
      className="fixed right-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-3 z-40 flex min-h-16 items-center gap-1 rounded-[22px] border bg-popover/95 p-1.5 shadow-lg backdrop-blur-xl animate-in fade-in slide-in-from-bottom-3 duration-200"
    >
      {selected > 0 ? (
        <>
          <Button variant="ghost" size="icon" className="size-11 shrink-0 rounded-full" aria-label="Clear selection" onClick={onClear}>
            <X className="size-5" />
          </Button>
          {progress ? (
            <div className="min-w-0 flex-1 px-1 leading-tight">
              <div className="text-[16px] font-semibold tabular">{selected} selected</div>
              {running}
            </div>
          ) : (
            <button
              type="button"
              onClick={allVisibleSelected ? onClear : onSelectAll}
              className="min-h-12 min-w-0 flex-1 rounded-xl px-1 text-left leading-tight active:bg-muted"
            >
              <span className="block text-[16px] font-semibold tabular">{selected} selected</span>
              <span className="block truncate text-[12px] text-muted-foreground">
                {allVisibleSelected ? (
                  <>
                    All {visibleCount} selected · <span className="font-medium text-foreground underline underline-offset-2">Deselect all</span>
                  </>
                ) : (
                  <span className="font-medium text-foreground underline underline-offset-2">Select all {visibleCount}</span>
                )}
              </span>
            </button>
          )}
          <Button onClick={onOpenDrawer} className="h-12 shrink-0 gap-1.5 rounded-2xl px-5 text-[15px]">
            Actions <ChevronUp className="size-4" />
          </Button>
        </>
      ) : (
        <>
          <span className="grid size-11 shrink-0 place-items-center">
            {progress ? <Loader2 className="size-5 animate-spin" /> : <CircleAlert className="size-5 text-amber-600" />}
          </span>
          <p className="min-w-0 flex-1 truncate text-[14px] font-medium tabular">
            {progress ? progressText(progress) : resultTitle(last!)}
          </p>
          {results.length > 0 && (
            <BulkResultsPopover results={results} onSelectFailed={onSelectFailed} onDismiss={onDismissResult}>
              <Button variant="ghost" className="h-11 shrink-0 rounded-2xl px-4 text-[14px]">
                Details
              </Button>
            </BulkResultsPopover>
          )}
        </>
      )}
    </div>
  );
}

// Mobile drawer: thumb-sized tiles read from the registry, the destructive actions in their own full-width slot, and
// pickers replacing the tiles in place.
export function BulkDrawer({
  open,
  onOpenChange,
  page,
  onPage,
  selected,
  visibleCount,
  allVisibleSelected,
  states,
  lenses,
  onInvoke,
  onSelectAll,
  onNewLens,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The picker action whose choices replace the tiles, or null. */
  page: BulkAction | null;
  onPage: (action: BulkAction | null) => void;
  selected: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  states: ActionState[];
  lenses: Lens[];
  onInvoke: (action: BulkAction, detail?: string) => void;
  onSelectAll: () => void;
  onNewLens: () => void;
}) {
  const tiles = states.filter((s) => s.action.group !== "Danger");
  const danger = states.filter((s) => s.action.group === "Danger");
  const partial = tiles.filter((s) => s.badge);
  const skippedIds = new Set(partial.flatMap((s) => s.availability.skipped.map((x) => x.link.id)));
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="max-h-[85dvh] gap-0 rounded-t-2xl px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <div className="mx-auto mb-1 h-1.5 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
        <SheetDescription className="sr-only">Actions for the selected links</SheetDescription>
        <div className="mb-2 flex min-h-11 shrink-0 items-center gap-1">
          {page && (
            <Button variant="ghost" size="icon" className="-ml-2 size-11" aria-label="Back to actions" onClick={() => onPage(null)}>
              <ArrowLeft className="size-5" />
            </Button>
          )}
          <SheetTitle className="min-w-0 flex-1 truncate text-[15px] tabular">
            {page ? `${page.label} on ${selected} ${plural(selected)}` : `${selected} selected`}
          </SheetTitle>
          {!page && !allVisibleSelected && (
            <Button variant="ghost" className="-mr-2 h-11 px-3 text-[14px]" onClick={onSelectAll}>
              Select all {visibleCount}
            </Button>
          )}
        </div>
        {page ? (
          <div className="flex min-h-0 flex-col overflow-y-auto">
            {lenses.map((lens) => (
              <button
                key={lens.id}
                type="button"
                className="flex min-h-14 items-center gap-3 border-b px-1 text-left active:bg-muted"
                onClick={() => onInvoke(page, lens.id)}
              >
                {lensIcon(lens.type, "size-5 shrink-0")}
                <span className="min-w-0">
                  <span className="block truncate text-[15px]">{lens.name}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">{lens.question}</span>
                </span>
              </button>
            ))}
            <button type="button" className="flex min-h-14 items-center gap-3 px-1 text-left text-[15px] active:bg-muted" onClick={onNewLens}>
              <Plus className="size-5 shrink-0" />
              New lens…
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              {tiles.map((s, i) => {
                const Icon = s.action.icon;
                return (
                  <button
                    key={s.action.id}
                    type="button"
                    // Stays tappable when blocked so the tap can say why, as a toast.
                    aria-disabled={s.disabled || undefined}
                    // The last tile takes the rest of its row so the grid has no hole.
                    style={i === tiles.length - 1 ? { gridColumn: `span ${4 - (i % 4)}` } : undefined}
                    onClick={() => onInvoke(s.action)}
                    className={cn(
                      "relative flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl bg-muted/60 px-1 text-center text-[12px] leading-tight font-medium active:bg-muted",
                      s.disabled && "opacity-40",
                    )}
                  >
                    <Icon className="size-5" />
                    <span>{s.action.tileLabel ?? s.action.label}</span>
                    {s.badge && (
                      <span className="absolute top-1.5 right-1.5 rounded-full bg-background px-1.5 text-2xs tabular text-muted-foreground">
                        {s.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            {partial.length > 0 && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                Numbers show how many of the {selected} selected {plural(selected)} each action can run on.{" "}
                {skippedIds.size} {skippedIds.size === 1 ? "is" : "are"} skipped by {partial.map((s) => s.action.label).join(" and ")}:{" "}
                {partial[0]!.availability.skipped[0]!.reason.toLowerCase()}.
              </p>
            )}
            {danger.map((s) => {
              const Icon = s.action.icon;
              return (
                <Button
                  key={s.action.id}
                  variant="outline"
                  aria-disabled={s.disabled || undefined}
                  onClick={() => onInvoke(s.action)}
                  className={cn("mt-3 h-12 w-full rounded-xl border-destructive/40 text-destructive hover:text-destructive", s.disabled && "opacity-40")}
                >
                  <Icon className="size-4" />
                  {s.action.barLabel?.(s.availability.eligible.length) ?? s.action.label}
                </Button>
              );
            })}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
