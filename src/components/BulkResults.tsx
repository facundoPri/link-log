import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import type { Batch } from "../types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** A settled batch started from the selection surface that left links failed. */
export type BulkResult = {
  batchId: string;
  kind: Batch["kind"];
  total: number;
  failed: { linkId: string; title: string; reason: string }[];
};

const KIND_LABEL: Partial<Record<Batch["kind"], string>> = {
  autotag: "Auto-tag",
  extract: "Extract context",
  lens: "Lens",
};

export const resultTitle = (r: BulkResult) =>
  `${KIND_LABEL[r.kind] ?? "Batch"}: ${r.failed.length} of ${r.total} failed`;

export function BulkResultCard({
  result,
  onSelectFailed,
  onDismiss,
  className,
}: {
  result: BulkResult;
  onSelectFailed: () => void;
  onDismiss: () => void;
  className?: string;
}) {
  return (
    <section
      aria-label={`${KIND_LABEL[result.kind] ?? "Batch"} results`}
      className={cn(
        "w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover px-3 py-2 shadow-md animate-in fade-in slide-in-from-bottom-2 duration-200",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium tabular">{resultTitle(result)}</p>
        <Button size="xs" variant="outline" onClick={onSelectFailed}>
          Select failed
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss results" onClick={onDismiss}>
          <X className="size-3" />
        </Button>
      </div>
      <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto">
        {result.failed.map((f) => (
          <li key={f.linkId} className="text-2xs">
            <span className="block truncate font-medium">{f.title}</span>
            <span className="block truncate text-muted-foreground" title={f.reason}>
              {f.reason}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The narrow chip and the mobile bar have no room for the cards, so the same cards open from a trigger.
export function BulkResultsPopover({
  results,
  onSelectFailed,
  onDismiss,
  children,
}: {
  results: BulkResult[];
  onSelectFailed: (result: BulkResult) => void;
  onDismiss: (result: BulkResult) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="top" sideOffset={10} className="w-[min(26rem,calc(100vw-1.5rem))] space-y-1 p-1">
        {results.map((r) => (
          <BulkResultCard
            key={r.batchId}
            result={r}
            className="w-full max-w-none border-0 shadow-none animate-none"
            onSelectFailed={() => {
              setOpen(false);
              onSelectFailed(r);
            }}
            onDismiss={() => onDismiss(r)}
          />
        ))}
      </PopoverContent>
    </Popover>
  );
}
