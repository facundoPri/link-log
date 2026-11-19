import { ArrowRight, Check, Plus, X } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { CommandGroup, CommandItem } from "@/components/ui/command";
import { plural } from "../lib/format";
import { pastedUrls } from "../url";
import type { EntryPick, LinkEntry } from "./SelectionSurface";

const LISTED = 4;

/** Picking a tag toggles it; picking a group replaces the one picked before. */
export function togglePick(picks: EntryPick[], pick: EntryPick, multiple: boolean): EntryPick[] {
  const picked = picks.some((p) => p.id === pick.id);
  if (!multiple) return picked ? [] : [pick];
  return picked ? picks.filter((p) => p.id !== pick.id) : [...picks, pick];
}

/** The links, what happens to them, and what's picked: shown above the palette's rows. */
export function LinkEntrySummary({
  entry,
  links,
  picks,
  onUnpick,
}: {
  entry: LinkEntry;
  links: string[];
  picks: EntryPick[];
  onUnpick: (pick: EntryPick) => void;
}) {
  const problem = links.length ? entry.problem(links, picks) : null;
  return (
    <div className="space-y-1.5 border-b px-3 py-2 text-xs">
      {links.length ? (
        <ul aria-label="Links" className="space-y-0.5">
          {links.slice(0, LISTED).map((url) => (
            <li key={url} className="truncate text-foreground" title={url}>
              {url}
            </li>
          ))}
          {links.length > LISTED && <li className="text-muted-foreground">+{links.length - LISTED} more</li>}
        </ul>
      ) : (
        <p className="text-muted-foreground">Paste one link or several, or type one and press Enter.</p>
      )}
      <p className="text-muted-foreground">{entry.note}</p>
      {picks.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {picks.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
              {p.icon}
              {p.label}
              {p.created && <span className="text-muted-foreground">(new)</span>}
              <button type="button" aria-label={`Remove ${p.label}`} className="text-muted-foreground hover:text-foreground" onClick={() => onUnpick(p)}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {entry.hint && <p className="text-muted-foreground">{entry.hint}</p>}
      {problem && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * The links page's rows, filtered here (the palette's own filter is off on this page). With an empty filter the primary row comes first, so a paste then Enter saves or opens;
 * while typing, the matching tags or groups come first and ⌘↵ submits.
 */
export function LinkEntryRows({
  entry,
  links,
  search,
  picks,
  onPick,
  onLinks,
  onSubmit,
}: {
  entry: LinkEntry;
  links: string[];
  search: string;
  picks: EntryPick[];
  onPick: (pick: EntryPick) => void;
  onLinks: (urls: string[]) => void;
  onSubmit: () => void;
}) {
  const typed = search.trim();
  if (!links.length) {
    const found = pastedUrls(typed);
    return (
      <CommandGroup>
        <CommandItem value="__links" disabled={!found.length} onSelect={() => onLinks(found)}>
          <ArrowRight className="size-4" />
          {found.length ? `Use ${plural(found.length, "link")}` : "Paste or type links"}
          <Kbd className="ml-auto">↵</Kbd>
        </CommandItem>
      </CommandGroup>
    );
  }
  const choice = entry.choice;
  const problem = entry.problem(links, picks);
  const submit = (
    <CommandGroup key="submit">
      <CommandItem value="__submit" disabled={!!problem} onSelect={onSubmit} className="font-medium">
        <ArrowRight className="size-4" />
        {entry.submitLabel(links.length)}
        {picks.length > 0 && <span className="min-w-0 truncate font-normal text-muted-foreground">· {picks.map((p) => p.label).join(", ")}</span>}
        <Kbd className="ml-auto">{typed ? "⌘↵" : "↵"}</Kbd>
      </CommandItem>
    </CommandGroup>
  );
  const lower = typed.toLocaleLowerCase();
  const exists = choice?.choices.some((c) => c.label.toLocaleLowerCase() === lower);
  const matching = choice?.choices.filter((c) => c.label.toLocaleLowerCase().includes(lower)) ?? [];
  const choices = choice && (matching.length > 0 || (typed && !exists)) && (
    <CommandGroup key="choices" heading={choice.heading}>
      {matching.map((c) => {
        const picked = picks.some((p) => p.id === c.id);
        return (
          <CommandItem key={c.id} value={`${c.label} ${c.id}`} onSelect={() => onPick({ id: c.id, label: c.label, icon: c.icon })}>
            {picked ? <Check className="size-4" /> : c.icon}
            <span className="min-w-0">
              <span className="block truncate">{c.label}</span>
              {c.description && <span className="block truncate text-2xs text-muted-foreground">{c.description}</span>}
            </span>
          </CommandItem>
        );
      })}
      {typed && !exists && (
        <CommandItem value={`__new ${typed}`} onSelect={() => onPick({ id: typed, label: typed, created: true })}>
          <Plus className="size-4" />
          {choice.newLabel(typed)}
        </CommandItem>
      )}
    </CommandGroup>
  );
  return typed ? [choices, submit] : [submit, choices];
}
