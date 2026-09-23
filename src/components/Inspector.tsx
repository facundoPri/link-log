import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import {
  CircleAlert,
  Copy,
  Ellipsis,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../api";
import type { Lens, Library, Link, Tag, ContentDetails, MediaItem } from "../types";
import { cn } from "../lib/utils";
import { captionMenuTracks, youtubeId } from "../lib/youtube";
import { relativeTime } from "../lib/time";
import { confidence, formatPct, isStale } from "../lib/tags";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";
import { TagChip, TagDot } from "./TagChip";
import { TagPicker } from "./TagPicker";
import { LensVerdict } from "./LensVerdict";
import { lensIcon } from "./Sidebar";

const markdownClasses = cn(
  "text-[13px] leading-6",
  "[&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-medium",
  "[&_p]:my-2 [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3",
  "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
);

const sourceLabel: Record<string, string> = {
  web: "Page text",
  youtube: "Transcript",
  manual: "Manual text",
  "youtube-post": "YouTube post",
  "instagram-post": "Instagram post",
  "instagram-reel": "Instagram reel",
  "x-post": "X post",
};

function MediaPreview({ item, original }: { item: MediaItem; original: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{item.kind === "image" ? "Image" : "Video"} {item.position + 1}</span>
        <Badge variant={item.ocr_state === "failed" ? "destructive" : "secondary"}>
          {item.ocr_state === "skipped" ? "Preview" : item.ocr_state === "done" ? item.kind === "video" ? "Preview OCR" : "OCR" : item.ocr_state === "no_text" ? "No text" : item.ocr_state === "failed" ? "OCR failed" : "Pending"}
        </Badge>
      </div>
      {item.preview_url && !failed ? (
        <a href={original} target="_blank" rel="noopener noreferrer" aria-label={`Open original post for ${item.kind} ${item.position + 1}`}>
          <img src={item.preview_url} alt={`${item.kind} ${item.position + 1} preview`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="max-h-80 w-full rounded-md object-contain bg-muted" />
        </a>
      ) : <a href={original} target="_blank" rel="noopener noreferrer" className="text-xs underline">Preview unavailable · open original</a>}
      {item.kind === "video" && <p className="text-xs text-muted-foreground">{item.ocr_state === "skipped" ? "Video preview only. Audio and frames were not analyzed." : "OCR reads this still preview only. Video motion and audio were not analyzed."}</p>}
      {item.ocr_state === "done" && item.ocr_text && <div className="rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap break-words">{item.kind === "video" && <p className="mb-1 font-medium">Text in preview</p>}{item.ocr_text}</div>}
      {item.ocr_state === "failed" && <p className="text-xs text-destructive">{item.ocr_error || "OCR failed"}</p>}
    </div>
  );
}

export function Inspector({
  link,
  tags,
  lenses,
  onClose,
  onChange,
  onDeleted,
  onRunLens,
  onOpenLens,
  onToggleTag,
  onAutoTag,
  onExtract,
  onSelectTrack,
  onRetry,
  running,
  focusTags,
}: {
  link: Link;
  tags: Tag[];
  lenses: Lens[];
  onClose: () => void;
  onChange: (library: Library) => void;
  onDeleted: () => void;
  onRunLens: (lens: Lens) => void;
  onOpenLens: (lensId: string) => void;
  onToggleTag: (tagId: string) => void;
  onAutoTag: () => void;
  onExtract: () => void;
  onSelectTrack: (language: string) => void;
  onRetry: () => void;
  running?: "extract" | "autotag" | "lens" | "query" | null;
  focusTags?: boolean;
}) {
  const [markdown, setMarkdown] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contentMode, setContentMode] = useState<"preview" | "markdown">(() =>
    localStorage.getItem("linklog.contentMode") === "markdown"
      ? "markdown"
      : "preview",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [selectedMedia, setSelectedMedia] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setMarkdown("");
    setEditing(false);
    setSelectedMedia(0);
    setError("");
    api<{ markdown: string }>(`/links/${link.id}/content`)
      .then((r) => {
        if (alive) {
          setMarkdown(r.markdown);
          setDraft(r.markdown);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [link.id, link.content_version]);

  useEffect(() => {
    if (focusTags) setPickerOpen(true);
  }, [focusTags]);

  const yt = youtubeId(link.url);
  let details: ContentDetails | null = null;
  try { details = link.content_details ? JSON.parse(link.content_details) as ContentDetails : null; } catch { /* older record */ }
  const selectableTracks = captionMenuTracks(details?.transcript?.tracks || []);

  async function setLinkTags(names: string[]) {
    try {
      onChange(await api(`/links/${link.id}`, "PATCH", { tags: names }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const toggleTag = (name: string) =>
    setLinkTags(
      link.tags.some((t) => t.name === name)
        ? link.tags.filter((t) => t.name !== name).map((t) => t.name)
        : [...link.tags.map((t) => t.name), name],
    );

  async function saveText() {
    setBusy(true);
    setError("");
    try {
      onChange(
        await api(`/links/${link.id}/content`, "PUT", { markdown: draft }),
      );
      setEditing(false);
      toast.success("Context saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const evaluated = [...link.evaluations]
    .map((e) => ({ e, tag: tags.find((t) => t.id === e.tag_id) }))
    .filter((x): x is { e: Link["evaluations"][0]; tag: Tag } => !!x.tag)
    .sort((a, b) => b.e.probability - a.e.probability);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {link.favicon && !faviconFailed ? (
          <img
            src={link.favicon}
            alt=""
            className="size-3.5"
            referrerPolicy="no-referrer"
            onError={() => setFaviconFailed(true)}
          />
        ) : (
          <Globe className="size-3.5 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {link.domain}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild>
              <a
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open link"
              >
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open link</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Link actions">
              <Ellipsis className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                Open in new tab
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(link.url);
                toast("URL copied");
              }}
            >
              Copy URL
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onExtract}>
              {link.content_key ? "Re-extract context" : "Extract context"}
            </DropdownMenuItem>
            {link.status === "failed" && (
              <DropdownMenuItem onClick={onRetry}>
                Retry preview
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close inspector"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex-1 overflow-y-auto px-4">
        <div className="space-y-4 pt-4">
        {yt ? (
          <div className="overflow-hidden rounded-lg bg-black ring-1 ring-black/10">
            <iframe
              className="aspect-video w-full"
              src={`https://www.youtube-nocookie.com/embed/${yt}`}
              allow="accelerometer; encrypted-media; picture-in-picture"
              allowFullScreen
              loading="lazy"
              title={link.title}
            />
          </div>
        ) : !link.media?.length && link.image && !imgFailed ? (
          <img
            src={link.image}
            alt=""
            className="aspect-video w-full rounded-lg object-cover ring-1 ring-black/10"
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
          />
        ) : null}
        <div>
          <h2 className="text-base font-semibold leading-snug tracking-tight text-pretty">
            {link.title}
          </h2>
          {link.description && (
            <p className="mt-1 text-[13px] text-muted-foreground text-pretty">
              {link.description}
            </p>
          )}
          <p className="mt-1.5 text-2xs text-muted-foreground">
            Saved {relativeTime(link.created_at)} ·{" "}
            {sourceLabel[link.content_source ?? ""] ?? "Page"}
            {link.content_state === "partial" && <> · <span className="text-destructive">Partial</span></>}
          </p>
        </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {link.tags.map((tag) => (
              <TagChip
                key={tag.id}
                tag={tag}
                origin={tag.origin}
                score={confidence(link, tag.id)?.probability}
                onClick={() => onToggleTag(tag.id)}
                onRemove={() =>
                  setLinkTags(
                    link.tags.filter((t) => t.id !== tag.id).map((t) => t.name),
                  )
                }
              />
            ))}
            <TagPicker
              tags={tags}
              link={link}
              onToggle={toggleTag}
              onCreate={(name) => setLinkTags([...link.tags.map((t) => t.name), name])}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              trigger={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-5 px-1.5 text-2xs"
                >
                  <Plus className="size-3" />
                  Add tag
                </Button>
              }
            />
          </div>
        </div>
        <Tabs defaultValue="content" className="mt-4 pb-4">
          <TabsList className="sticky top-0 z-10 w-full bg-background">
            <TabsTrigger value="content">Content</TabsTrigger>
            <TabsTrigger value="analysis">Analysis</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>
          <TabsContent value="content" className="mt-3">
            {details?.transcript && <div className="mb-3 flex flex-col gap-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Transcript: {details.transcript.selectedLanguage || "not selected"}{details.transcript.reason === "original" ? " · original" : details.transcript.reason === "manual" ? " · selected manually" : details.transcript.reason.startsWith("english-") ? " · English fallback" : ""}</span>
                {!!details.transcript.tracks.length && <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="outline" size="sm">Choose track</Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onSelectTrack("auto")}>Choose original automatically</DropdownMenuItem>
                    {selectableTracks.map((track) => <DropdownMenuItem key={track.languageCode} onClick={() => onSelectTrack(track.languageCode)}>
                      {track.languageName}{track.isAutoGenerated ? " · auto" : " · author preferred"}
                    </DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>}
              </div>
              {!details.transcript.originalLanguage && <p className="text-muted-foreground">Original audio language could not be verified.</p>}
            </div>}
            {(link.content_state === "partial" || (details?.issues.length || 0) > 0) && <div role="status" className="mb-3 flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs">
              <span className="font-medium">Extraction incomplete</span>
              {details?.issues.map((issue, i) => <span key={i} className="text-muted-foreground">{issue}</span>)}
              <Button variant="outline" size="sm" className="mt-1 self-start" onClick={onExtract}>Retry extraction</Button>
            </div>}
            {link.content_key && link.content_error && link.content_state !== "queued" && !details?.issues.includes(link.content_error) && <p role="alert" className="mb-3 text-xs text-destructive">Last extraction failed: {link.content_error}</p>}
            {!editing && !!link.media?.length && <div className="mb-4 flex flex-col gap-2" aria-label="Post media">
              <p className="text-xs text-muted-foreground">{link.media.length} media · {link.media.filter((item) => item.ocr_state === "done").length} with OCR</p>
              {link.media.length > 1 && <div className="grid grid-cols-5 gap-1.5" aria-label="Media in post order">
                {link.media.map((item, index) => <button key={item.media_key} type="button" aria-label={`Show ${item.kind} ${item.position + 1}`} aria-pressed={selectedMedia === index} onClick={() => setSelectedMedia(index)} className={cn("relative aspect-square overflow-hidden rounded-md bg-muted ring-1 ring-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", selectedMedia === index && "ring-2 ring-ring")}>
                  {item.preview_url && <img src={item.preview_url} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" />}
                  <span className="absolute bottom-0 inset-x-0 bg-background/85 px-1 text-[10px]">{item.kind === "video" ? "Video" : "Image"} {item.position + 1}</span>
                </button>)}
              </div>}
              <MediaPreview key={link.media[selectedMedia]?.media_key || link.media[0]!.media_key} item={link.media[selectedMedia] || link.media[0]!} original={link.url} />
            </div>}
            {editing ? (
              <div className="space-y-2">
                <div className="sticky top-9 z-10 -mx-4 flex items-center gap-2 border-b bg-background px-4 py-2">
                  <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Editing
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => fileInput.current?.click()}
                  >
                    Open file…
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".txt,.md,.srt,.vtt"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 2000000) {
                        toast.error("The file exceeds 2 MB.");
                        return;
                      }
                      setDraft(await file.text());
                    }}
                  />
                  <div className="ml-auto flex gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditing(false);
                        setDraft(markdown);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !draft.trim()}
                      onClick={() => void saveText()}
                    >
                      Save
                    </Button>
                  </div>
                </div>
                <Textarea
                  className="min-h-64"
                  value={draft}
                  maxLength={500000}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditing(false);
                      setDraft(markdown);
                    }
                  }}
                />
                {error && (
                  <p role="alert" className="text-xs text-destructive">
                    {error}
                  </p>
                )}
              </div>
            ) : link.content_state === "missing" && !link.content_key ? (
              <div className="rounded-lg border border-dashed p-6 text-center">
                <FileText className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-2 text-[13px] font-medium">No context yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Extract the page text so it can be auto-tagged and searched.
                </p>
                <div className="mt-3 flex justify-center gap-2">
                  <Button size="sm" onClick={onExtract}>
                    Extract context
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    Paste text
                  </Button>
                </div>
              </div>
            ) : link.content_state === "queued" && !link.content_key ? (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Extracting…
                </p>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ) : link.content_state === "failed" ? (
              <div className="rounded-lg border border-dashed p-6 text-center">
                <CircleAlert className="mx-auto size-5 text-destructive" />
                <p className="mt-2 text-xs text-destructive">
                  {link.content_error}
                </p>
                <div className="mt-3 flex justify-center gap-2">
                  <Button size="sm" variant="outline" onClick={onExtract}>
                    Retry
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(true)}
                  >
                    Paste text
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                {link.content_state === "queued" && <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Updating extraction… showing saved content</p>}
                <div className="flex items-center gap-1">
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={contentMode}
                    onValueChange={(v) => {
                      if (!v) return;
                      setContentMode(v as "preview" | "markdown");
                      localStorage.setItem("linklog.contentMode", v);
                    }}
                  >
                    <ToggleGroupItem value="preview" aria-label="Preview">
                      Preview
                    </ToggleGroupItem>
                    <ToggleGroupItem value="markdown" aria-label="Markdown">
                      Markdown
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <div className="ml-auto flex items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Copy markdown"
                          onClick={() => {
                            void navigator.clipboard.writeText(markdown);
                            toast("Markdown copied");
                          }}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Copy markdown</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Edit content"
                          onClick={() => {
                            setDraft(markdown);
                            setEditing(true);
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Edit</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Re-extract content"
                          onClick={onExtract}
                        >
                          <RotateCw className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Re-extract</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
                <div
                  className={cn(
                    "relative mt-2",
                    !expanded && "max-h-96 overflow-hidden",
                  )}
                >
                  {contentMode === "markdown" ? (
                    <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-5">
                      {markdown}
                    </pre>
                  ) : (
                    <div className={markdownClasses}>
                      <Markdown
                        components={{
                          img: ({ alt }) => (
                            <span className="text-muted-foreground">
                              Image: {alt || "no description"}
                            </span>
                          ),
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}
                      </Markdown>
                    </div>
                  )}
                  {!expanded && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />
                  )}
                </div>
                {!expanded && markdown.length > 1200 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1"
                    onClick={() => setExpanded(true)}
                  >
                    Show more
                  </Button>
                )}
              </div>
            )}
          </TabsContent>
          <TabsContent value="analysis" className="mt-3 space-y-4">
            <section>
              <div className="flex items-center gap-2">
                <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  Auto-tag
                </h3>
                <div className="ml-auto flex items-center gap-2">
                  {!evaluated.length && (
                    <span className="text-2xs text-muted-foreground">
                      Not auto-tagged yet.
                    </span>
                  )}
                  {running === "autotag" ? (
                    <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Tagging…
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-2xs"
                      onClick={onAutoTag}
                    >
                      <Sparkles className="size-3" />
                      Re-evaluate
                    </Button>
                  )}
                </div>
              </div>
              {!!evaluated.length && (
                <div className="mt-1.5 space-y-1">
                  {evaluated.map(({ e, tag }) => (
                    <Tooltip key={tag.id}>
                      <TooltipTrigger asChild>
                        <div className="flex h-[22px] cursor-default items-center gap-2">
                          <TagDot name={tag.name} />
                          <button
                            className="min-w-0 truncate text-xs hover:underline"
                            onClick={() => onToggleTag(tag.id)}
                          >
                            {tag.name}
                          </button>
                          <span className="flex-1" />
                          <span className="relative h-[3px] w-10 rounded-full bg-muted">
                            <span
                              className={cn(
                                "absolute inset-y-0 left-0 rounded-full",
                                e.probability >= e.threshold
                                  ? "bg-brand"
                                  : "bg-muted-foreground/40",
                              )}
                              style={{ width: `${e.probability * 100}%` }}
                            />
                            <span
                              className="absolute inset-y-0 w-px bg-foreground/30"
                              style={{ left: `${e.threshold * 100}%` }}
                            />
                          </span>
                          <span className="w-8 text-right text-2xs tabular text-muted-foreground">
                            {formatPct(e.probability)}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        Evaluated {relativeTime(e.evaluated_at)} with {e.model}
                        {isStale(e, tag, link) &&
                          " · Tag definition changed since"}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              )}
            </section>
            <section>
              <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Lenses
              </h3>
              <div className="mt-1.5 space-y-1.5">
                {link.lens_results.map((r) => {
                  const lens = lenses.find((l) => l.id === r.lens_id);
                  if (!lens) return null;
                  const icon = lensIcon(
                    lens.type,
                    "size-3.5 shrink-0 text-muted-foreground",
                  );
                  const stale =
                    r.lens_version < lens.version ||
                    r.content_version < link.content_version;
                  return (
                    <div key={r.lens_id} className="group/lens">
                      <div className="flex items-center gap-2">
                        {icon}
                        <button
                          className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
                          onClick={() => onOpenLens(lens.id)}
                        >
                          {lens.name}
                        </button>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={cn(
                                "shrink-0 text-2xs text-muted-foreground",
                                stale && "underline decoration-dotted",
                              )}
                            >
                              {relativeTime(r.evaluated_at)}
                            </span>
                          </TooltipTrigger>
                          {stale && (
                            <TooltipContent>
                              Computed with an older version of the lens/content
                            </TooltipContent>
                          )}
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="opacity-0 group-hover/lens:opacity-100"
                              aria-label="Run again"
                              onClick={() => onRunLens(lens)}
                            >
                              <RotateCw className="size-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Run again</TooltipContent>
                        </Tooltip>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-0 group-hover/lens:opacity-100"
                          aria-label={`Remove ${lens.name} result`}
                          onClick={async () => {
                            try {
                              onChange(
                                await api<Library>(
                                  `/links/${link.id}/lenses/${lens.id}`,
                                  "DELETE",
                                ),
                              );
                              toast.success("Result removed");
                            } catch (e) {
                              toast.error((e as Error).message);
                            }
                          }}
                        >
                          <X className="size-3" />
                        </Button>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 pl-[22px]">
                        <LensVerdict lens={lens} result={r} size="md" />
                      </div>
                    </div>
                  );
                })}
                {!link.lens_results.length && (
                  <p className="text-xs text-muted-foreground">
                    No lenses applied yet.
                  </p>
                )}
              </div>
            </section>
          </TabsContent>
          <TabsContent value="details" className="mt-3">
            <dl className="grid grid-cols-[88px_1fr] gap-y-2 text-xs">
              <dt className="text-muted-foreground">Original URL</dt>
              <dd className="min-w-0">
                <button
                  className="block w-full truncate text-left underline-offset-2 hover:underline"
                  onClick={() => {
                    void navigator.clipboard.writeText(link.original_url);
                    toast("URL copied");
                  }}
                >
                  {link.original_url}
                </button>
              </dd>
              {link.url !== link.original_url && (
                <>
                  <dt className="text-muted-foreground">Resolved URL</dt>
                  <dd className="min-w-0 truncate">{link.url}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Domain</dt>
              <dd>{link.domain}</dd>
              <dt className="text-muted-foreground">Saved</dt>
              <dd>{new Date(link.created_at).toLocaleString()}</dd>
              <dt className="text-muted-foreground">Preview</dt>
              <dd>
                {link.status === "ready"
                  ? "Ready"
                  : link.status === "pending"
                    ? "Pending"
                    : "Failed"}
                {link.status === "failed" && (
                  <>
                    {" · "}
                    <button
                      className="underline underline-offset-2"
                      onClick={onRetry}
                    >
                      Retry
                    </button>
                  </>
                )}
              </dd>
              <dt className="text-muted-foreground">Text</dt>
              <dd>
                {link.content_state}
                {markdown ? ` · ${markdown.length} chars` : ""}
                {` · v${link.content_version}`}
                {link.content_updated_at &&
                  ` · updated ${relativeTime(link.content_updated_at)}`}
              </dd>
            </dl>
          </TabsContent>
        </Tabs>
      </div>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this link?</AlertDialogTitle>
            <AlertDialogDescription className="truncate">
              {link.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                try {
                  await api(`/links/${link.id}`, "DELETE");
                  toast.success("Link deleted");
                  onDeleted();
                } catch (e) {
                  toast.error((e as Error).message);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
