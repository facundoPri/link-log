import { Link2, Search } from "lucide-react";
import type { Lens, Link } from "../types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LinkRow, type LinkJob } from "./LinkRow";
import { usePaintSelection } from "../lib/usePaintSelection";

export function LinkList({
  links,
  loaded,
  filtered,
  jobsByLink,
  lens,
  activeId,
  picked,
  onActivate,
  setPicked,
  onAdd,
  onClearFilters,
  rowActions,
}: {
  links: Link[];
  loaded: boolean;
  filtered: boolean;
  jobsByLink: Map<string, LinkJob>;
  lens?: Lens | null;
  activeId: string | null;
  picked: string[];
  onActivate: (id: string) => void;
  setPicked: (fn: (ids: string[]) => string[]) => void;
  onAdd: () => void;
  onClearFilters: () => void;
  rowActions: {
    onToggleTagFilter: (id: string) => void;
    onDomainFilter: (domain: string) => void;
    onEditTags: (link: Link) => void;
    onExtract: (link: Link) => void;
    onRetry: (link: Link, step?: "content") => void;
    onDismiss: (link: Link) => void;
    onUsePreview: (link: Link) => void;
    onDelete: (link: Link) => void;
    onCopyUrl: (link: Link) => void;
  };
}) {
  const paint = usePaintSelection({ picked, setPicked, count: picked.length, noun: "link" });
  if (!loaded) {
    return (
      <div className="divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3">
            <Skeleton className="mt-1 size-4" />
            <Skeleton className="h-12 w-[72px] rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (!links.length) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            {filtered ? (
              <Search className="size-5" />
            ) : (
              <Link2 className="size-5" />
            )}
          </div>
          <h2 className="text-sm font-medium">
            {lens ? `No results for ${lens.name}` : filtered ? "No links match" : "Save your first link"}
          </h2>
          <p className="text-[13px] text-muted-foreground">
            {lens
              ? `No links analyzed with this lens yet — select links and choose Lens → ${lens.name}.`
              : filtered
                ? "Try a different title, domain or tag."
                : "Paste a URL anywhere on this page or drag one from another tab, then add tags if you like."}
          </p>
          {lens ? null : filtered ? (
            <Button variant="ghost" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          ) : (
            <Button size="sm" onClick={onAdd}>
              Add link
            </Button>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
    <div ref={paint.listRef} className="divide-y" role="list">
      {links.map((link) => (
        <LinkRow
          key={link.id}
          link={link}
          job={jobsByLink.get(link.id)}
          lens={lens}
          active={activeId === link.id}
          picked={picked.includes(link.id)}
          onActivate={() => onActivate(link.id)}
          onPicked={(c, shift) => paint.toggle(link.id, c, shift)}
          onToggleTagFilter={rowActions.onToggleTagFilter}
          onDomainFilter={rowActions.onDomainFilter}
          onEditTags={() => rowActions.onEditTags(link)}
          onExtract={() => rowActions.onExtract(link)}
          onRetry={(step) => rowActions.onRetry(link, step)}
          onDismiss={() => rowActions.onDismiss(link)}
          onUsePreview={() => rowActions.onUsePreview(link)}
          onDelete={() => rowActions.onDelete(link)}
          onCopyUrl={() => rowActions.onCopyUrl(link)}
        />
      ))}
    </div>
    <p role="status" className="sr-only">{paint.live}</p>
    </>
  );
}
