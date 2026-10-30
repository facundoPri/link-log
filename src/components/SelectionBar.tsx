import { Copy, ExternalLink, FileText, Plus, Sparkles, Telescope, X } from "lucide-react";
import { toast } from "sonner";
import type { Lens, Link, Tag } from "../types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { lensIcon } from "./Sidebar";

export function SelectionBar({
  links,
  tags,
  lenses,
  running,
  jevReason,
  openReason,
  opening,
  onOpen,
  onAutoTag,
  onLens,
  onNewLens,
  onExtract,
  onClear,
}: {
  links: Link[];
  tags: Tag[];
  lenses: Lens[];
  running: boolean;
  /** Why Auto-tag and lenses can't run (Jev not configured), or null. */
  jevReason: string | null;
  openReason: string | null;
  opening: boolean;
  onOpen: () => void;
  onAutoTag: () => void;
  onLens: (lens: Lens) => void;
  onNewLens: () => void;
  onExtract: () => void;
  onClear: () => void;
}) {
  // Jev runs on links with content or with an extraction on the way; the others are skipped (or, for
  // auto-tag, extracted first when the user asks).
  const missing = links.filter(
    (l) => !l.content_key && l.content_state !== "queued",
  ).length;
  const ready = links.length > missing;
  const tagDisabled = !!jevReason || !links.length || !tags.length || running;
  const lensDisabled = !!jevReason || !ready || running;
  const tagReason =
    jevReason ??
    (!tags.length
      ? "Create a tag first"
      : running
        ? "Some links are still processing"
        : missing
          ? `${missing} of ${links.length} links have no content yet`
          : null);
  const lensReason =
    jevReason ??
    (!ready
      ? `${missing} of ${links.length} links need context first`
      : running
        ? "Some links are still processing"
        : missing
          ? `${missing} of ${links.length} links have no content and will be skipped`
          : null);
  const copy = async (withTitles: boolean) => {
    const text = links
      .map((link) =>
        withTitles && link.title ? `${link.url} — ${link.title}` : link.url,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(
        `${links.length} ${links.length === 1 ? "link" : "links"} copied`,
      );
    } catch {
      toast.error("Could not copy links");
    }
  };
  return (
    <div aria-label="Selected link actions" className="selection-bar fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 max-[700px]:grid max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-y-1">
      <div className="flex shrink-0 items-center max-[700px]:col-start-1 max-[700px]:row-start-1">
        <span className="shrink-0 whitespace-nowrap px-2 text-[13px] font-medium tabular">
          {links.length} selected
        </span>
      </div>
      <Separator orientation="vertical" className="h-5 max-[700px]:hidden" />
      <div className="flex shrink-0 items-center gap-1 max-[700px]:col-span-2 max-[700px]:row-start-2 max-[700px]:grid max-[700px]:grid-cols-5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block min-w-0">
              <Button
                size="sm"
                disabled={tagDisabled}
                onClick={onAutoTag}
                className="max-[700px]:h-auto max-[700px]:min-h-12 max-[700px]:w-full max-[700px]:flex-col max-[700px]:gap-0.5 max-[700px]:px-1 max-[700px]:py-1 max-[700px]:text-[11px]"
              >
                <Sparkles className="size-3.5" />
                Auto-tag
              </Button>
            </span>
          </TooltipTrigger>
          {tagReason && <TooltipContent>{tagReason}</TooltipContent>}
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block min-w-0">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={lensDisabled}
                    className="max-[700px]:h-auto max-[700px]:min-h-12 max-[700px]:w-full max-[700px]:flex-col max-[700px]:gap-0.5 max-[700px]:px-1 max-[700px]:py-1 max-[700px]:text-[11px]"
                  >
                    <Telescope className="size-3.5" />
                    Lens
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="center" className="w-64 p-0">
                  <Command>
                    <CommandInput placeholder="Pick a lens…" />
                    <CommandList>
                      <CommandEmpty>No lenses yet</CommandEmpty>
                      <CommandGroup heading="Lenses">
                        {lenses.map((lens) => (
                          <CommandItem
                            key={lens.id}
                            value={lens.name}
                            onSelect={() => onLens(lens)}
                          >
                            {lensIcon(lens.type, "size-3.5")}
                            <span className="min-w-0">
                              <span className="block truncate">
                                {lens.name}
                              </span>
                              <span className="block truncate text-2xs text-muted-foreground">
                                {lens.question}
                              </span>
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                      <CommandSeparator />
                      <CommandGroup>
                        <CommandItem value="new lens" onSelect={onNewLens}>
                          <Plus className="size-3.5" />
                          New lens…
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </span>
          </TooltipTrigger>
          {lensReason && <TooltipContent>{lensReason}</TooltipContent>}
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          disabled={running}
          onClick={onExtract}
          className="max-[700px]:h-auto max-[700px]:min-h-12 max-[700px]:w-full max-[700px]:flex-col max-[700px]:gap-0.5 max-[700px]:px-1 max-[700px]:py-1 max-[700px]:text-[11px]"
        >
          <FileText className="size-3.5" />
          <span className="max-[700px]:hidden">Extract context</span>
          <span className="hidden max-[700px]:inline">Extract</span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block min-w-0">
              <Button
                variant="ghost"
                size="sm"
                disabled={!!openReason || opening}
                onClick={onOpen}
                className="max-[700px]:h-auto max-[700px]:min-h-12 max-[700px]:w-full max-[700px]:flex-col max-[700px]:gap-0.5 max-[700px]:px-1 max-[700px]:py-1 max-[700px]:text-[11px]"
              >
                <ExternalLink className="size-3.5" />
                Open
              </Button>
            </span>
          </TooltipTrigger>
          {openReason && <TooltipContent>{openReason}</TooltipContent>}
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="max-[700px]:h-auto max-[700px]:min-h-12 max-[700px]:w-full max-[700px]:flex-col max-[700px]:gap-0.5 max-[700px]:px-1 max-[700px]:py-1 max-[700px]:text-[11px]"
            >
              <Copy className="size-3.5" />
              Copy
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void copy(false)}>
              Copy URLs
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copy(true)}>
              Copy URLs + titles
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Separator orientation="vertical" className="h-5 max-[700px]:hidden" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        onClick={onClear}
        className="max-[700px]:col-start-2 max-[700px]:row-start-1"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
