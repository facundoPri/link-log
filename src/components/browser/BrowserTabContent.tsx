import { useState } from "react";
import { toast } from "sonner";
import { Copy, ExternalLink, FileWarning, Link2, Loader2, Lock, Moon, RotateCw } from "lucide-react";
import type { BrowserTab, Capture } from "@linklog/browser-protocol";
import { cn } from "../../lib/utils";
import { relativeTime } from "../../lib/time";
import { MarkdownView } from "../MarkdownView";
import { ACCESS_LABEL } from "./BrowserLensStatus";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type Read =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; capture: Capture }
  | { status: "error"; error: string };

const CONTENT_MODE = "linklog.contentMode";

function readMode(): "preview" | "markdown" {
  try {
    return localStorage.getItem(CONTENT_MODE) === "markdown" ? "markdown" : "preview";
  } catch {
    return "preview";
  }
}

/** Why the page can't be read, and the one thing that helps. */
function Unreadable({ tab, onAllowAccess, onFocus }: { tab: BrowserTab; onAllowAccess: () => void; onFocus: () => void }) {
  const access = ACCESS_LABEL[tab.content as Exclude<BrowserTab["content"], "available">];
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-5 text-center">
      <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {tab.content === "no-permission" ? (
          <Lock className="size-4" />
        ) : tab.content === "discarded" || tab.content === "frozen" ? (
          <Moon className="size-4" />
        ) : tab.content === "loading" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <FileWarning className="size-4" />
        )}
      </span>
      <p className="text-xs font-medium">{access.label}</p>
      <p className="max-w-64 text-xs text-muted-foreground">{access.hint}</p>
      {tab.content === "no-permission" ? (
        <Button size="sm" variant="outline" onClick={onAllowAccess}>
          Allow access
        </Button>
      ) : tab.content === "discarded" || tab.content === "frozen" ? (
        <Button size="sm" variant="outline" onClick={onFocus}>
          Go to tab
        </Button>
      ) : null}
    </div>
  );
}

/** The Content tab: the page as read locally, as rendered Markdown or source. */
export function ContentPanel({
  tab,
  state,
  onReload,
  onAllowAccess,
  onFocus,
}: {
  tab: BrowserTab;
  state: Read;
  onReload: () => void;
  onAllowAccess: () => void;
  onFocus: () => void;
}) {
  const [mode, setMode] = useState(readMode);
  const [expanded, setExpanded] = useState(false);
  if (tab.content !== "available") return <Unreadable tab={tab} onAllowAccess={onAllowAccess} onFocus={onFocus} />;
  if (state.status === "loading" || state.status === "idle")
    return (
      <div className="space-y-2" aria-label="Reading page">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
      </div>
    );
  if (state.status === "error")
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-5 text-center">
        <p className="text-xs text-destructive">{state.error}</p>
        <Button size="sm" variant="outline" onClick={onReload}>
          Try again
        </Button>
      </div>
    );
  const capture = state.capture;
  const markdown = capture.markdown;
  return (
    <div>
      {capture.completeness === "partial" && (
        <div role="status" className="mb-3 flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs">
          <span className="font-medium">Read partially</span>
          {capture.reasons
            .filter((r) => !/^Only content already loaded/.test(r))
            .map((r) => (
              <span key={r} className="text-muted-foreground">
                {r}
              </span>
            ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => {
            if (!v) return;
            setMode(v as "preview" | "markdown");
            try {
              localStorage.setItem(CONTENT_MODE, v);
            } catch {
              /* per-viewer convenience only */
            }
          }}
        >
          <ToggleGroupItem value="preview" aria-label="Preview">
            Preview
          </ToggleGroupItem>
          <ToggleGroupItem value="markdown" aria-label="Markdown">
            Markdown
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="ml-2 text-2xs text-muted-foreground tabular">
          {capture.chars.toLocaleString("en")} chars · read {relativeTime(capture.capturedAt)}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy markdown"
                onClick={() => void navigator.clipboard.writeText(markdown).then(() => toast("Markdown copied"))}
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy markdown</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Read page again" onClick={onReload}>
                <RotateCw className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Read again</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className={cn("relative mt-2", !expanded && "max-h-96 overflow-hidden")} data-capture-markdown>
        {mode === "markdown" ? (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">{markdown}</pre>
        ) : (
          <MarkdownView markdown={markdown} />
        )}
        {!expanded && markdown.length > 1200 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
      {!expanded && markdown.length > 1200 && (
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => setExpanded(true)}>
          Show more
        </Button>
      )}
    </div>
  );
}

/** The Links tab: links found in the page content, each savable to the library. */
export function LinksPanel({
  related,
  read,
  savedUrls,
  onSave,
}: {
  related: { url: string; label: string }[];
  read: boolean;
  savedUrls: Set<string>;
  onSave: (url: string) => Promise<unknown>;
}) {
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  if (!related.length)
    return (
      <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
        {read ? "No links found in the page content." : "Links appear once the page has been read."}
      </div>
    );
  return (
    <div className="space-y-1.5">
      <p className="mb-3 text-xs text-muted-foreground">Links found in the page content.</p>
      {related.map((item) => {
        const isSaved = savedUrls.has(item.url);
        return (
          <div key={item.url} className="flex items-center gap-2 rounded-md border p-2.5">
            <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{item.label}</p>
              <p className="truncate text-2xs text-muted-foreground">{item.url}</p>
            </div>
            <Button variant="outline" size="icon-sm" asChild>
              <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${item.label}`}>
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <Button
              size="sm"
              variant={isSaved ? "ghost" : "outline"}
              disabled={isSaved || savingUrl === item.url}
              onClick={async () => {
                setSavingUrl(item.url);
                try {
                  await onSave(item.url);
                } catch (e) {
                  toast.error((e as Error).message);
                } finally {
                  setSavingUrl(null);
                }
              }}
            >
              {savingUrl === item.url ? <Loader2 className="size-3.5 animate-spin" /> : isSaved ? "Saved" : "Save"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
