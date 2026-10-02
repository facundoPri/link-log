import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  Globe,
  Loader2,
  RotateCw,
  Sparkles,
  Telescope,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api } from "../api";
import type { Library } from "../types";
import type { Batch, Job, Lens, OcrUsage, UsageTotals } from "../types";
import { LensVerdict } from "./LensVerdict";
import { jobProgress } from "../failures";
import { relativeTime } from "../lib/time";
import { usd, tokens, duration } from "../lib/format";
import { cn } from "../lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
function ocrCost(ocr: OcrUsage) {
  if (ocr.usd === null) return "cost unknown";
  return `${usd(ocr.usd)}${ocr.unknown_cost_calls ? " known subtotal" : ""}`;
}

function batchUsageTip(b: Batch) {
  if (!b.usage) return null;
  const parts: string[] = [];
  if (b.usage.input_tokens || b.usage.output_tokens)
    parts.push(
      `${tokens(b.usage.input_tokens)} input · ${tokens(b.usage.output_tokens)} output tokens`,
    );
  if (b.usage.browser_ms)
    parts.push(`${duration(b.usage.browser_ms)} browser`);
  if (b.usage.model && !b.usage.ocr) parts.push(b.usage.model);
  if (b.usage.ocr) {
    const ocr = b.usage.ocr;
    parts.push(`OCR: ${ocr.images} ${ocr.images === 1 ? "image/preview" : "images/previews"} · ${tokens(ocr.input_tokens)} input · ${tokens(ocr.output_tokens)} output tokens · ${ocrCost(ocr)} · ${ocr.model ?? "model unknown"}`);
  }
  if (b.usage.unknown_cost_calls) parts.push(`${b.usage.unknown_cost_calls} costs unknown; displayed USD is a known subtotal`);
  return parts.join(" · ") || null;
}

function kindIcon(kind: Batch["kind"] | "query") {
  return kind === "extract" || kind === "preview" ? (
    <FileText className="size-4 text-muted-foreground" />
  ) : kind === "autotag" || kind === "browser-autogroup" ? (
    <Sparkles className="size-4 text-muted-foreground" />
  ) : kind === "browser-lens" ? (
    <Globe className="size-4 text-muted-foreground" />
  ) : (
    <Telescope className="size-4 text-muted-foreground" />
  );
}

function configLens(b: Batch): Lens | undefined {
  try {
    return (JSON.parse(b.config) as { lens?: Lens }).lens;
  } catch {
    return undefined;
  }
}

function label(b: Batch) {
  if (b.kind === "extract") return "Extract context";
  if (b.kind === "preview") return "Fetch preview";
  if (b.kind === "autotag") return "Auto-tag";
  if ((b.kind as string) === "query") return "Ask (legacy)";
  if (b.kind === "browser-autogroup") return "Autogroup · open tabs";
  if (b.kind === "browser-lens") return `Browser lens: ${configLens(b)?.name ?? ""}`;
  const name = configLens(b)?.name ?? "";
  return `Lens: ${name}`;
}

// Jev is never retried automatically once called; failed auto-tag and lens jobs are retried from here.
const retriable = (b: Batch) => b.kind === "autotag" || b.kind === "lens";
async function retryFailed(id: string, ids: string[] | undefined, onLibrary: (l: Library) => void) {
  try {
    const data = await api<Library & { skipped?: string[] }>(`/batches/${id}/retry`, "POST", ids ? { ids } : {});
    onLibrary(data);
    toast(data.skipped?.length ? `Retrying; ${data.skipped.length} without content were skipped` : "Retrying");
  } catch (e) {
    toast.error((e as Error).message);
  }
}

// One job, whether queued, waiting or running. Cancelling an extraction also cancels the jobs waiting for it.
async function cancelJob(job: Job, onLibrary: (l: Library) => void) {
  try {
    const data = await api<Library & { dependents?: number }>(`/jobs/${job.id}`, "DELETE");
    onLibrary(data);
    toast(data.dependents ? `Cancelled, and ${data.dependents} waiting for that extraction` : "Cancelled");
  } catch (e) {
    toast.error((e as Error).message);
  }
}

