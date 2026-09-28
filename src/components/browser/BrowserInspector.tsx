import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import {
  BookmarkCheck,
  Copy,
  Ellipsis,
  ExternalLink,
  FileWarning,
  Globe,
  Link2,
  Loader2,
  Lock,
  Moon,
  RotateCw,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import type { BrowserGroup, BrowserTab, Capture, LensRecord, TabPreview } from "@linklog/browser-protocol";
import type { Lens, Link } from "../../types";
import { cn } from "../../lib/utils";
import { relativeTime } from "../../lib/time";
import { relatedLinks } from "../../lib/related-links";
import { lensIcon } from "../Sidebar";
import { LensVerdict } from "../LensVerdict";
import { TagChip } from "../TagChip";
import { markdownClasses } from "../Inspector";
import { ACCESS_LABEL } from "./TabRow";
import { GROUP_STYLE, groupTitle } from "./groups";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Read =
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
  onAllowAccess: () => void;
  onToggleGroup: (groupId: number) => void;
  onDomainFilter: (domain: string) => void;
  onSaveRelated: (url: string) => Promise<unknown>;
}) {
  const [state, setState] = useState<Read>({ status: "idle" });
  const [mode, setMode] = useState(readMode);
  const [expanded, setExpanded] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("content");
  const readable = tab.content === "available";

  const load = (fresh: boolean) => {
    setState({ status: "loading" });
    read(fresh)
      .then((capture) => setState({ status: "ready", capture }))
      .catch((e) => setState({ status: "error", error: (e as Error).message }));
  };
  // A new tab or a new document in the same tab is read again; hash changes are not.
  useEffect(() => {
    setExpanded(false);
    setImgFailed(false);
    if (!readable) {
      setState({ status: "idle" });
      return;
    }
    load(false);
  }, [tab.tabInstanceId, tab.documentRevision, readable]); // eslint-disable-line react-hooks/exhaustive-deps

  const capture = state.status === "ready" ? state.capture : null;
  const markdown = capture?.markdown ?? "";
  const related = useMemo(() => (markdown ? relatedLinks(markdown, tab.url) : []), [markdown, tab.url]);
  const image = (preview?.image || capture?.image || "") && !imgFailed ? preview?.image || capture?.image : "";
  const description = preview?.description || capture?.description || "";
  const access = readable ? null : ACCESS_LABEL[tab.content as Exclude<BrowserTab["content"], "available">];
  const facts = capture?.facts ?? [];

  const lensSection = lenses.length > 0 && (
    <section className="space-y-1.5">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Lenses</h3>
      {lenses.map((lens) => {
        const r = records?.[lens.id];
        return (
          <div key={lens.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
            {lensIcon(lens.type, "size-3.5 shrink-0 text-muted-foreground")}
            <span className="min-w-0 flex-1 truncate font-medium">{lens.name}</span>
            {r?.state === "done" && r.answer ? (
              <LensVerdict
                lens={lens}
                result={{
                  lens_id: lens.id,
                  answer: r.answer,
                  lens_version: lens.version,
                  content_version: 0,
                  model: r.model ?? "",
                  evaluated_at: r.evaluatedAt ?? "",
                  batch_id: r.batchId ?? "",
                }}
              />
            ) : r && ["submitting", "queued", "running"].includes(r.state) ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                {r.state === "running" ? "Evaluating" : "Queued"}
              </span>
            ) : r?.state === "failed" || r?.state === "expired" || r?.state === "unavailable" ? (
              <span className={r.state === "failed" ? "text-destructive" : "text-muted-foreground"}>
                {r.state === "failed" ? "Failed" : r.state === "expired" ? "Expired" : "Unreadable"}
              </span>
            ) : (
              <span className="text-muted-foreground">Not evaluated</span>
            )}
            <Button variant="ghost" size="icon-xs" aria-label={`Re-evaluate ${lens.name}`} onClick={() => onRetry(lens)}>
              <RotateCw className="size-3" />
            </Button>
          </div>
        );
      })}
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
              Opened {relativeTime(new Date(tab.openedAt).toISOString())}
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
            {access ? (
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
            ) : state.status === "loading" || state.status === "idle" ? (
              <div className="space-y-2" aria-label="Reading page">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
              </div>
            ) : state.status === "error" ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-5 text-center">
                <p className="text-xs text-destructive">{state.error}</p>
                <Button size="sm" variant="outline" onClick={() => load(true)}>
                  Try again
                </Button>
              </div>
            ) : (
              <div>
                {capture!.completeness === "partial" && (
                  <div role="status" className="mb-3 flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs">
                    <span className="font-medium">Read partially</span>
                    {capture!.reasons
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
                    {capture!.chars.toLocaleString("en")} chars · read {relativeTime(capture!.capturedAt)}
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
                        <Button variant="ghost" size="icon-sm" aria-label="Read page again" onClick={() => load(true)}>
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
                    <div className={markdownClasses}>
                      <Markdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          img: ({ alt }) => <span className="text-muted-foreground">Image: {alt || "no description"}</span>,
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          ),
                          table: ({ children }) => (
                            <div className="my-2 overflow-x-auto">
                              <table className="w-full text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
                                {children}
                              </table>
                            </div>
                          ),
                        }}
                      >
                        {markdown}
                      </Markdown>
                    </div>
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
            )}
          </TabsContent>
          <TabsContent value="links" className="mt-3">
            {related.length ? (
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
                            await onSaveRelated(item.url);
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
            ) : (
              <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
                {capture ? "No links found in the page content." : "Links appear once the page has been read."}
              </div>
            )}
          </TabsContent>
          <TabsContent value="details" className="mt-3">
            <dl className="divide-y">
              <Row label="URL">
                <span className="break-all">{tab.url}</span>
              </Row>
              {(preview?.siteName || capture?.siteName) && <Row label="Site">{preview?.siteName || capture?.siteName}</Row>}
              {capture?.byline && <Row label="Author">{capture.byline}</Row>}
              {capture?.lang && <Row label="Language">{capture.lang}</Row>}
              <Row label="Opened">{relativeTime(new Date(tab.openedAt).toISOString())}</Row>
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
