import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { domainOf } from "../url";
import {
  CircleAlert,
  Ellipsis,
  ExternalLink,
  FileText,
  Globe,
  Loader2,
} from "lucide-react";
import type { Lens, Link, Tag } from "../types";
import { attentionMessage, canRetryPreview, canUsePreview } from "../attention";
import { failureMessage } from "../failures";
import { cn } from "../lib/utils";
import { youtubeId } from "../lib/youtube";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { TagChip } from "./TagChip";
import { LensVerdict } from "./LensVerdict";

export type LinkJob = {
  kind: "extract" | "preview" | "autotag" | "lens" | "query";
  status: string;
  step?: string | null;
};

export function LinkRow({
  link,
  job,
  lens,
  active,
  picked,
  onActivate,
  onPicked,
  onToggleTagFilter,
  onDomainFilter,
  onEditTags,
  onExtract,
  onRetry,
  onDismiss,
  onUsePreview,
  onDelete,
  onCopyUrl,
}: {
  link: Link;
  job?: LinkJob;
  lens?: Lens | null;
  active: boolean;
  picked: boolean;
  onActivate: () => void;
  onPicked: (checked: boolean, shiftKey: boolean) => void;
  onToggleTagFilter: (id: string) => void;
  onDomainFilter: (domain: string) => void;
  onEditTags: () => void;
  onExtract: () => void;
  onRetry: (step?: "content") => void;
  onDismiss: () => void;
  onUsePreview: () => void;
  onDelete: () => void;
  onCopyUrl: () => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const lastShift = useRef(false);
  const yt = youtubeId(link.url);
  const thumb =
    link.image && !imgFailed
      ? link.image
      : yt
        ? `https://i.ytimg.com/vi/${yt}/mqdefault.jpg`
        : null;
  const jobLabel =
    job && ["queued", "waiting", "running"].includes(job.status)
      ? job.status === "queued" ? "Queued…"
        : job.status === "waiting" ? "Waiting for content…"
          : job.step?.startsWith("Waiting for ") ? job.step
            : job.kind === "extract" ? "Extracting…"
              : job.kind === "preview" ? "Fetching preview…"
                : job.kind === "autotag" ? "Tagging…" : "Applying lens…"
      : null;
  return (
    <LinkRowFrame
      className={cn(active && "bg-accent")}
      onClick={onActivate}
      onDoubleClick={() => window.open(link.url, "_blank", "noopener")}

      selection={
        <Checkbox
          aria-label={`Select ${link.title}`}
          checked={picked}
          onCheckedChange={(c) => onPicked(c === true, lastShift.current)}
          onClickCapture={(e) => {
            lastShift.current = e.shiftKey;
          }}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "mt-1 transition-opacity",
            !picked &&
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        />
      }
      thumbnail={
        <>
          {thumb && !imgFailed ? (
            <img
              src={thumb}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
              onError={() => setImgFailed(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-muted-foreground">
              {link.favicon && !faviconFailed ? (
                <img
                  src={link.favicon}
                  alt=""
                  className="size-5"
                  referrerPolicy="no-referrer"
                  onError={() => setFaviconFailed(true)}
                />
              ) : (
                <Globe className="size-5" />
              )}
            </div>
          )}
        </>
      }
      title={link.title}
      description={link.description || ""}
      details={
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onDomainFilter(link.domain);
                }}
              >
                {link.favicon && !faviconFailed ? (
                  <img
                    src={link.favicon}
                    alt=""
                    className="size-3"
                    referrerPolicy="no-referrer"
                    onError={() => setFaviconFailed(true)}
                  />
                ) : (
                  <Globe className="size-3" />
                )}
                {link.domain}
              </button>
            </TooltipTrigger>
            <TooltipContent>Filter by domain</TooltipContent>
          </Tooltip>
          {(link.metadata_evaluated || (link.content_source === "preview" && link.content_key)) && <Tooltip>
            <TooltipTrigger asChild><span tabIndex={0} aria-label={link.metadata_evaluated ? "Evaluation used metadata" : "Metadata available as content"} className="text-muted-foreground"><FileText className="size-3" /></span></TooltipTrigger>
            <TooltipContent>{link.metadata_evaluated ? "An evaluation used the saved title and description because page content was unavailable." : "Page content was unavailable. Saved title and description are available for evaluation."}</TooltipContent>
          </Tooltip>}
          {link.tags.map((tag: Tag) => (
            <TagChip
              key={tag.id}
              tag={tag}
              origin={tag.origin}
              score={
                link.evaluations.find((e) => e.tag_id === tag.id)?.probability
              }
              onClick={() => onToggleTagFilter(tag.id)}
            />
          ))}
          {link.content_state === "queued" && !jobLabel && (
            <Badge variant="outline" className="gap-1">
              <Loader2 className="size-3 animate-spin" />
              Extracting…
            </Badge>
          )}
          {jobLabel && (
            <Badge variant="outline" className="gap-1">
              <Loader2 className="size-3 animate-spin" />
              {jobLabel}
            </Badge>
          )}
          {link.content_state === "failed" && (
            <Badge variant="outline" className="gap-1 text-destructive">
              <CircleAlert className="size-3" />
              Context failed
            </Badge>
          )}
          {link.status === "failed" && (
            <Badge variant="outline" className="gap-1">
              <CircleAlert className="size-3" />
              No preview
            </Badge>
          )}
          {link.attention_kind && !link.processing && (
            <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="text-2xs text-destructive">{attentionMessage(link)}</span>
              <Button variant="ghost" size="xs" onClick={() => onRetry(link.attention_kind === "content" ? "content" : undefined)}>
                Retry
              </Button>
              {canUsePreview(link) && (
                <Button variant="ghost" size="xs" onClick={onUsePreview} title="Save the title and description as the content, so Jev can use it">
                  Use preview
                </Button>
              )}
              <Button variant="ghost" size="xs" onClick={onDismiss}>
                Dismiss
              </Button>
            </span>
          )}
          {lens &&
            (() => {
              const r = link.lens_results.find((r) => r.lens_id === lens.id);
              return r ? (
                <span
                  className="@2xl:hidden"
                  onClick={(e) => e.stopPropagation()}
                >
                  <LensVerdict lens={lens} result={r} size="sm" />
                </span>
              ) : null;
            })()}
        </>
      }
    >
      {lens &&
        (() => {
          const r = link.lens_results.find((r) => r.lens_id === lens.id);
          return r ? (
            <div
              className="hidden shrink-0 @2xl:block"
              onClick={(e) => e.stopPropagation()}
            >
              <LensVerdict lens={lens} result={r} size="sm" />
            </div>
          ) : null;
        })()}
      <div
        className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[open=true]:opacity-100 [@media(hover:none)]:opacity-100"
        data-open={menuOpen}
        onClick={(e) => e.stopPropagation()}
      >
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
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
            <DropdownMenuItem onClick={onCopyUrl}>Copy URL</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onEditTags}>Edit tags</DropdownMenuItem>
            <DropdownMenuItem onClick={onExtract}>
              {link.content_key ? "Re-extract context" : "Extract context"}
            </DropdownMenuItem>
            {canRetryPreview(link) && (
              <DropdownMenuItem onClick={() => onRetry()}>
                {link.status === "failed" ? "Retry preview" : "Fetch preview"}
              </DropdownMenuItem>
            )}
            {canUsePreview(link) && (
              <DropdownMenuItem onClick={onUsePreview}>Use preview as content</DropdownMenuItem>
            )}
            {link.attention_kind && (
              <DropdownMenuItem onClick={onDismiss}>Dismiss from Needs attention</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </LinkRowFrame>
  );
}

/** One layout for saved rows and saves awaiting server confirmation. */
function LinkRowFrame({
  selection,
  thumbnail,
  title,
  description,
  details,
  children,
  className,
  ...props
}: {
  selection: ReactNode;
  thumbnail: ReactNode;
  title: string;
  description: ReactNode;
  details: ReactNode;
} & Omit<ComponentProps<"article">, "title">) {
  return (
    <article
      {...props}
      className={cn(
        "group flex cursor-default items-start gap-3 px-4 py-3 hover:bg-accent/60",
        className,
      )}
    >
      {selection}
      <div className="h-12 w-[72px] shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-black/10">
        {thumbnail}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-5">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {details}
        </div>
      </div>
      {children}
    </article>
  );
}

export function PendingLinkRow({ url }: { url: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const videoId = youtubeId(url);
  const domain = domainOf(url);
  return (
    <LinkRowFrame
      aria-busy="true"
      selection={
        <Checkbox
          disabled
          checked={false}
          aria-label={`Saving ${domain}`}
          className="mt-1 opacity-0"
        />
      }
      thumbnail={
        videoId && !imageFailed ? (
          <img
            src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground">
            <Globe className="size-5" />
          </div>
        )
      }
      title={domain}
      description={
        <span className="inline-flex items-center gap-1">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          Saving…
        </span>
      }
      details={
        <span className="flex items-center gap-1 text-2xs text-muted-foreground">
          <Globe className="size-3" />
          {domain}
        </span>
      }
    />
  );
}
