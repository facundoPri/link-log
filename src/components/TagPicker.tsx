import { useState, type ReactNode } from "react";
import { Check, Plus } from "lucide-react";
import type { Link, Tag } from "../types";
import { formatPct } from "../lib/tags";
import { TagDot } from "./TagChip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

export function TagPicker({
  trigger,
  tags,
  link,
  value,
  onToggle,
  onCreate,
  open: openProp,
  onOpenChange,
}: {
  trigger: ReactNode;
  tags: Tag[];
  /** Link mode: tag membership of this link is toggled via onToggle/onCreate. */
  link?: Link;
  /** Local mode: selected tag names (e.g. AddLinkDialog). */
  value?: string[];
  onToggle: (name: string) => void;
  onCreate: (name: string) => void;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = openProp ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [input, setInput] = useState("");
  const assigned = link
    ? new Set(link.tags.map((t) => t.name))
    : new Set(value ?? []);
  const exact = tags.some(
    (t) => t.name === input.trim().toLocaleLowerCase(),
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Add or create tag…"
            value={input}
            onValueChange={setInput}
          />
          <CommandList>
            <CommandEmpty>
              {input.trim() && !exact ? (
                <button
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-sm"
                  onClick={() => onCreate(input.trim().toLocaleLowerCase())}
                >
                  <Plus className="size-3.5" />
                  Create “{input.trim()}”
                </button>
              ) : (
                <span className="text-sm text-muted-foreground">
                  No tags yet
                </span>
              )}
            </CommandEmpty>
            {tags.map((t) => {
              const isAssigned = assigned.has(t.name);
              const score = link?.evaluations.find((e) => e.tag_id === t.id);
              return (
                <CommandItem
                  key={t.id}
                  value={t.name}
                  onSelect={() => onToggle(t.name)}
                >
                  <TagDot name={t.name} />
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto flex items-center gap-1">
                    {!isAssigned && score && (
                      <span className="text-2xs text-muted-foreground tabular">
                        {formatPct(score.probability)}
                      </span>
                    )}
                    {isAssigned && <Check className="size-3.5" />}
                  </span>
                </CommandItem>
              );
            })}
            {input.trim() && !exact && (
              <CommandItem
                value={`__create__${input}`}
                onSelect={() => onCreate(input.trim().toLocaleLowerCase())}
              >
                <Plus className="size-3.5" />
                Create “{input.trim()}”
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
