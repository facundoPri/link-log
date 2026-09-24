import { useRef, useState } from "react";
import {
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
import type { BrowserGroup, BrowserTab, LensRecord } from "@linklog/browser-protocol";
import type { Lens, Link, Tag } from "../../types";
import { cn } from "../../lib/utils";
import { relativeTime } from "../../lib/time";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ACCESS_LABEL: Record<Exclude<BrowserTab["content"], "available">, { label: string; hint: string }> = {
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
  onRetry,
  onMetadata,
}: {
  lens: Lens;
  record: LensRecord | undefined;
  tab: BrowserTab;
  onRetry: () => void;
  onMetadata: () => void;
}) {
  const label = <span className="max-w-24 truncate text-muted-foreground">{lens.name}</span>;
  const shell = (children: React.ReactNode, tip?: React.ReactNode) => {
    const body = (
      <span className="inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-2xs" onClick={(e) => e.stopPropagation()}>
        {lensIcon(lens.type, "size-3 text-muted-foreground")}
        {label}
        {children}
      </span>
    );
    return tip ? (
      <Tooltip>
        <TooltipTrigger asChild>{body}</TooltipTrigger>
        <TooltipContent className="max-w-72">{tip}</TooltipContent>
      </Tooltip>
    ) : (
      body
    );
  };
  if (!record || record.state === "missing") {
    if (tab.content !== "available" && tab.content !== "loading")
      return shell(
        <button type="button" className="text-muted-foreground underline-offset-2 hover:underline" onClick={onMetadata}>
          Use title
        </button>,
        `${ACCESS_LABEL[tab.content].hint} You can evaluate with the title and URL only.`,
      );
    return shell(<Loader2 className="size-3 animate-spin text-muted-foreground" />, "Waiting to evaluate");
  }
  if (record.state === "submitting" || record.state === "queued" || record.state === "running")
    return shell(<Loader2 className="size-3 animate-spin text-muted-foreground" />, record.state === "running" ? "Evaluating with Jev" : "Queued");
  if (record.state === "done" && record.answer) {
    const partial = record.capture?.completeness === "partial";
    const metadata = record.capture?.source === "metadata";
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
        {(partial || metadata) && <span className="text-amber-600 dark:text-amber-400">{metadata ? "title only" : "partial"}</span>}
      </>,
      <>
        {record.capture
          ? `Page read ${relativeTime(record.capture.capturedAt)}${metadata ? " · title and URL only" : partial ? " · partial" : ""}`
          : null}
        {record.capture?.reasons.filter((r) => !/^Only content already loaded/.test(r)).map((r) => <div key={r}>{r}</div>)}
        {record.model && <div className="text-muted-foreground">{record.model}</div>}
      </>,
    );
  }
  const text = record.state === "expired" ? "Expired" : record.state === "unavailable" ? "Unreadable" : "Failed";
  return shell(
    <>
      <span className={record.state === "failed" ? "text-destructive" : "text-muted-foreground"}>{text}</span>
      <button type="button" aria-label={`Retry ${lens.name}`} className="text-muted-foreground hover:text-foreground" onClick={onRetry}>
        <RotateCw className="size-3" />
      </button>
    </>,
    record.error ?? "Retry explicitly to evaluate again.",
  );
}

export function TabRow({
  tab,
  group,
  saved,
  lenses,
  records,
  picked,
  stale,
  onPicked,
  onFocus,
  onToggleGroup,
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
  lenses: Lens[];
  records: Record<string, LensRecord> | undefined;
  picked: boolean;
  stale: boolean;
  onPicked: (checked: boolean, shift: boolean) => void;
  onFocus: () => void;
  onToggleGroup: (groupId: number) => void;
  onRetry: (lens: Lens) => void;
  onMetadata: (lens: Lens) => void;
  onSave: () => void;
  onClose: () => void;
  onMove: () => void;
  onUngroup: () => void;
  onCopy: () => void;
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const lastShift = useRef(false);
  const { host, rest } = pathOf(tab.url);
  const access = tab.content === "available" ? null : ACCESS_LABEL[tab.content];
  // Only unambiguous states (e.g. a PR's "Merged") earn a badge; other facts stay evidence.
  const facts = (Object.values(records ?? {}).find((r) => r.capture?.facts.length)?.capture?.facts ?? []).filter((f) =>
    f.key.endsWith(".state"),
  );
  return (
    <article
      className={cn("group flex cursor-default items-start gap-3 px-4 py-2.5 hover:bg-accent/60", stale && "opacity-60")}
      data-tab-id={tab.tabId}
      onDoubleClick={onFocus}
      onClick={(e) => onPicked(!picked, e.shiftKey)}
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
          "mt-2 transition-opacity",
          !picked && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
        )}
      />
      <div className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted ring-1 ring-black/10">
        {tab.favIconUrl && !faviconFailed ? (
          <img src={tab.favIconUrl} alt="" className="size-4" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} />
        ) : (
          <Globe className="size-4 text-muted-foreground" />
        )}
        {tab.active && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-brand ring-2 ring-background" aria-label="Active tab" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-sm font-medium leading-5">
          <span className="truncate">{tab.title || tab.url}</span>
          {tab.audible && <Volume2 className="size-3.5 shrink-0 text-muted-foreground" aria-label="Playing audio" />}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {host}
          <span className="opacity-70">{rest}</span>
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="outline" className="gap-1 font-normal">
                  Saved
                </Badge>
              </TooltipTrigger>
              <TooltipContent>In your library since {relativeTime(saved.created_at)}. Tags belong to the saved link, not to this tab.</TooltipContent>
            </Tooltip>
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
            <Tooltip key={f.key}>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="font-normal">
                  {f.value}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{f.label}, read from the page</TooltipContent>
            </Tooltip>
          ))}
          {lenses.map((lens) => (
            <LensCell
              key={lens.id}
              lens={lens}
              record={records?.[lens.id]}
              tab={tab}
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
          <DropdownMenuContent align="end">
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
