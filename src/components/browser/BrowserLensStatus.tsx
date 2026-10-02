import { Loader2, RotateCw } from "lucide-react";
import { IN_FLIGHT, type BrowserTab, type LensRecord } from "@linklog/browser-protocol";
import type { Lens, LensResult } from "../../types";
import { LensVerdict } from "../LensVerdict";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Row badges and hints for tabs whose content can't be read right now. */
export const ACCESS_LABEL: Record<Exclude<BrowserTab["content"], "available">, { label: string; hint: string }> = {
  loading: { label: "Loading", hint: "Lenses run once the page finishes loading." },
  restricted: { label: "Can't read", hint: "Chrome doesn't let extensions read this page (browser, extension or store page)." },
  "no-permission": { label: "No access", hint: "Allow page content access so lenses can read this tab." },
  discarded: { label: "Not loaded", hint: "Chrome unloaded this tab to save memory. Open it to load its content." },
  frozen: { label: "Frozen", hint: "Chrome froze this background tab. Open it to read its content." },
};

/** The library verdict component takes a stored LensResult; a browser record carries the same answer. */
function asResult(lens: Lens, record: LensRecord): LensResult {
  return {
    lens_id: lens.id,
    answer: record.answer!,
    lens_version: lens.version,
    content_version: 0,
    model: record.model ?? "",
    evaluated_at: record.evaluatedAt ?? "",
    batch_id: record.batchId ?? "",
  };
}

/**
 * Whether a lens can't read this tab: the extension gave up on it ("unavailable") or,
 * with no result yet, the tab itself is unreadable. Counted as "unreadable" in the lens bar.
 */
export function isUnreadable(tab: BrowserTab, record: LensRecord | undefined) {
  if (record?.state === "unavailable") return true;
  return (!record || record.state === "missing") && tab.content !== "available" && tab.content !== "loading";
}

const quiet = "inline-flex items-center gap-1 text-muted-foreground";
const action =
  "inline-flex items-center gap-0.5 rounded px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground";

/**
 * One lens's state for one tab: verdict, progress, or a state that is never an answer
 * (failed, expired, unreadable) with its reason and a way forward. Shared by the tab
 * rows and the inspector.
 */
export function BrowserLensStatus({
  lens,
  record,
  tab,
  size = "sm",
  onRetry,
  onMetadata,
}: {
  lens: Lens;
  record: LensRecord | undefined;
  tab: BrowserTab;
  size?: "sm" | "md";
  onRetry: () => void;
  onMetadata: () => void;
}) {
  if (isUnreadable(tab, record)) {
    const reason =
      record?.error ?? (tab.content !== "available" && tab.content !== "loading" ? ACCESS_LABEL[tab.content].hint : "The page could not be read.");
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default text-muted-foreground">Unreadable</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 text-left">{reason}</TooltipContent>
        </Tooltip>
        <button type="button" className={action} aria-label={`Use title for ${lens.name}`} onClick={onMetadata}>
          Use title
        </button>
        {record?.state === "unavailable" && tab.content === "available" && (
          <button type="button" aria-label={`Retry ${lens.name}`} className={action} onClick={onRetry}>
            <RotateCw className="size-3" />
            Retry
          </button>
        )}
      </>
    );
  }
  if (!record || record.state === "missing")
    return (
      <span className={quiet}>
        <Loader2 className="size-3 animate-spin" />
        Waiting
      </span>
    );
  if (IN_FLIGHT.includes(record.state))
    return (
      <span className={quiet}>
        <Loader2 className="size-3 animate-spin" />
        {record.state === "running" ? "Evaluating" : "Queued"}
      </span>
    );
  if (record.state === "done" && record.answer) {
    const metadata = record.capture?.source === "metadata";
    const partial = record.capture?.completeness === "partial";
    const reasons = record.capture?.reasons.filter((r) => !/^Only content already loaded/.test(r)) ?? [];
    return (
      <>
        <LensVerdict lens={lens} result={asResult(lens, record)} size={size} />
        {(partial || metadata) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default text-amber-600 dark:text-amber-400">{metadata ? "title only" : "partial"}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-64 text-left">
              {metadata ? "Evaluated with the title and URL only." : "Only part of the page could be read."}
              {reasons.map((r) => (
                <div key={r} className="opacity-80">
                  {r}
                </div>
              ))}
            </TooltipContent>
          </Tooltip>
        )}
      </>
    );
  }
  const failed = record.state === "failed";
  const status = <span className={failed ? "cursor-default text-destructive" : "cursor-default text-muted-foreground"}>{failed ? "Failed" : "Expired"}</span>;
  return (
    <>
      {record.error ? (
        <Tooltip>
          <TooltipTrigger asChild>{status}</TooltipTrigger>
          <TooltipContent className="max-w-64 text-left">{record.error}</TooltipContent>
        </Tooltip>
      ) : (
        status
      )}
      <button type="button" aria-label={`Retry ${lens.name}`} className={action} onClick={onRetry}>
        <RotateCw className="size-3" />
        Retry
      </button>
    </>
  );
}