function BatchJobs({ batch, onLibrary }: { batch: Batch; onLibrary: (l: Library) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ jobs: Job[] }>(`/batches/${batch.id}`)
        .then((r) => {
          if (alive) {
            setJobs(r.jobs);
            setError("");
          }
        })
        .catch((e) => alive && setError(e.message));
    void load();
    const timer = batch.active ? setInterval(load, 1600) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [batch.id, batch.active, reload]);
  const lens = configLens(batch);
  return (
    <div className="space-y-1 px-2 pb-2">
      {error && <p className="text-xs text-destructive">{error}</p>}
      {jobs.map((j) => {
        const result = j.result ? JSON.parse(j.result) : null;
        const answer = result?.answer ?? result?.answers?.lens;
        const progress = jobProgress(j);
        return (
          <div key={j.id} className="rounded-md px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs">
                {j.title}
              </span>
              {j.usage && !(batch.kind === "extract" && j.usage.ocr) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="shrink-0 text-2xs tabular text-muted-foreground">
                      {[
                        j.usage.input_tokens || j.usage.output_tokens
                          ? `${tokens(j.usage.input_tokens + j.usage.output_tokens)} tok`
                          : null,
                        j.usage.usd !== null ? usd(j.usage.usd) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {[
                      j.usage.model,
                      j.usage.duration_ms
                        ? duration(j.usage.duration_ms)
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </TooltipContent>
                </Tooltip>
              )}
              {answer && lens ? (
                <LensVerdict
                  lens={lens}
                  result={{
                    lens_id: lens.id,
                    answer,
                    lens_version: lens.version,
                    content_version: 0,
                    model: result?.model ?? "",
                    evaluated_at: "",
                    batch_id: batch.id,
                  }}
                  size="sm"
                />
              ) : answer && !lens ? (
                <span className="text-xs text-muted-foreground">Done</span>
              ) : j.status === "done" ? (
                <Check className="size-3.5 text-muted-foreground" />
              ) : j.step === "Cancelled" ? (
                <span className="text-xs text-muted-foreground">
                  Cancelled
                </span>
              ) : j.status === "failed" ? (
                <CircleAlert className="size-3.5 text-destructive" />
              ) : j.status === "waiting" ? (
                <Clock className="size-3.5 text-muted-foreground" />
              ) : (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              )}
              {["queued", "running", "waiting"].includes(j.status) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="-my-0.5 shrink-0"
                      aria-label="Cancel"
                      onClick={() => void cancelJob(j, (l) => (onLibrary(l), setReload((n) => n + 1)))}
                    >
                      <X className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {batch.kind === "extract" ? "Cancel (also cancels what waits for it)" : "Cancel"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {batch.kind === "extract" && j.usage?.ocr && (
              <div className="mt-1 text-2xs text-muted-foreground">
                <div className="flex flex-wrap items-baseline justify-between gap-x-2 tabular">
                  <span>OCR · {j.usage.ocr.images} {j.usage.ocr.images === 1 ? "image/preview" : "images/previews"}</span>
                  <span>{tokens(j.usage.ocr.input_tokens + j.usage.ocr.output_tokens)} tok · {ocrCost(j.usage.ocr)}</span>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <p className="truncate">Model: {j.usage.ocr.model ?? "unknown"}</p>
                  </TooltipTrigger>
                  <TooltipContent>
                    {`${j.usage.ocr.model ?? "Model unknown"} · ${tokens(j.usage.ocr.input_tokens)} input · ${tokens(j.usage.ocr.output_tokens)} output tokens${j.usage.ocr.unknown_cost_calls ? ` · ${j.usage.ocr.unknown_cost_calls} OCR costs unknown` : ""}`}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
            {j.error && (
              <div className="mt-0.5 flex items-start gap-2">
                <p
                  className={cn(
                    "min-w-0 flex-1 text-2xs",
                    j.step === "Cancelled"
                      ? "text-muted-foreground"
                      : "text-destructive",
                  )}
                >
                  {j.error}
                </p>
                {retriable(batch) && j.status === "failed" && j.step !== "Cancelled" && j.link_id && (
                  <Button variant="ghost" size="xs" className="-my-0.5 shrink-0" onClick={() => void retryFailed(batch.id, [j.link_id!], onLibrary)}>
                    Retry
                  </Button>
                )}
              </div>
            )}
            {j.step === "Used the preview" && (
              <p className="mt-0.5 text-2xs text-muted-foreground">Used the preview as content instead.</p>
            )}
            {!j.error && progress.step && (
              <p className="mt-0.5 text-2xs text-muted-foreground">{progress.step}</p>
            )}
            {progress.note && (
              <p className="mt-0.5 text-2xs text-muted-foreground">{progress.note}</p>
            )}
          </div>
        );
      })}
      {!jobs.length && !error && (
        <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>
      )}
    </div>
  );
}

async function cancelBatch(id: string, onLibrary: (l: Library) => void) {
  try {
    const data = await api<Library & { cancelled?: number; dependents?: number }>(
      `/batches/${id}`,
      "DELETE",
    );
    onLibrary(data);
    toast(
      data.cancelled
        ? `Cancelled ${data.cancelled} queued ${data.cancelled === 1 ? "job" : "jobs"}${data.dependents ? `, and ${data.dependents} waiting for that extraction` : ""}`
        : "Nothing left to cancel",
    );
  } catch (e) {
    toast.error((e as Error).message);
  }
}

export function ActivitySheet({
  open,
  batches,
  onOpenChange,
  onLibrary,
}: {
  open: boolean;
  batches: Batch[];
  onOpenChange: (open: boolean) => void;
  onLibrary: (library: Library) => void;
}) {
  const [totals, setTotals] = useState<UsageTotals | null>(null);
  const hadActive = useRef(false);
  const activeCount = batches.filter((b) => b.active).length;
  useEffect(() => {
    if (!open) {
      hadActive.current = false;
      return;
    }
    const justFinished = hadActive.current && !activeCount;
    hadActive.current = !!activeCount;
    if (!justFinished && totals) return;
    api<{ totals: UsageTotals }>("/usage")
      .then((r) => {
        setTotals(r.totals);
      })
      .catch(() => {});
  }, [open, activeCount]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = [...batches].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Activity</SheetTitle>
          <SheetDescription>
            Extraction, auto-tagging, lenses and browser evaluations.
          </SheetDescription>
        </SheetHeader>
        {totals && (
          <div className="flex items-center gap-2 border-b px-4 pb-3">
            <div className="min-w-0 flex-1">
              <div className="text-lg font-semibold tabular">
                {totals.usd !== null ? usd(totals.usd) : "—"}{totals.unknown_cost_calls > 0 && <span className="ml-1 text-2xs font-normal text-muted-foreground">known subtotal</span>}
              </div>
              <p className="truncate text-2xs text-muted-foreground">
                {tokens(totals.input_tokens + totals.output_tokens)} tokens
                {totals.browser_ms
                  ? ` · ${duration(totals.browser_ms)} browser`
                  : ""}{" "}
                · {totals.calls} calls
                {totals.unknown_cost_calls > 0 ? ` · ${totals.unknown_cost_calls} costs unknown` : ""}
              </p>
            </div>
          </div>
        )}
        <div className="flex-1 space-y-0.5 overflow-y-auto px-4 pb-4">
          {sorted.map((b) => (
            <Collapsible key={b.id}>
              <div className="rounded-lg border">
                <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2 text-left">
                  {kindIcon(b.kind)}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {label(b)}
                    </span>
                    <span className="block text-2xs text-muted-foreground">
                      {relativeTime(b.created_at)}
                    </span>
                  </span>
                  {b.active ? (
                    <span className="flex items-center gap-1.5 text-2xs text-muted-foreground tabular">
                      <Loader2 className="size-3 animate-spin" />
                      {b.done + b.failed + b.cancelled}/{b.total}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Cancel batch"
                        onClick={(e) => {
                          e.stopPropagation();
                          void cancelBatch(b.id, onLibrary);
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </span>
                  ) : b.failed ? (
                    <span className="flex items-center gap-1">
                      <Badge variant="outline" className="gap-1">
                        <CircleAlert className="size-3" />
                        {b.failed} failed
                      </Badge>
                      {retriable(b) && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Retry failed"
                              onClick={(e) => {
                                e.stopPropagation();
                                void retryFailed(b.id, undefined, onLibrary);
                              }}
                            >
                              <RotateCw className="size-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Retry failed</TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  ) : b.cancelled === b.total ? (
                    <span className="text-2xs text-muted-foreground">Cancelled</span>
                  ) : (
                    <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                      <Check className="size-3" />
                      Done
                    </span>
                  )}
                  {b.usage && batchUsageTip(b) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="shrink-0 text-2xs tabular text-muted-foreground">
                          {b.usage.usd !== null ? usd(b.usage.usd) : "—"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{batchUsageTip(b)}</TooltipContent>
                    </Tooltip>
                  )}
                  <ChevronRight
                    className={cn(
                      "size-3.5 text-muted-foreground transition-transform",
                      "group-data-[state=open]:rotate-90",
                    )}
                  />
                </CollapsibleTrigger>
                {!!b.active && (
                  <Progress
                    value={((b.done + b.failed + b.cancelled) / Math.max(b.total, 1)) * 100}
                    className="mx-3 h-1 w-auto"
                  />
                )}
                <CollapsibleContent>
                  <BatchJobs batch={b} onLibrary={onLibrary} />
                </CollapsibleContent>
              </div>
            </Collapsible>
          ))}
          {!sorted.length && (
            <p className="px-2 py-8 text-center text-[13px] text-muted-foreground">
              Nothing yet. Select links to extract context, auto-tag or apply a
              lens.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
