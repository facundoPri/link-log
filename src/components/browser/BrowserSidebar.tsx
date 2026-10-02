import { Ellipsis, FolderOpen, Pin, Plus } from "lucide-react";
import type { Lens } from "../../types";
import type { BrowserWorkspace, Destination } from "../../browser/useBrowserWorkspace";
import { cn } from "../../lib/utils";
import { lensIcon } from "../Sidebar";
import { GROUP_STYLE, groupTitle } from "./groups";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const item =
  "h-7 w-full justify-start gap-2 px-2 text-[13px] font-normal text-sidebar-foreground data-[active=true]:bg-accent data-[active=true]:font-medium";
const count = "ml-auto text-2xs text-muted-foreground tabular";
const more =
  "absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100";

function Heading({ label, action, onAction }: { label: string; action: string; onAction: () => void }) {
  return (
    <div className="mt-3 flex h-7 shrink-0 items-center justify-between px-2">
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={action} onClick={onAction}>
            <Plus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{action}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Browser mode replaces Tags with the window's groups and lens views with lens toggles. */
export function BrowserSidebar({
  ws,
  onNewGroup,
  onEditDestination,
  onTogglePin,
  onUngroupAll,
  onSelectGroup,
  onNewLens,
  onEditLens,
  onDeleteLens,
  onCleanLens,
  onReevaluateLens,
}: {
  ws: BrowserWorkspace;
  onNewGroup: () => void;
  onEditDestination: (d: Destination) => void;
  onTogglePin: (d: Destination) => void;
  onUngroupAll: (groupId: number) => void;
  onSelectGroup: (groupId: number) => void;
  onNewLens: () => void;
  onEditLens: (lens: Lens) => void;
  onDeleteLens: (lens: Lens) => void;
  onCleanLens: (lens: Lens) => void;
  onReevaluateLens: (lens: Lens) => void;
}) {
  const connected = !!ws.browser.snapshot;
  const tabsIn = (groupId: number | null) => ws.tabs.filter((t) => t.groupId === groupId).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
      <Heading label="Groups" action="New group" onAction={onNewGroup} />
      {ws.destinations.map((d) => {
        const color = d.kind === "group" ? d.group.color : d.pinned.color;
        const name = d.kind === "group" ? groupTitle(d.group.title) : d.pinned.name;
        const pinned = d.kind === "pinned" || !!d.pinned;
        const active = d.kind === "group" && ws.groupFilter.includes(d.group.groupId);
        return (
          <div key={d.key} className="group relative">
            <Button
              variant="ghost"
              className={cn(item, "pr-8", d.kind === "pinned" && "text-muted-foreground")}
              data-active={active}
              onClick={() => (d.kind === "group" ? ws.toggleGroupFilter(d.group.groupId) : onEditDestination(d))}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={
                  d.kind === "pinned"
                    ? { boxShadow: `inset 0 0 0 1.5px ${GROUP_STYLE[color].dot}` }
                    : { background: GROUP_STYLE[color].dot }
                }
              />
              <span className="truncate">{name}</span>
              {pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" />}
              <span className={count}>{d.kind === "group" ? tabsIn(d.group.groupId) : "not open"}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Group options for ${name}`} className={more}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem onClick={() => onEditDestination(d)}>Edit group…</DropdownMenuItem>
                {d.kind === "group" && (
                  <>
                    <DropdownMenuItem onClick={() => ws.toggleGroupFilter(d.group.groupId)}>Filter by group</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onSelectGroup(d.group.groupId)}>Select its tabs</DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onClick={() => onTogglePin(d)}>
                  {pinned ? "Unpin from library…" : "Pin to library"}
                </DropdownMenuItem>
                {d.kind === "group" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => onUngroupAll(d.group.groupId)}>Ungroup tabs</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      {connected && (
        <Button
          variant="ghost"
          className={item}
          data-active={ws.groupFilter.includes("none")}
          onClick={() => ws.toggleGroupFilter("none")}
        >
          <FolderOpen className="size-4" />
          Ungrouped
          <span className={count}>{tabsIn(null)}</span>
        </Button>
      )}
      {connected && !ws.destinations.length && (
        <p className="px-2 py-1 text-xs text-muted-foreground">No groups in this window.</p>
      )}
      <Heading label="Lenses" action="New browser lens" onAction={onNewLens} />
      {ws.browserLenses.map((lens) => {
        const on = ws.activeIds.includes(lens.id);
        return (
          <div key={lens.id} className="group relative">
            <Button
              variant="ghost"
              className={cn(item, "pr-8")}
              data-active={on}
              aria-pressed={on}
              onClick={() => ws.toggleLens(lens.id)}
            >
              {lensIcon(lens.type, cn("size-4", on && "text-brand"))}
              <span className="truncate">{lens.name}</span>
              <span
                aria-hidden
                className={cn(
                  "ml-auto flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors",
                  on ? "justify-end bg-brand" : "justify-start bg-border",
                )}
              >
                <span className="size-2.5 rounded-full bg-background shadow-sm" />
              </span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-xs" aria-label={`Lens options for ${lens.name}`} className={more}>
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem onClick={() => ws.toggleLens(lens.id)}>{on ? "Turn off" : "Turn on"}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onEditLens(lens)}>Edit lens…</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onReevaluateLens(lens)}>Re-evaluate this window</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCleanLens(lens)}>Clean results…</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => onDeleteLens(lens)}>
                  Delete lens…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      })}
      {!ws.browserLenses.length && (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          No browser lenses yet.{" "}
          <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={onNewLens}>
            Create one
          </Button>
        </div>
      )}
    </div>
  );
}
