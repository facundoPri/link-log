import { useState } from "react";
import { BookmarkPlus, Copy, FolderInput, Moon, Sparkles, SunMedium, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { BrowserTab } from "@linklog/browser-protocol";
import type { Destination } from "../../browser/useBrowserWorkspace";
import { loadBlocked, SLEEP_WARNING, sleepBlocked } from "../../browser/sleeping";
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

/** A secondary action with a tooltip: why it's unavailable, or a warning worth reading first. */
function Gated({ blocked, hint, disabled, onClick, children }: { blocked: string | null; hint?: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  const button = (
    <Button variant="ghost" size="sm" disabled={disabled || !!blocked} onClick={onClick} className={mobile}>
      {children}
    </Button>
  );
  const tip = blocked ?? hint;
  if (!tip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block min-w-0">{button}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{tip}</TooltipContent>
    </Tooltip>
  );
}

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
  onLoad,
  onSleep,
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
  onLoad: () => void;
  onSleep: () => void;
  onClose: () => void;
  onClear: () => void;
  /** Why Autogroup can't run (Jev not configured), or null. */
  jevReason: string | null;
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const ungrouped = tabs.filter((t) => t.groupId === null).length;
  const groupable = tabs.filter((t) => t.groupId === null && !t.pinned).length;
  const loadable = tabs.filter((t) => !loadBlocked(t)).length;
  const sleepable = tabs.filter((t) => !sleepBlocked(t)).length;
  const partial = (n: number) => (n < tabs.length ? ` (${n})` : "");
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
      <div className="flex shrink-0 items-center gap-1 max-[700px]:col-span-2 max-[700px]:row-start-2 max-[700px]:grid max-[700px]:grid-cols-4">
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
        <Gated
          disabled={busy}
          onClick={onAutogroup}
          blocked={
            jevReason ??
            (!destinations.length
              ? "Create or pin a group with a description first"
              : !ungrouped
                ? "Autogroup only places tabs that have no group"
                : !groupable
                  ? "Pinned tabs are never grouped; they stay in place"
                  : null)
          }
        >
          <Sparkles className="size-3.5" />
          Autogroup
        </Gated>
        <Gated disabled={busy} onClick={onLoad} blocked={loadable ? null : "None of the selected tabs is sleeping"}>
          <SunMedium className="size-3.5" />
          Load content{partial(loadable)}
        </Gated>
        <Gated
          disabled={busy}
          onClick={onSleep}
          blocked={sleepable ? null : "Already asleep, active, playing audio or a browser page"}
          hint={SLEEP_WARNING}
        >
          <Moon className="size-3.5" />
          Put to sleep{partial(sleepable)}
        </Gated>
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
