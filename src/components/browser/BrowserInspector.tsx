import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkCheck, Ellipsis, Globe, RotateCw, SquareArrowOutUpRight, X } from "lucide-react";
import type { BrowserGroup, BrowserTab, Capture, LensRecord, TabPreview } from "@linklog/browser-protocol";
import type { Lens, Link } from "../../types";
import { relativeTime } from "../../lib/time";
import { relatedLinks } from "../../lib/related-links";
import { lensIcon } from "../Sidebar";
import { TagChip } from "../TagChip";
import { BrowserLensStatus } from "./BrowserLensStatus";
import { ContentPanel, LinksPanel, type Read } from "./BrowserTabContent";
import { GROUP_STYLE, groupTitle } from "./groups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-2 py-1.5 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Right-hand panel for one open tab, mirroring the link inspector: what the page says
 * about itself, what lenses answered, and the content Linklog reads from it — all read
 * locally by the extension. Opening it reads the page (a user action); nothing is sent
 * to the backend unless a lens runs or the tab is saved.
 */
export function BrowserInspector({
  tab,
  group,
  saved,
  preview,
  domain,
  lenses,
  records,
  savedUrls,
  read,
  onClose,
  onFocus,
  onCopy,
  onSave,
  onMove,
  onUngroup,
  onCloseTab,
  onRetry,
  onMetadata,
  onAllowAccess,
  onToggleGroup,
  onDomainFilter,
  onSaveRelated,
}: {
  tab: BrowserTab;
  group: BrowserGroup | undefined;
  saved: Link | undefined;
  preview: TabPreview | undefined;
  domain: string;
  lenses: Lens[];
  records: Record<string, LensRecord> | undefined;
  savedUrls: Set<string>;
  read: (fresh: boolean) => Promise<Capture>;
  onClose: () => void;
  onFocus: () => void;
  onCopy: () => void;
  onSave: () => void;
  onMove: () => void;
  onUngroup: () => void;
  onCloseTab: () => void;
  onRetry: (lens: Lens) => void;
  onMetadata: (lens: Lens) => void;
  onAllowAccess: () => void;
  onToggleGroup: (groupId: number) => void;
  onDomainFilter: (domain: string) => void;
  onSaveRelated: (url: string) => Promise<unknown>;
}) {
  const [state, setState] = useState<Read>({ status: "idle" });
  const [imgFailed, setImgFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [activeTab, setActiveTab] = useState("content");
  const readable = tab.content === "available";

  // Only the latest read may land: an older one (previous document, earlier "Read
  // again") finishing late must not overwrite it.
  const readRef = useRef(read);
  readRef.current = read;
  const seq = useRef(0);
  const load = useCallback((fresh: boolean) => {
    const mine = ++seq.current;
    setState({ status: "loading" });
    readRef
      .current(fresh)
      .then((capture) => mine === seq.current && setState({ status: "ready", capture }))
      .catch((e) => mine === seq.current && setState({ status: "error", error: (e as Error).message }));
  }, []);
  // A new tab or a new document in the same tab is read again; hash changes are not.
  useEffect(() => {
    setImgFailed(false);
    if (!readable) {
      seq.current++;
      setState({ status: "idle" });
      return;
    }
    load(false);
  }, [tab.tabInstanceId, tab.documentRevision, readable, load]);

  const capture = state.status === "ready" ? state.capture : null;
  const markdown = capture?.markdown ?? "";
  const related = useMemo(() => (markdown ? relatedLinks(markdown, tab.url) : []), [markdown, tab.url]);
  const image = (preview?.image || capture?.image || "") && !imgFailed ? preview?.image || capture?.image : "";
  const description = preview?.description || capture?.description || "";
  const facts = capture?.facts ?? [];
  const firstSeen = relativeTime(new Date(tab.firstSeenAt).toISOString());

  const lensSection = lenses.length > 0 && (
    <section className="space-y-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Lenses</h3>
      {lenses.map((lens) => (
        <div key={lens.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs" data-lens-status={lens.id}>
          {lensIcon(lens.type, "size-3.5 shrink-0 text-muted-foreground")}
          <span className="min-w-0 flex-1 truncate font-medium">{lens.name}</span>
          <span className="inline-flex items-center gap-1.5">
            <BrowserLensStatus
              lens={lens}
              record={records?.[lens.id]}
              tab={tab}
              size="md"
              onRetry={() => onRetry(lens)}
              onMetadata={() => onMetadata(lens)}
            />
          </span>
          <Button variant="ghost" size="icon-xs" aria-label={`Re-evaluate ${lens.name}`} onClick={() => onRetry(lens)}>
            <RotateCw className="size-3" />
          </Button>
        </div>
      ))}
    </section>
  );

  return (
    <div className="flex h-full flex-col" data-browser-inspector={tab.tabId}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {tab.favIconUrl && !faviconFailed ? (
          <img src={tab.favIconUrl} alt="" className="size-3.5" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} />
        ) : (
          <Globe className="size-3.5 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{domain || tab.url}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Go to tab" onClick={onFocus}>
              <SquareArrowOutUpRight className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Go to tab</TooltipContent>
        </Tooltip>
        <DropdownMenu>
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
            {readable && <DropdownMenuItem onClick={() => load(true)}>Read page again</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onCloseTab}>
              Close tab
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" aria-label="Close inspector" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-4">
        <div className="space-y-4 pt-4">
          {image ? (
            <img
              src={image}
              alt=""
              className="aspect-video w-full rounded-lg bg-muted object-cover ring-1 ring-black/10"
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
            />
          ) : null}
          <div>
            <h2 className="text-base font-semibold leading-snug tracking-tight text-pretty break-words">{tab.title || tab.url}</h2>
            {description && <p className="mt-1 line-clamp-3 text-[13px] text-muted-foreground text-pretty">{description}</p>}
            <p className="mt-1.5 text-2xs text-muted-foreground">
              <span title="When the extension first saw this tab (since Chrome or the extension last started)">First seen {firstSeen}</span>
              {capture && (
                <>
                  {" · "}
                  {capture.extractor === "article" ? "Article" : capture.source === "metadata" ? "Title only" : "Page text"}
                  {capture.completeness === "partial" && (
                    <>
                      {" · "}
                      <span className="text-amber-600 dark:text-amber-400">Partial</span>
                    </>
                  )}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {domain && (
              <button
                type="button"
                className="inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-2xs text-muted-foreground hover:text-foreground"
                onClick={() => onDomainFilter(domain)}
              >
                <Globe className="size-3" />
                {domain}
              </button>
            )}
            {group && (
              <button
                type="button"
                className="inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium hover:opacity-80"
                style={{ background: GROUP_STYLE[group.color].bg, color: GROUP_STYLE[group.color].fg }}
                onClick={() => onToggleGroup(group.groupId)}
              >
                <span className="size-1.5 rounded-full" style={{ background: GROUP_STYLE[group.color].dot }} />
                {groupTitle(group.title)}
              </button>
            )}
            {saved ? (
              <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
                <BookmarkCheck className="size-3" />
                Saved {relativeTime(saved.created_at)}
              </Badge>
            ) : (
              <Button variant="outline" size="sm" className="h-5 px-1.5 text-2xs" onClick={onSave}>
                Save to library
              </Button>
            )}
            {saved?.tags.map((t) => <TagChip key={t.id} tag={t} />)}
            {facts
              .filter((f) => f.key.endsWith(".state"))
              .map((f) => (
                <Badge key={f.key} variant="secondary" className="font-normal">
                  {f.value}
                </Badge>
              ))}
          </div>
          {lensSection}
        </div>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4 pb-4">
          <TabsList className="sticky top-0 z-10 w-full bg-background">
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="links">Links{related.length ? ` ${related.length}` : ""}</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>
          <TabsContent value="content" className="mt-3">
            <ContentPanel
              key={tab.documentRevision}
              tab={tab}
              state={state}
              onReload={() => load(true)}
              onAllowAccess={onAllowAccess}
              onFocus={onFocus}
            />
          </TabsContent>
          <TabsContent value="links" className="mt-3">
            <LinksPanel related={related} read={!!capture} savedUrls={savedUrls} onSave={onSaveRelated} />
          </TabsContent>
          <TabsContent value="details" className="mt-3">
            <dl className="divide-y">
              <Row label="URL">
                <span className="break-all">{tab.url}</span>
              </Row>
              {(preview?.siteName || capture?.siteName) && <Row label="Site">{preview?.siteName || capture?.siteName}</Row>}
              {capture?.byline && <Row label="Author">{capture.byline}</Row>}
              {capture?.lang && <Row label="Language">{capture.lang}</Row>}
              <Row label="First seen">{firstSeen}</Row>
              <Row label="Status">
                {tab.active ? "Active tab" : tab.discarded ? "Unloaded" : tab.status === "loading" ? "Loading" : "Loaded"}
                {tab.pinned ? " · pinned" : ""}
                {tab.audible ? " · playing audio" : ""}
              </Row>
              {capture && (
                <>
                  <Row label="Read">{relativeTime(capture.capturedAt)}</Row>
                  <Row label="Extraction">
                    {capture.extractor === "article" ? "Main article (Readability)" : capture.source === "metadata" ? "Title and URL only" : "Whole page region"}
                    {" · "}
                    {capture.completeness}
                  </Row>
                  <Row label="Size">{capture.chars.toLocaleString("en")} characters</Row>
                </>
              )}
              {facts.map((f) => (
                <Row key={f.key} label={f.label}>
                  {f.value}
                </Row>
              ))}
            </dl>
            <p className="mt-3 text-2xs text-muted-foreground">
              Read locally by the extension from what the tab already loaded. It is sent to Linklog only when a lens
              evaluates this tab or you save it.
            </p>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
