import { X } from "lucide-react";
import type { Batch } from "../types";
import { Button } from "@/components/ui/button";

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

export function BulkResultCard({
  result,
  onSelectFailed,
  onDismiss,
}: {
  result: BulkResult;
  onSelectFailed: () => void;
  onDismiss: () => void;
}) {
  const n = result.failed.length;
  return (
    <section
      aria-label={`${KIND_LABEL[result.kind] ?? "Batch"} results`}
      className="w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border bg-popover px-3 py-2 shadow-md animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium tabular">
          {KIND_LABEL[result.kind] ?? "Batch"}: {n} of {result.total} failed
        </p>
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
