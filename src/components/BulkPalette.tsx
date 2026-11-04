import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import type { ActionMeta, ActionState } from "../bulkActions";
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
import type { PaletteCommand, Picker, SelectionNoun } from "./SelectionSurface";

const count = (n: number, noun: SelectionNoun) => (n === 1 ? noun : `${noun}s`);

const gutter = (group: string) =>
  cn(
    "grid grid-cols-[4.5rem_1fr] items-start !px-1.5 !py-1",
    "[&_[cmdk-group-heading]]:col-start-1 [&_[cmdk-group-heading]]:row-start-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide",
    "[&_[cmdk-group-items]]:col-start-2 [&_[cmdk-group-items]]:row-start-1",
    group === "Danger" && "[&_[cmdk-group-heading]]:text-destructive",
  );

/** Consecutive actions of the same group, in registry order. */
function byGroup(states: ActionState[]) {
  const groups: { group: string; states: ActionState[] }[] = [];
  for (const s of states) {
    const last = groups.at(-1);
    if (last?.group === s.action.group) last.states.push(s);
    else groups.push({ group: s.action.group, states: [s] });
  }
  return groups;
}

// ⌘K in every view. One row per action with its skip reason trailing the label and groups in a left gutter, so
// today's actions fit without a scrollbar, then the view's commands (Add links, Open links). With nothing
// selected only the commands are listed.
export function BulkPalette({
  open,
  onOpenChange,
  page,
  onPage,
  picker,
  noun,
  selected,
  states,
  commands,
  onInvoke,
  onCommand,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The picker action whose choices replace the action list, or null. */
  page: ActionMeta | null;
  onPage: (action: ActionMeta | null) => void;
  picker: Picker | null;
  noun: SelectionNoun;
  selected: number;
  states: ActionState[];
  commands: PaletteCommand[];
  onInvoke: (action: ActionMeta, detail?: string) => void;
  onCommand: (command: PaletteCommand) => void;
}) {
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setSearch(""), [page, open]);
  // Reopened while still animating out, the dialog keeps its content mounted and skips its autofocus.
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Commands"
      description={selected ? `Act on ${selected} selected ${count(selected, noun)}` : "Commands for this view"}
      showCloseButton={false}
      className="top-[18%] translate-y-0 sm:max-w-[600px]"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px] text-muted-foreground">
        {page ? (
          <button type="button" className="hover:text-foreground" onClick={() => onPage(null)}>
            ← {page.label} on {selected} {count(selected, noun)}
          </button>
        ) : selected ? (
          <>
            <span className="flex-1">
              Acting on <b className="tabular text-foreground">{selected} selected</b>
            </span>
            <span>Keys work without opening this menu</span>
          </>
        ) : (
          <span className="flex-1">Nothing selected · select {noun}s to act on them</span>
        )}
      </div>
      <CommandInput
        ref={input}
        value={search}
        onValueChange={setSearch}
        placeholder={picker ? picker.placeholder : "Type a command…"}
        onKeyDown={(e) => {
          if (page && e.key === "Backspace" && !search) onPage(null);
        }}
      />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>{picker ? picker.empty : "No matching command"}</CommandEmpty>
        {page && picker ? (
          <>
            <CommandGroup>
              {picker.choices.map((c) => (
                <CommandItem key={c.id} value={`${c.label} ${c.id}`} onSelect={() => onInvoke(page, c.id)}>
                  {c.icon}
                  <span className="min-w-0">
                    <span className="block truncate">{c.label}</span>
                    {c.description && <span className="block truncate text-2xs text-muted-foreground">{c.description}</span>}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem value={picker.newLabel} forceMount onSelect={picker.onNew}>
                <Plus className="size-4" />
                {picker.newLabel}
              </CommandItem>
            </CommandGroup>
          </>
        ) : (
          <>
            {selected > 0 &&
              byGroup(states).map(({ group, states: rows }) => (
                <CommandGroup key={group} heading={group} className={gutter(group)}>
                  {rows.map((s) => {
                    const a = s.action;
                    const Icon = a.icon;
                    return (
                      <CommandItem key={a.id} value={a.label} disabled={s.disabled} onSelect={() => onInvoke(a)} className="!py-1.5">
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
              ))}
            <CommandGroup heading="View" className={gutter("View")}>
              {commands.map((c) => {
                const Icon = c.icon;
                return (
                  <CommandItem key={c.id} value={`${c.label} ${c.description}`} disabled={!!c.disabled} onSelect={() => onCommand(c)} className="!py-1.5">
                    <Icon className="!size-4" />
                    <span className="whitespace-nowrap">{c.label}</span>
                    <span className="min-w-0 truncate text-2xs text-muted-foreground" title={c.disabled ?? c.description}>
                      {c.disabled ?? c.description}
                    </span>
                    {c.shortcut && <Kbd className="ml-auto min-w-6">{c.shortcut}</Kbd>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
