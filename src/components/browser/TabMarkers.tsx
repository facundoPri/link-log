import { FileWarning, Loader2, Lock, Moon, Pin } from "lucide-react";
import type { BrowserTab } from "@linklog/browser-protocol";
import { relativeTime } from "../../lib/time";
import { LOAD_IN_PROGRESS, LOAD_LABEL, SLEEP_DETAIL } from "../../browser/sleeping";
import { ACCESS_LABEL } from "./BrowserLensStatus";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Chrome's own pin, not Linklog's library-pinned groups. */
export function PinnedMarker({ className = "size-3.5" }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 text-muted-foreground" role="img" aria-label="Pinned tab">
          <Pin className={className} />
        </span>
      </TooltipTrigger>
      <TooltipContent>Pinned in Chrome. Organizing actions keep it in place.</TooltipContent>
    </Tooltip>
  );
}

/** The one badge for a tab whose content can't be read now, or that a Load content run is handling. */
export function ContentBadge({ tab }: { tab: BrowserTab }) {
  const load = tab.load;
  if (load && LOAD_IN_PROGRESS.includes(load.state))
    return (
      <Badge variant="outline" className="gap-1 font-normal text-muted-foreground" data-load-state={load.state}>
        {load.state === "queued" ? <Moon className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
        {LOAD_LABEL[load.state]}
      </Badge>
    );
  if (tab.content === "available") return null;
  const access = ACCESS_LABEL[tab.content];
  const failed = load?.state === "failed" || load?.state === "skipped" ? load : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={failed?.state === "failed" ? "gap-1 font-normal text-destructive" : "gap-1 font-normal text-muted-foreground"}
          data-content={tab.content}
        >
          {tab.content === "loading" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : tab.content === "sleeping" ? (
            <Moon className="size-3" />
          ) : tab.content === "no-permission" ? (
            <Lock className="size-3" />
          ) : (
            <FileWarning className="size-3" />
          )}
          {failed?.state === "failed" ? `${access.label} · ${LOAD_LABEL.failed}` : access.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 space-y-1 text-left">
        <div>{access.hint}</div>
        {tab.sleep && <div className="opacity-80">{SLEEP_DETAIL[tab.sleep]}</div>}
        {tab.capturedAt && <div className="opacity-80">Content captured {relativeTime(tab.capturedAt)} is still readable.</div>}
        {failed?.error && <div className="opacity-80">{failed.error}</div>}
        {load?.note && <div className="opacity-80">{load.note}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
