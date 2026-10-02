import { useState } from "react";
import { BookmarkPlus, Copy, FolderInput, Sparkles, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { BrowserTab } from "@linklog/browser-protocol";
import type { Destination } from "../../browser/useBrowserWorkspace";
import { GroupPicker } from "./GroupPicker";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const mobile =
  "max-[700px]:h-auto max-[700px]:min-h-12 max-[700px]:w-full max-[700px]:flex-col max-[700px]:gap-0.5 max-[700px]:px-1 max-[700px]:py-1 max-[700px]:text-[11px]";

/** Acts on the explicit selection only (lens evaluation always covers the whole window). */
export function BrowserSelectionBar({
  tabs,
  destinations,
  busy,
  onSave,
  onMove,
  onNewGroup,
  onUngroup,
  onAutogroup,
  onClose,
  onClear,
  jevReason,
}: {
  tabs: BrowserTab[];
  destinations: Destination[];
  busy: boolean;
  onSave: () => void;
  onMove: (d: Destination) => void;
  onNewGroup: () => void;
  onUngroup: () => void;
  onAutogroup: () => void;
  onClose: () => void;
  onClear: () => void;
  /** Why Autogroup can't run (Jev not configured), or null. */
  jevReason: string | null;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const ungrouped = tabs.filter((t) => t.groupId === null).length;
  const copy = async (withTitles: boolean) => {
    try {
      await navigator.clipboard.writeText(tabs.map((t) => (withTitles && t.title ? `${t.url} — ${t.title}` : t.url)).join("\n"));
      toast.success(`${tabs.length} ${tabs.length === 1 ? "link" : "links"} copied`);
    } catch {
      toast.error("Could not copy links");
    }
  };
  return (
    <div
      aria-label="Selected tab actions"
      className="selection-bar fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 max-[700px]:grid max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:gap-y-1"
    >
      <span className="shrink-0 whitespace-nowrap px-2 text-[13px] font-medium tabular max-[700px]:col-start-1 max-[700px]:row-start-1">
        {tabs.length} selected
      </span>
      <Separator orientation="vertical" className="h-5 max-[700px]:hidden" />
      <div className="flex shrink-0 items-center gap-1 max-[700px]:col-span-2 max-[700px]:row-start-2 max-[700px]:grid max-[700px]:grid-cols-5">
        <Button size="sm" disabled={busy} onClick={onSave} className={mobile}>
          <BookmarkPlus className="size-3.5" />
          Save
        </Button>
        <Popover open={moveOpen} onOpenChange={setMoveOpen}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="sm" disabled={busy} className={mobile}>
              <FolderInput className="size-3.5" />
              Group
            </Button>
          </PopoverTrigger>
          <PopoverContent align="center" className="w-64 p-0">
            <GroupPicker
              destinations={destinations}
              canUngroup={ungrouped < tabs.length}
              onPick={(d) => {
                setMoveOpen(false);
                onMove(d);
              }}
              onNew={() => {
                setMoveOpen(false);
                onNewGroup();
              }}
              onUngroup={() => {
                setMoveOpen(false);
                onUngroup();
              }}
            />
          </PopoverContent>
        </Popover>
        {(() => {
          const blocked = jevReason
            ? jevReason
            : !destinations.length
            ? "Create or pin a group with a description first"
            : !ungrouped
              ? "Autogroup only places tabs that have no group"
              : null;
          const button = (
            <Button variant="ghost" size="sm" disabled={busy || !!blocked} onClick={onAutogroup} className={mobile}>
              <Sparkles className="size-3.5" />
              Autogroup
            </Button>
          );
          // Explain only why it's unavailable; the enabled action speaks for itself.
          return blocked ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block min-w-0">{button}</span>
              </TooltipTrigger>
              <TooltipContent>{blocked}</TooltipContent>
            </Tooltip>
          ) : (
            button
          );
        })()}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose} className={mobile}>
          <XCircle className="size-3.5" />
          Close
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={mobile}>
              <Copy className="size-3.5" />
              Copy
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => void copy(false)}>Copy URLs</DropdownMenuItem>
            <DropdownMenuItem onClick={() => void copy(true)}>Copy URLs + titles</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Separator orientation="vertical" className="h-5 max-[700px]:hidden" />
      <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear} className="max-[700px]:col-start-2 max-[700px]:row-start-1">
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
