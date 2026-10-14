import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Check,
  PanelLeft,
  Plus,
  Search,
  X,
} from "lucide-react";
import type { Tag } from "../types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Checkbox } from "@/components/ui/checkbox";
import { CommandGroup, CommandItem, CommandSeparator } from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { TagChip, TagDot } from "./TagChip";
import { DomainChip, DomainFilter, type DomainEntry } from "./DomainFilter";
import type { Lens } from "../types";
import type { View } from "./Sidebar";

export type ContextFilter = "any" | "with" | "without";

export type { DomainEntry };

export function Toolbar({
  view,
  lens,
  count,
  query,
  tagIds,
  tags,
  domainFilter,
  tagCounts,
  context,
  domains,
  ascending,
  searchRef,
  allPicked,
  somePicked,
  onToggleAll,
  onQuery,
  onToggleDomain,
  onClearDomains,
  onContext,
  onToggleTag,
  onRemoveTag,
  onClear,
  onToggleSort,
  onAdd,
  onToggleSidebar,
}: {
  view: View;
  lens?: Lens | null;
  count: number;
  query: string;
  tagIds: string[];
  tags: Tag[];
  domainFilter: string[];
  tagCounts?: Record<string, number>;
  context: ContextFilter;
  domains: DomainEntry[];
  ascending: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  allPicked: boolean;
  somePicked: boolean;
  onToggleAll: () => void;
  onQuery: (q: string) => void;
  onToggleDomain: (d: string) => void;
  onClearDomains: () => void;
  onContext: (c: ContextFilter) => void;
  onToggleTag: (id: string) => void;
  onRemoveTag: (id: string) => void;
  onClear: () => void;
  onToggleSort: () => void;
  onAdd: () => void;
  onToggleSidebar: () => void;
}) {
  const filtered = !!(
    query ||
    domainFilter.length ||
    context !== "any" ||
    tagIds.length
  );
  const titles: Record<"all" | "untagged" | "attention", string> = {
    all: "All links",
    untagged: "Untagged",
    attention: "Needs attention",
  };
  const activeFilters =
    domainFilter.length + (context !== "any" ? 1 : 0) + tagIds.length;
  const chips = (
    <>
      {domainFilter.map((name) => (
        <DomainChip
          key={name}
          domain={domains.find((d) => d.name === name) ?? { name, favicon: null }}
          onRemove={() => onToggleDomain(name)}
        />
      ))}
      {context !== "any" && (
        <Badge variant="secondary" className="gap-1">
          {context === "with" ? "With context" : "Without context"}
          <button
            aria-label="Remove context filter"
            onClick={() => onContext("any")}
          >
            <X className="size-3" />
          </button>
        </Badge>
      )}
      {tagIds.map((id) => {
        const tag = tags.find((t) => t.id === id);
        return tag ? (
          <TagChip key={id} tag={tag} onRemove={() => onRemoveTag(id)} />
        ) : null;
      })}
      {filtered && (
        <Button variant="ghost" size="sm" onClick={onClear}>
          Clear
        </Button>
      )}
    </>
  );
  return (
    <div className="shrink-0">
      <div className="flex h-12 items-center gap-2 border-b px-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Toggle sidebar"
              onClick={onToggleSidebar}
            >
              <PanelLeft className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Toggle sidebar <Kbd className="ml-1">⌘\</Kbd>
          </TooltipContent>
        </Tooltip>
        {count > 0 && (
          <Checkbox
            aria-label={
              allPicked ? "Deselect all" : `Select all ${count} links`
            }
            checked={
              allPicked ? true : somePicked ? "indeterminate" : false
            }
            onCheckedChange={onToggleAll}
          />
        )}
        <h1 className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
          {lens
            ? lens.name
            : tagIds.length && view === "all"
              ? "Tagged"
              : titles[view as "all" | "untagged" | "attention"]}
          <span className="text-muted-foreground tabular font-normal">
            · {count}
          </span>
        </h1>
        <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden md:flex">
          {chips}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              aria-label="Search links"
              placeholder="Search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              className="h-8 w-32 min-w-24 pl-8 pr-7 @2xl:w-56"
            />
            {query ? (
              <button
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => onQuery("")}
              >
                <X className="size-3.5" />
              </button>
            ) : (
              <Kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 sm:inline-flex">
                /
              </Kbd>
            )}
          </div>
          <DomainFilter
            domains={domains}
            selected={domainFilter}
            onToggle={onToggleDomain}
            activeCount={activeFilters}
            clearLabel="Clear filters"
            onClear={() => {
              onContext("any");
              onClearDomains();
              tagIds.forEach(onRemoveTag);
            }}
          >
            <CommandGroup heading="Context">
              <CommandItem
                value="context with"
                onSelect={() => onContext(context === "with" ? "any" : "with")}
              >
                With context
                {context === "with" && <Check className="ml-auto size-3.5" />}
              </CommandItem>
              <CommandItem
                value="context without"
                onSelect={() => onContext(context === "without" ? "any" : "without")}
              >
                Without context
                {context === "without" && <Check className="ml-auto size-3.5" />}
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Tags">
              {tags.map((t) => (
                <CommandItem key={t.id} value={`tag ${t.name}`} onSelect={() => onToggleTag(t.id)}>
                  <TagDot name={t.name} />
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <span className="text-2xs text-muted-foreground tabular">{tagCounts?.[t.id] ?? ""}</span>
                    {tagIds.includes(t.id) && <Check className="size-3.5" />}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </DomainFilter>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={ascending ? "Least recently saved first" : "Recently saved first"}
                className="hidden @2xl:inline-flex"
                onClick={onToggleSort}
              >
                {ascending ? (
                  <ArrowUpNarrowWide className="size-4" />
                ) : (
                  <ArrowDownWideNarrow className="size-4" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {ascending ? "Least recently saved first" : "Recently saved first"}
            </TooltipContent>
          </Tooltip>
          <Button size="sm" onClick={onAdd} aria-label="Add link">
            <Plus className="size-3.5" />
            <span className="hidden @2xl:inline">Add link</span>
            <Kbd className="ml-1 hidden @2xl:inline-flex">⌘K</Kbd>
          </Button>
        </div>
      </div>
      {filtered && (
        <div className="flex flex-wrap gap-1.5 border-b px-4 py-2 md:hidden">
          {chips}
        </div>
      )}
    </div>
  );
}
