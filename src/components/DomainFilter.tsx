import { useState, type ReactNode } from "react";
import { Check, Globe, ListFilter, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

export type DomainEntry = {
  name: string;
  count: number;
  favicon: string | null;
};

export function DomainIcon({ favicon }: { favicon: string | null }) {
  const [failed, setFailed] = useState(false);
  return favicon && !failed ? (
    <img src={favicon} alt="" className="size-3.5 rounded-sm" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  ) : (
    <Globe className="size-3.5 text-muted-foreground" />
  );
}

/** A selected domain, removable. */
export function DomainChip({ domain, onRemove }: { domain: DomainEntry | { name: string; favicon: string | null }; onRemove: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1 pr-1 font-normal">
      <DomainIcon favicon={domain.favicon} />
      {domain.name}
      <button
        aria-label={`Remove domain filter ${domain.name}`}
        className="rounded-sm text-muted-foreground hover:text-foreground"
        onClick={onRemove}
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}

/**
 * The Filter popover of All links and Browser: pick several domains (OR between them).
 * `children` adds other filter groups above the domains (All links: context and tags).
 */
export function DomainFilter({
  domains,
  selected,
  onToggle,
  onClear,
  activeCount = selected.length,
  clearLabel = "Clear domains",
  children,
}: {
  domains: DomainEntry[];
  selected: string[];
  onToggle: (name: string) => void;
  onClear: () => void;
  activeCount?: number;
  clearLabel?: string;
  children?: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" aria-label="Filter">
          <ListFilter className="size-3.5" />
          <span className="hidden sm:inline">Filter</span>
          {activeCount > 0 && (
            <span className="ml-0.5 rounded-sm bg-brand px-1 text-2xs font-medium tabular text-brand-foreground">{activeCount}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder="Filter by domain…" />
          <CommandList>
            <CommandEmpty>No domains match</CommandEmpty>
            {children}
            {children && <CommandSeparator />}
            <CommandGroup heading="Domains">
              {domains.map((d) => (
                <CommandItem key={d.name} value={d.name} onSelect={() => onToggle(d.name)}>
                  <DomainIcon favicon={d.favicon} />
                  <span className="truncate">{d.name}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <span className="text-2xs text-muted-foreground tabular">{d.count}</span>
                    {selected.includes(d.name) && <Check className="size-3.5" />}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {activeCount > 0 && (
            <div className="border-t p-1">
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onClear}>
                {clearLabel}
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
