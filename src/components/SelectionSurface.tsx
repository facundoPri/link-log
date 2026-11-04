import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { routeKey, type ActionMeta, type ActionState, type BulkProgress } from "../bulkActions";
import { BulkChip, BulkDock } from "./BulkBar";
import { BulkDrawer, BulkMobileBar } from "./BulkMobile";
import { BulkPalette } from "./BulkPalette";
import type { BulkResult } from "./BulkResults";
import { overlayOpen } from "../lib/overlay";

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

const NO_RESULTS: BulkResult[] = [];

function isInput(target: EventTarget | null) {
  return target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]');
}

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
}) {
  const [palette, setPalette] = useState<{ page: string | null } | null>(null);
  const page = states.find((s) => s.action.id === palette?.page)?.action ?? null;
  const drawer = mobile && selected > 0;

  // The drawer only exists with a selection; the palette opened without one stays open when rows get picked.
  useEffect(() => {
    if (!selected) setPalette(null);
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
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
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
          onInvoke={invoke}
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
          commands={commands}
          onInvoke={invoke}
          onCommand={runCommand}
        />
      )}
    </>
  );
}
