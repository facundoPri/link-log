import { useRef, useState } from "react";
import {
  BookmarkCheck,
  Ellipsis,
  FileWarning,
  Globe,
  Loader2,
  Lock,
  Moon,
  RotateCw,
  SquareArrowOutUpRight,
  Volume2,
} from "lucide-react";
import type { BrowserGroup, BrowserTab, LensRecord, TabPreview } from "@linklog/browser-protocol";
import type { Lens, Link, Tag } from "../../types";
import { cn } from "../../lib/utils";
import { relativeTime } from "../../lib/time";
import { youtubeId } from "../../lib/youtube";
import { lensIcon } from "../Sidebar";
import { LensVerdict } from "../LensVerdict";
import { TagChip } from "../TagChip";
import { GROUP_STYLE, groupTitle } from "./groups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const ACCESS_LABEL: Record<Exclude<BrowserTab["content"], "available">, { label: string; hint: string }> = {
  loading: { label: "Loading", hint: "Lenses run once the page finishes loading." },
  restricted: { label: "Can't read", hint: "Chrome doesn't let extensions read this page (browser, extension or store page)." },
  "no-permission": { label: "No access", hint: "Allow page content access so lenses can read this tab." },
  discarded: { label: "Not loaded", hint: "Chrome unloaded this tab to save memory. Open it to load its content." },
  frozen: { label: "Frozen", hint: "Chrome froze this background tab. Open it to read its content." },
};

