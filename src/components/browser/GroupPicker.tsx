import { FolderMinus, Pin, Plus } from "lucide-react";
import type { Destination } from "../../browser/useBrowserWorkspace";
import { GROUP_STYLE, groupTitle } from "./groups";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

/** Destinations for Move: groups of this window, pinned groups (created on use), or a new one. */
export function GroupPicker({
  destinations,
  canUngroup,
  onPick,
  onNew,
  onUngroup,
}: {
  destinations: Destination[];
  canUngroup: boolean;
  onPick: (d: Destination) => void;
  onNew: () => void;
  onUngroup: () => void;
}) {
  const local = destinations.filter((d) => d.kind === "group");
  const pinned = destinations.filter((d) => d.kind === "pinned");
  return (
    <Command>
      <CommandInput placeholder="Move to group…" />
      <CommandList>
        <CommandEmpty>No groups match</CommandEmpty>
        {local.length > 0 && (
          <CommandGroup heading="In this window">
            {local.map((d) =>
              d.kind === "group" ? (
                <CommandItem key={d.key} value={`${d.group.title} ${d.key}`} onSelect={() => onPick(d)}>
                  <span className="size-2 rounded-full" style={{ background: GROUP_STYLE[d.group.color].dot }} />
                  <span className="truncate">{groupTitle(d.group.title)}</span>
                  {d.pinned && <Pin className="ml-auto size-3 text-muted-foreground" />}
                </CommandItem>
              ) : null,
            )}
          </CommandGroup>
        )}
        {pinned.length > 0 && (
          <CommandGroup heading="Pinned">
            {pinned.map((d) =>
              d.kind === "pinned" ? (
                <CommandItem key={d.key} value={`${d.pinned.name} ${d.key}`} onSelect={() => onPick(d)}>
                  <span className="size-2 rounded-full" style={{ boxShadow: `inset 0 0 0 1.5px ${GROUP_STYLE[d.pinned.color].dot}` }} />
                  <span className="min-w-0">
                    <span className="block truncate">{d.pinned.name}</span>
                    <span className="block truncate text-2xs text-muted-foreground">Creates it in this window</span>
                  </span>
                </CommandItem>
              ) : null,
            )}
          </CommandGroup>
        )}
        <CommandSeparator />
        <CommandGroup>
          <CommandItem value="new group" onSelect={onNew}>
            <Plus className="size-3.5" />
            New group…
          </CommandItem>
          {canUngroup && (
            <CommandItem value="remove from group ungroup" onSelect={onUngroup}>
              <FolderMinus className="size-3.5" />
              Remove from group
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}
