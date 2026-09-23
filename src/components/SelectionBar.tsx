import { FileText, Plus, Sparkles, Telescope, X } from "lucide-react";
import type { Lens, Link, Tag } from "../types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
  total,
  tags,
  lenses,
  running,
  onSelectAll,
  onAutoTag,
  onLens,
  onNewLens,
  onExtract,
  onClear,
}: {
  links: Link[];
  total: number;
  tags: Tag[];
  lenses: Lens[];
  running: boolean;
  onSelectAll: () => void;
  onAutoTag: () => void;
  onLens: (lens: Lens) => void;
  onNewLens: () => void;
  onExtract: () => void;
  onClear: () => void;
}) {
  const ready =
    links.length > 0 &&
    links.every((l) => !!l.content_key && l.content_state !== "queued");
  const missing = links.filter(
    (l) => !l.content_key || l.content_state === "queued",
  ).length;
  const tagDisabled = !ready || !tags.length || running;
  const lensDisabled = !ready || running;
  const tagReason = !ready
    ? `${missing} of ${links.length} links need context first`
    : !tags.length
      ? "Create a tag first"
      : running
        ? "Some links are still processing"
        : null;
  const lensReason = !ready
    ? `${missing} of ${links.length} links need context first`
    : running
      ? "Some links are still processing"
      : null;
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
      <span className="px-2 text-[13px] font-medium tabular">
        {links.length} selected
      </span>
      {total > links.length && (
        <Button
          variant="link"
          size="sm"
          className="h-auto px-1 text-[13px]"
          onClick={onSelectAll}
        >
          Select all {total}
        </Button>
      )}
      <Separator orientation="vertical" className="h-5" />
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button size="sm" disabled={tagDisabled} onClick={onAutoTag}>
              <Sparkles className="size-3.5" />
              Auto-tag
            </Button>
          </span>
        </TooltipTrigger>
        {tagReason && <TooltipContent>{tagReason}</TooltipContent>}
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={lensDisabled}
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
      >
        <FileText className="size-3.5" />
        Extract context
      </Button>
      <Separator orientation="vertical" className="h-5" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
