import {
  Activity,
  CircleAlert,
  CircleDot,
  CircleHelp,
  Ellipsis,
  Gauge,
  Globe,
  Inbox,
  Link2,
  ListChecks,
  LogOut,
  Plus,
  Settings,
  Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Lens, Library, Tag as TagType } from "../types";
import { needsAttention } from "../attention";
import { Button } from "@/components/ui/button";
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
import { TagDot } from "./TagChip";
import { cn } from "../lib/utils";

export type View =
  | "all"
  | "untagged"
  | "attention"
  | "browser"
  | { kind: "lens"; id: string };

export function lensIcon(type: Lens["type"], className = "size-4") {
  return type === "noul" ? (
    <CircleHelp className={className} />
  ) : type === "choice" ? (
    <CircleDot className={className} />
  ) : type === "multi" ? (
    <ListChecks className={className} />
  ) : (
    <Gauge className={className} />
  );
}

export function Sidebar({
  library,
  view,
  tagIds,
  activeBatch,
  onView,
  onToggleTag,
  onNewTag,
  onEditTag,
  onDeleteTag,
  onOpenLens,
  onNewLens,
  onEditLens,
  onDeleteLens,
  onActivity,
  account,
  onSignOut,
  onSettings,
  browserCount,
  browserPanel,
}: {
  /** Tabs in this window, or null while the extension isn't connected. */
  browserCount: number | null;
  /** Groups and lens toggles shown instead of Tags/Lenses in Browser mode. */
  browserPanel: ReactNode;
  library: Library;
  view: View;
  tagIds: string[];
  activeBatch: { label: string; done: number; total: number } | null;
  onView: (v: View) => void;
  onToggleTag: (id: string) => void;
  onNewTag: () => void;
  onEditTag: (tag: TagType) => void;
  onDeleteTag: (tag: TagType) => void;
  onOpenLens: (id: string) => void;
  onNewLens: () => void;
  onEditLens: (lens: Lens) => void;
  onDeleteLens: (lens: Lens) => void;
  onActivity: () => void;
  account: { email: string };
  onSignOut: () => void;
  onSettings: () => void;
}) {
  const untaggedCount = library.links.filter((l) => !l.tags.length).length;
  const attentionCount = library.links.filter(needsAttention).length;
  const tagCount = (id: string) =>
    library.links.filter((l) => l.tags.some((t) => t.id === id)).length;
  const lensCount = (id: string) =>
    library.links.filter((l) => l.lens_results.some((r) => r.lens_id === id))
      .length;
  const item =
    "h-7 w-full justify-start gap-2 px-2 text-[13px] font-normal text-sidebar-foreground data-[active=true]:bg-accent data-[active=true]:font-medium";
  const count = "ml-auto text-2xs text-muted-foreground tabular";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 px-4">
        <span className="flex size-5 items-center justify-center rounded-md bg-brand">
          <Link2 className="size-3 text-brand-foreground" strokeWidth={2.5} />
        </span>
        <span className="text-sm font-semibold tracking-tight">Linklog</span>
      </div>
      <nav className="flex shrink-0 flex-col gap-0.5 px-2" aria-label="Library">
        <Button
          variant="ghost"
          className={item}
          data-active={view === "all" && !tagIds.length}
          onClick={() => onView("all")}
        >
          <Inbox className="size-4" />
          All links
          <span className={count}>{library.links.length}</span>
        </Button>
        <Button
          variant="ghost"
          className={item}
          data-active={view === "untagged"}
          onClick={() => onView("untagged")}
        >
          <Tag className="size-4" />
          Untagged
          <span className={count}>{untaggedCount}</span>
        </Button>
        {attentionCount > 0 && (
          <Button
            variant="ghost"
            className={item}
            data-active={view === "attention"}
            onClick={() => onView("attention")}
          >
            <CircleAlert className="size-4" />
            Needs attention
            <span className={count}>{attentionCount}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          className={item}
          data-active={view === "browser"}
          onClick={() => onView("browser")}
        >
          <Globe className="size-4" />
          Browser
          <span className={count}>{browserCount ?? ""}</span>
        </Button>
      </nav>
      {view === "browser" ? (
        browserPanel
      ) : (
        <>
      <div className="mt-3 flex h-7 shrink-0 items-center justify-between px-4">
        <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          Tags
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New tag"
              onClick={onNewTag}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New tag</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {library.tags.map((t) => (
          <div key={t.id} className="group relative">
            <Button
              variant="ghost"
              className={cn(item, "pr-8")}
              data-active={tagIds.includes(t.id)}
              onClick={() => onToggleTag(t.id)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <TagDot name={t.name} />
              <span className="truncate">{t.name}</span>
              <span className={count}>{tagCount(t.id)}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Tag options for ${t.name}`}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem onClick={() => onEditTag(t)}>
                  Edit tag…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onToggleTag(t.id)}>
                  Filter by tag
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDeleteTag(t)}
                >
                  Delete tag…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        {!library.tags.length && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            No tags yet.{" "}
            <Button
              variant="link"
              size="sm"
              className="h-auto px-0 text-xs"
              onClick={onNewTag}
            >
              Create one
            </Button>
          </div>
        )}
        <div className="mt-3 flex h-7 items-center justify-between px-2">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Lenses
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="New lens"
                onClick={onNewLens}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New lens</TooltipContent>
          </Tooltip>
        </div>
        {library.lenses.filter((lens) => lens.scope !== "browser").map((lens) => (
          <div key={lens.id} className="group relative">
            <Button
              variant="ghost"
              className={cn(item, "pr-8")}
              data-active={
                typeof view === "object" && view.id === lens.id
              }
              onClick={() => onOpenLens(lens.id)}
              onContextMenu={(e) => e.preventDefault()}
            >
              {lensIcon(lens.type)}
              <span className="truncate">{lens.name}</span>
              <span className={count}>{lensCount(lens.id)}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Lens options for ${lens.name}`}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Ellipsis className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="right">
                <DropdownMenuItem onClick={() => onEditLens(lens)}>
                  Edit lens…
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onOpenLens(lens.id)}>
                  Open lens view
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onDeleteLens(lens)}
                >
                  Delete lens…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
        </>
      )}
      <div className="flex shrink-0 flex-col gap-0.5 border-t p-2">
        <Button variant="ghost" className={item} onClick={onActivity}>
          <Activity className="size-4" />
          {activeBatch ? activeBatch.label : "Activity"}
          {activeBatch && (
            <span className="ml-auto flex items-center gap-1.5 text-2xs text-muted-foreground tabular">
              {activeBatch.done}/{activeBatch.total}
              <span className="size-1.5 rounded-full bg-brand animate-pulse" />
            </span>
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className={item} title={account.email}>
              <span className="flex size-4 items-center justify-center rounded-full bg-muted text-2xs font-medium uppercase">
                {account.email.slice(0, 1)}
              </span>
              <span className="truncate">{account.email}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" className="w-56">
            <DropdownMenuItem onClick={onSettings}>
              <Settings className="size-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onSignOut}>
              <LogOut className="size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
