import { useEffect, useEffectEvent, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { routeKey, type ActionMeta, type ActionState, type BulkProgress } from "../bulkActions";
import { BulkChip, BulkDock } from "./BulkBar";
import { BulkDrawer, BulkMobileBar } from "./BulkMobile";
import { BulkPalette } from "./BulkPalette";
import type { BulkResult } from "./BulkResults";
import { isInput, overlayOpen } from "../lib/overlay";
import { clipboardUrls } from "../url";

export type PickerChoice = { id: string; label: string; description?: string; icon: ReactNode };

/** The choices of a picker action (a lens, a group) and its "New …" entry. */
export type Picker = {
  placeholder: string;
  empty: string;
  choices: PickerChoice[];
  newLabel: string;
  onNew: () => void;
};

/** A palette row that doesn't act on the selection, such as Add links or Open links. */
export type PaletteCommand = {
  id: string;
  label: string;
  /** Says what the command does with the URLs, e.g. "Save to your Library". */
  description: string;
  icon: LucideIcon;
  shortcut?: string;
  /** Why it can't run; the row is disabled. */
  disabled?: string | null;
  /** The palette stays open, e.g. after Select all, to act on the new selection. */
  keepOpen?: boolean;
  onSelect: () => void;
};

export type SelectionNoun = "link" | "tab";

/** A tag or group picked for pasted links; `created` when it doesn't exist yet and is named by `label`. */
export type EntryPick = { id: string; label: string; icon?: ReactNode; created?: boolean };

/**
 * What pasted links do in a view: All links saves them with tags, Browser opens them as tabs, optionally in a
 * group. The palette's links page shows them, the choice and one primary row.
 */
export type LinkEntry = {
  /** The palette command that opens the links page, e.g. "Add links…". */
  command: Pick<PaletteCommand, "label" | "description" | "icon" | "disabled">;
  /** The primary row: "Save 2 links", "Open 2 tabs". */
  submitLabel: (count: number) => string;
  /** What happens to the links, said under them. */
  note: string;
  /** Why these links can't go through now, or null. */
  problem: (urls: string[], picks: EntryPick[]) => string | null;
  /** Tags (several) or a group (one); null when the view can't offer one right now. */
  choice: {
    heading: string;
    multiple: boolean;
    placeholder: string;
    choices: PickerChoice[];
    newLabel: (name: string) => string;
  } | null;
  /** Said instead of the choice, e.g. why grouping isn't available. */
  hint?: string | null;
  onSubmit: (urls: string[], picks: EntryPick[]) => void;
};

/** Opens the palette's links page from outside the surface: a toolbar button, a drop. */
export type SurfaceHandle = { enterLinks: (urls?: string[]) => void };

export const LINKS_PAGE = "links";

const NO_RESULTS: BulkResult[] = [];

/**
 * The selection surface of a view: the desktop bar, the narrow chip or the phone bar and drawer, the command
 * palette, and the keys. Library and Browser render the same one with their own registry, so ⌘K and the action
 * keys have exactly one handler per view.
 */
export function SelectionSurface({
  noun,
  narrow,
  mobile,
  selected,
  visibleCount,
  allVisibleSelected,
  states,
  commands,
  picker,
  progress = null,
  results = NO_RESULTS,
  onRun,
  onSelectAll,
  onClear,
  onSelectFailed = () => {},
  onDismissResult = () => {},
  entry,
  ref,
}: {
  noun: SelectionNoun;
  narrow: boolean;
  mobile: boolean;
  selected: number;
  visibleCount: number;
  allVisibleSelected: boolean;
  states: ActionState[];
  commands: PaletteCommand[];
  picker: (id: string) => Picker | null;
  progress?: BulkProgress | null;
  results?: BulkResult[];
  /** Runs an action on its eligible items; availability and pickers were already handled here. */
  onRun: (id: string, detail?: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onSelectFailed?: (result: BulkResult) => void;
  onDismissResult?: (result: BulkResult) => void;
  entry: LinkEntry;
  ref?: Ref<SurfaceHandle>;
}) {
  const [palette, setPalette] = useState<{ page: string | null; links?: string[] } | null>(null);
  const page = states.find((s) => s.action.id === palette?.page)?.action ?? null;
  const links = palette?.page === LINKS_PAGE ? (palette.links ?? []) : null;
  // The links page needs the palette's input, so it replaces the drawer on phones too.
  const drawer = mobile && selected > 0 && !links;

  const enterLinks = (urls: string[] = []) =>
    setPalette((p) => ({ page: LINKS_PAGE, links: [...new Set([...(p?.page === LINKS_PAGE ? (p.links ?? []) : []), ...urls])] }));
  useImperativeHandle(ref, () => ({ enterLinks }));

  // The drawer only exists with a selection; the palette opened without one stays open when rows get picked. The
  // links page doesn't depend on the selection, so a tab closing in Chrome doesn't take the pasted links with it.
  useEffect(() => {
    if (!selected) setPalette((p) => (p?.page === LINKS_PAGE ? p : null));
  }, [selected]);

  const invoke = (action: ActionMeta, detail?: string) => {
    const state = states.find((s) => s.action.id === action.id);
    if (!state) return;
    if (state.disabled) {
      toast(state.reason ?? `${action.label} isn't available`);
      return;
    }
    if (action.picker && detail === undefined) {
      setPalette({ page: action.id });
      return;
    }
    setPalette(null);
    onRun(action.id, detail);
  };
  const entryCommand: PaletteCommand = { id: LINKS_PAGE, ...entry.command, keepOpen: true, onSelect: () => enterLinks() };
  const allCommands = [entryCommand, ...commands];
  const runCommand = (c: PaletteCommand) => {
    if (!c.keepOpen) setPalette(null);
    c.onSelect();
  };

  // One listener for the surface's lifetime; the event reads the latest state.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const route = routeKey(e, states.map((s) => s.action), {
      selected,
      paletteOpen: !!palette,
      typing: isInput(e.target),
      overlay: overlayOpen(),
    });
    if (!route) return;
    e.preventDefault();
    if (route.kind === "palette") setPalette((p) => (p ? null : { page: null }));
    else if (route.kind === "action") invoke(route.action);
  });
  // Links pasted outside a field open the links page with them; inside the palette its input takes the paste.
  const onPaste = useEffectEvent((e: ClipboardEvent) => {
    if (isInput(e.target) || overlayOpen() || !e.clipboardData) return;
    const urls = clipboardUrls(e.clipboardData);
    if (urls.length) {
      e.preventDefault();
      enterLinks(urls);
    } else if (/https?:\/\//i.test(e.clipboardData.getData("text/plain"))) {
      toast.error("Couldn't read this link list", { description: "Use one URL per line, or copy links with their titles." });
    }
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey(e);
    const paste = (e: ClipboardEvent) => onPaste(e);
    window.addEventListener("keydown", key);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", paste);
    };
  }, []);

  const openPalette = () => setPalette({ page: null });
  const pick = page?.picker ? picker(page.picker) : null;
  const withNew = (p: Picker): Picker => ({
    ...p,
    onNew: () => {
      setPalette(null);
      p.onNew();
    },
  });
  const pageProps = {
    page,
    picker: pick && withNew(pick),
    onPage: (a: ActionMeta | null) => setPalette({ page: a?.id ?? null }),
  };

  return (
    <>
      {!narrow && (
        <BulkDock
          noun={noun}
          selected={selected}
          visibleCount={visibleCount}
          states={states}
          progress={progress}
          results={results}
          onInvoke={invoke}
          onSelectAll={onSelectAll}
          onClear={onClear}
          onOpenPalette={openPalette}
          onSelectFailed={onSelectFailed}
          onDismissResult={onDismissResult}
        />
      )}
      {narrow && !mobile && (
        <BulkChip
          noun={noun}
          selected={selected}
          progress={progress}
          results={results}
          onOpenPalette={openPalette}
          onClear={onClear}
          onSelectFailed={onSelectFailed}
          onDismissResult={onDismissResult}
        />
      )}
      {mobile && (
        <BulkMobileBar
          noun={noun}
          selected={selected}
          visibleCount={visibleCount}
          allVisibleSelected={allVisibleSelected}
          progress={progress}
          results={results}
          onSelectAll={onSelectAll}
          onClear={onClear}
          onOpenDrawer={openPalette}
          onSelectFailed={onSelectFailed}
          onDismissResult={onDismissResult}
        />
      )}
      {drawer ? (
        <BulkDrawer
          open={!!palette}
          onOpenChange={(o) => !o && setPalette(null)}
          {...pageProps}
          noun={noun}
          selected={selected}
          visibleCount={visibleCount}
          allVisibleSelected={allVisibleSelected}
          states={states}
          // The drawer's header has its own Select all.
          commands={allCommands.filter((c) => c.id !== "select-all")}
          onInvoke={invoke}
          onCommand={runCommand}
          onSelectAll={onSelectAll}
        />
      ) : (
        <BulkPalette
          open={!!palette}
          onOpenChange={(o) => !o && setPalette(null)}
          {...pageProps}
          noun={noun}
          selected={selected}
          states={states}
          commands={allCommands}
          onInvoke={invoke}
          onCommand={runCommand}
          entry={entry}
          links={links}
          onLinks={enterLinks}
          onSubmitLinks={(urls, picks) => {
            setPalette(null);
            entry.onSubmit(urls, picks);
          }}
        />
      )}
    </>
  );
}
