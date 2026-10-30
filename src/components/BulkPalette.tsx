import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Lens } from "../types";
import { actionForKey, ACTION_GROUPS, type ActionState, type BulkAction } from "../bulkActions";
import { Kbd } from "@/components/ui/kbd";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { lensIcon } from "./Sidebar";

// One row per action: the skip reason trails the label and groups sit in a left gutter, so today's actions fit
// without a scrollbar.
export function BulkPalette({
  open,
  onOpenChange,
  page,
  onPage,
  selected,
  states,
  lenses,
  onInvoke,
  onNewLens,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The picker action whose choices replace the action list, or null. */
  page: BulkAction | null;
  onPage: (action: BulkAction | null) => void;
  selected: number;
  states: ActionState[];
  lenses: Lens[];
  onInvoke: (action: BulkAction, detail?: string) => void;
  onNewLens: () => void;
}) {
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(""), [page, open]);
  const byId = new Map(states.map((s) => [s.action.id, s]));
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Bulk actions"
      description={`Act on ${selected} selected links`}
      showCloseButton={false}
      className="top-[18%] translate-y-0 sm:max-w-[600px]"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px] text-muted-foreground">
        {page ? (
          <button type="button" className="hover:text-foreground" onClick={() => onPage(null)}>
            ← {page.label} on {selected} {selected === 1 ? "link" : "links"}
          </button>
        ) : (
          <>
            <span className="flex-1">
              Acting on <b className="tabular text-foreground">{selected} selected</b>
            </span>
            <span>Press a key to run directly</span>
          </>
        )}
      </div>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={page ? "Pick a lens…" : "Filter actions…"}
        onKeyDown={(e) => {
          if (page) {
            if (e.key === "Backspace" && !search) onPage(null);
            return;
          }
          if (search) return;
          const action = actionForKey(e);
          if (!action) return;
          e.preventDefault();
          const s = byId.get(action.id);
          if (s && !s.disabled) onInvoke(action);
        }}
      />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>{page ? (lenses.length ? "No matching lens" : "No lenses yet") : "No matching action"}</CommandEmpty>
        {page ? (
          <>
            <CommandGroup>
              {lenses.map((lens) => (
                <CommandItem key={lens.id} value={lens.name} onSelect={() => onInvoke(page, lens.id)}>
                  {lensIcon(lens.type, "size-4")}
                  <span className="min-w-0">
                    <span className="block truncate">{lens.name}</span>
                    <span className="block truncate text-2xs text-muted-foreground">{lens.question}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem value="new lens" forceMount onSelect={onNewLens}>
                <Plus className="size-4" />
                New lens…
              </CommandItem>
            </CommandGroup>
          </>
        ) : (
          ACTION_GROUPS.map(({ group, actions }) => (
            <CommandGroup
              key={group}
              heading={group}
              className={cn(
                "grid grid-cols-[4.5rem_1fr] items-start !px-1.5 !py-1",
                "[&_[cmdk-group-heading]]:col-start-1 [&_[cmdk-group-heading]]:row-start-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide",
                "[&_[cmdk-group-items]]:col-start-2 [&_[cmdk-group-items]]:row-start-1",
                group === "Danger" && "[&_[cmdk-group-heading]]:text-destructive",
              )}
            >
              {actions.map((a) => {
                const s = byId.get(a.id)!;
                const Icon = a.icon;
                return (
                  <CommandItem
                    key={a.id}
                    value={a.label}
                    disabled={s.disabled}
                    onSelect={() => onInvoke(a)}
                    className="!py-1.5"
                  >
                    <Icon className="!size-4" />
                    <span className="whitespace-nowrap">{a.label}</span>
                    {s.reason && (
                      <span className="min-w-0 truncate text-2xs text-muted-foreground" title={s.reason}>
                        {s.reason}
                      </span>
                    )}
                    <span className="ml-auto pl-2 text-[12px] tabular text-muted-foreground">
                      {s.availability.blocked ? "–" : `${s.availability.eligible.length}/${selected}`}
                    </span>
                    {a.shortcut && <Kbd className="min-w-6">{a.shortcut}</Kbd>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))
        )}
      </CommandList>
    </CommandDialog>
  );
}