function pathOf(url: string) {
  try {
    const u = new URL(url);
    return { host: u.hostname.replace(/^www\./, ""), rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}` };
  } catch {
    return { host: url, rest: "" };
  }
}

function LensCell({
  lens,
  record,
  tab,
  named,
  onRetry,
  onMetadata,
}: {
  lens: Lens;
  record: LensRecord | undefined;
  tab: BrowserTab;
  named: boolean;
  onRetry: () => void;
  onMetadata: () => void;
}) {
  // Flat, borderless cell: the lens icon (and its name when several lenses are on) + the verdict.
  const shell = (children: React.ReactNode) => (
    <span
      className="inline-flex h-5 items-center gap-1 text-2xs"
      aria-label={lens.name}
      data-lens-cell={lens.id}
      onClick={(e) => e.stopPropagation()}
    >
      {lensIcon(lens.type, "size-3 shrink-0 text-muted-foreground")}
      {named && <span className="max-w-24 truncate text-muted-foreground">{lens.name}</span>}
      {children}
    </span>
  );
  const quiet = (text: string, spin = false) => (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      {spin && <Loader2 className="size-3 animate-spin" />}
      {text}
    </span>
  );
  if (!record || record.state === "missing") {
    if (tab.content !== "available" && tab.content !== "loading")
      return shell(
        <button type="button" className="text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground" onClick={onMetadata}>
          Use title
        </button>,
      );
    return shell(quiet("Waiting", true));
  }
  if (record.state === "submitting" || record.state === "queued" || record.state === "running")
    return shell(quiet(record.state === "running" ? "Evaluating" : "Queued", true));
  if (record.state === "done" && record.answer) {
    const partial = record.capture?.completeness === "partial";
    const metadata = record.capture?.source === "metadata";
    const reasons = record.capture?.reasons.filter((r) => !/^Only content already loaded/.test(r)) ?? [];
    return shell(
      <>
        <LensVerdict
          lens={lens}
          result={{
            lens_id: lens.id,
            answer: record.answer,
            lens_version: lens.version,
            content_version: 0,
            model: record.model ?? "",
            evaluated_at: record.evaluatedAt ?? "",
            batch_id: record.batchId ?? "",
          }}
          size="sm"
        />
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
      </>,
    );
  }
  const failed = record.state === "failed";
  const text = record.state === "expired" ? "Expired" : record.state === "unavailable" ? "Unreadable" : "Failed";
  const status = <span className={failed ? "cursor-default text-destructive" : "text-muted-foreground"}>{text}</span>;
  return shell(
    <>
      {failed && record.error ? (
        <Tooltip>
          <TooltipTrigger asChild>{status}</TooltipTrigger>
          <TooltipContent className="max-w-64 text-left">{record.error}</TooltipContent>
        </Tooltip>
      ) : (
        status
      )}
      <button
        type="button"
        aria-label={`Retry ${lens.name}`}
        className="inline-flex items-center gap-0.5 rounded px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onRetry}
      >
        <RotateCw className="size-3" />
        Retry
      </button>
    </>,
  );
}

export function TabRow({
  tab,
  group,
  saved,
  preview,
  domain,
  lenses,
  records,
  picked,
  active,
  stale,
  onActivate,
  onPicked,
  onFocus,
  onToggleGroup,
  onDomainFilter,
  onRetry,
  onMetadata,
  onSave,
  onClose,
  onMove,
  onUngroup,
  onCopy,
}: {
  tab: BrowserTab;
  group: BrowserGroup | undefined;
  saved: Link | undefined;
  preview: TabPreview | undefined;
  domain: string;
  lenses: Lens[];
  records: Record<string, LensRecord> | undefined;
  picked: boolean;
  active: boolean;
  stale: boolean;
  onActivate: () => void;
  onPicked: (checked: boolean, shift: boolean) => void;
  onFocus: () => void;
  onToggleGroup: (groupId: number) => void;
  onDomainFilter: (domain: string) => void;
  onRetry: (lens: Lens) => void;
  onMetadata: (lens: Lens) => void;
  onSave: () => void;
  onClose: () => void;
  onMove: () => void;
  onUngroup: () => void;
  onCopy: () => void;
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const lastShift = useRef(false);
  const { host, rest } = pathOf(tab.url);
  const access = tab.content === "available" ? null : ACCESS_LABEL[tab.content];
  const readAt = Object.values(records ?? {})
    .map((r) => r.capture?.capturedAt)
    .filter((t): t is string => !!t)
    .sort()
    .at(-1);
  // Only unambiguous states (e.g. a PR's "Merged") earn a badge; other facts stay evidence.
  const facts = (Object.values(records ?? {}).find((r) => r.capture?.facts.length)?.capture?.facts ?? []).filter((f) =>
    f.key.endsWith(".state"),
  );
  const yt = youtubeId(tab.url);
  const image = preview?.image && !imgFailed ? preview.image : yt ? `https://i.ytimg.com/vi/${yt}/mqdefault.jpg` : null;
  const favicon = tab.favIconUrl && !faviconFailed ? (
    <img src={tab.favIconUrl} alt="" className="size-5" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} />
  ) : (
    <Globe className="size-5" />
  );
  return (
    <article
      className={cn("group flex cursor-default items-start gap-3 px-4 py-3 hover:bg-accent/60", active && "bg-accent", stale && "opacity-60")}
      data-tab-id={tab.tabId}
      aria-current={active || undefined}
      onClick={onActivate}
      onDoubleClick={onFocus}
    >
      <Checkbox
        aria-label={`Select ${tab.title}`}
        checked={picked}
        onCheckedChange={(c) => onPicked(c === true, lastShift.current)}
        onClickCapture={(e) => {
          lastShift.current = e.shiftKey;
        }}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "mt-1 transition-opacity",
          !picked && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      />
      <div className="relative h-12 w-[72px] shrink-0 rounded-md bg-muted ring-1 ring-black/10">
        <div className="h-full w-full overflow-hidden rounded-md">
          {image ? (
            <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" onError={() => setImgFailed(true)} />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">{favicon}</div>
          )}
        </div>
        {tab.active && <span className="absolute -right-1 -top-1 size-2.5 rounded-full bg-brand ring-2 ring-background" aria-label="Active tab" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-medium leading-5">
          <span className="truncate">{tab.title || tab.url}</span>
          {tab.audible && <Volume2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="Playing audio" />}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {preview?.description || (
            <>
              {host}
              <span className="opacity-70">{rest}</span>
            </>
          )}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {domain && (
            <button
              type="button"
              aria-label={`Filter by ${domain}`}
              className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onDomainFilter(domain);
              }}
            >
              {tab.favIconUrl && !faviconFailed ? (
                <img src={tab.favIconUrl} alt="" className="size-3" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} />
              ) : (
                <Globe className="size-3" />
              )}
              {domain}
            </button>
          )}
          {group && (
            <button
              type="button"
              className="inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium transition-opacity hover:opacity-80"
              style={{ background: GROUP_STYLE[group.color].bg, color: GROUP_STYLE[group.color].fg }}
              onClick={(e) => {
                e.stopPropagation();
                onToggleGroup(group.groupId);
              }}
            >
              <span className="size-1.5 rounded-full" style={{ background: GROUP_STYLE[group.color].dot }} />
              {groupTitle(group.title)}
            </button>
          )}
          {saved && (
            <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
              <BookmarkCheck className="size-3" />
              Saved
            </Badge>
          )}
          {saved?.tags.map((tag: Tag) => <TagChip key={tag.id} tag={tag} />)}
          {access && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                  {tab.content === "loading" ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : tab.content === "discarded" || tab.content === "frozen" ? (
                    <Moon className="size-3" />
                  ) : tab.content === "no-permission" ? (
                    <Lock className="size-3" />
                  ) : (
                    <FileWarning className="size-3" />
                  )}
                  {access.label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{access.hint}</TooltipContent>
            </Tooltip>
          )}
          {facts.map((f) => (
            <Badge key={f.key} variant="secondary" className="font-normal" aria-label={`${f.label}: ${f.value}`}>
              {f.value}
            </Badge>
          ))}
          {lenses.map((lens) => (
            <LensCell
              key={lens.id}
              lens={lens}
              record={records?.[lens.id]}
              tab={tab}
              named={lenses.length > 1}
              onRetry={() => onRetry(lens)}
              onMetadata={() => onMetadata(lens)}
            />
          ))}
        </div>
      </div>
      <div
        className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[open=true]:opacity-100 [@media(hover:none)]:opacity-100"
        data-open={menuOpen}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Go to tab" onClick={onFocus}>
              <SquareArrowOutUpRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go to tab</TooltipContent>
        </Tooltip>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Tab actions">
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {readAt && (
              <>
                <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">Page read {relativeTime(readAt)}</DropdownMenuLabel>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={onActivate}>Show details</DropdownMenuItem>
            <DropdownMenuItem onClick={onFocus}>Go to tab</DropdownMenuItem>
            <DropdownMenuItem onClick={onCopy}>Copy URL</DropdownMenuItem>
            <DropdownMenuItem onClick={onSave} disabled={!!saved}>
              {saved ? "Already saved" : "Save to library"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onMove}>Move to group…</DropdownMenuItem>
            {group && <DropdownMenuItem onClick={onUngroup}>Remove from group</DropdownMenuItem>}
            {lenses.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {lenses.map((lens) => (
                  <DropdownMenuItem key={lens.id} onClick={() => onRetry(lens)}>
                    Re-evaluate {lens.name}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onClose}>
              Close tab
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
