import { Copy, ExternalLink, FileText, ClipboardList, Sparkles, Telescope, type LucideIcon } from "lucide-react";
import { openLimitReason } from "./browser/openLinks";
import type { Batch, Link, Tag } from "./types";

// The only place that knows which selected links an action applies to. The desktop bar, the palette and the
// keyboard shortcuts all read it, so they cannot disagree. Adding an action is one entry in BULK_ACTIONS plus
// its runner in BulkRunners. Browser tabs have their own registry of the same shape (src/browser/tabActions.ts).

export type BulkContext = {
  tags: Tag[];
  /** Why Jev-backed actions can't run (not configured), or null. */
  jevReason: string | null;
  /** A batch submission is in flight. */
  running: boolean;
  /** Why the Linklog extension can't open tabs right now (missing, outdated, connecting), or null. */
  openReason: string | null;
  /** An open request is in flight. */
  opening: boolean;
};

export type Availability<T = Link> = {
  eligible: T[];
  skipped: { item: T; reason: string }[];
  /** Why the action can't start at all; the UI disables it. */
  blocked: string | null;
};

/** What the selection surfaces show and match keys against; the same for links and tabs. */
export type ActionMeta = {
  id: string;
  label: string;
  /** The palette's gutter heading; registries list actions in group order. "Danger" renders destructive. */
  group: string;
  /** Shown in a Kbd and matched against key presses: a letter, optionally prefixed with ⇧. */
  shortcut?: string;
  /** Needs a choice (a lens, a group) before it runs; `run` then receives the chosen id as `detail`. */
  picker?: string;
  /** Shown as its own button in the desktop bar. */
  promoted?: boolean;
  icon: LucideIcon;
  /** The desktop bar's text when it should say more than `label`, e.g. "Open 3". */
  barLabel?: (eligible: number) => string;
  /** The mobile drawer tile's label when `label` is too long for a quarter of the row. */
  tileLabel?: string;
};

export type SelectionAction<T, R, C> = ActionMeta & {
  availability: (items: T[], ctx: C) => Availability<T>;
  /** Tooltip/row text when only some of the items qualify. */
  partial?: (skipped: number, total: number) => string;
  run: (runners: R, eligible: T[], detail?: string) => void | Promise<void>;
};

/** What a runner needs from the app; each call goes through the same code path as the matching button always did. */
export type BulkRunners = {
  autotag: () => void;
  lens: (lensId: string) => void;
  extract: () => void;
  copy: (links: Link[], withTitles: boolean) => void;
  open: (links: Link[]) => void;
};

export type BulkAction = SelectionAction<Link, BulkRunners, BulkContext>;

// Jev runs on links with content or with an extraction on the way; the others are skipped (or, for auto-tag,
// extracted first when the user asks).
export const lacksContent = (l: Link) => !l.content_key && l.content_state !== "queued";

export const everyItem = <T>(items: T[], blocked: string | null): Availability<T> => ({
  eligible: items,
  skipped: [],
  blocked,
});

/** Items that pass `ok` are eligible; the rest are skipped with `reason`. */
export const splitBy = <T>(items: T[], ok: (item: T) => boolean, reason: string, blocked: string | null): Availability<T> => ({
  eligible: items.filter(ok),
  skipped: items.filter((i) => !ok(i)).map((item) => ({ item, reason })),
  blocked,
});

const needsContent = (links: Link[], reason: string, blocked: string | null) =>
  splitBy(links, (l) => !lacksContent(l), reason, blocked);

const STILL_PROCESSING = "Some links are still processing";
export const plural = (n: number) => (n === 1 ? "link" : "links");

export const BULK_ACTIONS: BulkAction[] = [
  {
    id: "autotag",
    label: "Auto-tag",
    group: "Process",
    shortcut: "T",
    promoted: true,
    icon: Sparkles,
    // With links lacking content it still starts: the confirm dialog offers to extract them first.
    availability: (ls, ctx) =>
      needsContent(
        ls,
        "No content yet",
        ctx.jevReason ?? (!ctx.tags.length ? "Create a tag first" : ctx.running ? STILL_PROCESSING : null),
      ),
    partial: (n, total) => `${n} of ${total} ${plural(total)} have no content yet`,
    run: (h) => h.autotag(),
  },
  {
    id: "lens",
    label: "Lens",
    group: "Process",
    shortcut: "L",
    picker: "lens",
    promoted: true,
    icon: Telescope,
    availability: (ls, ctx) => {
      const av = needsContent(ls, "Needs context first", ctx.jevReason);
      if (av.blocked) return av;
      if (!av.eligible.length && ls.length)
        return { ...av, blocked: `${ls.length} of ${ls.length} ${plural(ls.length)} need context first` };
      return ctx.running ? { ...av, blocked: STILL_PROCESSING } : av;
    },
    partial: (n, total) => `${n} of ${total} ${plural(total)} have no content and will be skipped`,
    run: (h, _eligible, lensId) => {
      if (lensId) h.lens(lensId);
    },
  },
  {
    id: "extract",
    label: "Extract context",
    group: "Process",
    shortcut: "E",
    icon: FileText,
    tileLabel: "Extract",
    availability: (ls, ctx) => everyItem(ls, ctx.running ? STILL_PROCESSING : null),
    run: (h) => h.extract(),
  },
  {
    id: "open",
    label: "Open",
    group: "Share",
    shortcut: "O",
    promoted: true,
    icon: ExternalLink,
    barLabel: (n) => `Open ${n}`,
    availability: (ls, ctx) =>
      everyItem(ls, ctx.openReason ?? openLimitReason(ls.length) ?? (ctx.opening ? "Opening links…" : null)),
    run: (h, eligible) => h.open(eligible),
  },
  {
    id: "copy",
    label: "Copy URLs",
    group: "Share",
    shortcut: "C",
    icon: Copy,
    availability: (ls) => everyItem(ls, null),
    run: (h, eligible) => h.copy(eligible, false),
  },
  {
    id: "copy-titles",
    label: "Copy URLs + titles",
    group: "Share",
    shortcut: "⇧C",
    icon: ClipboardList,
    availability: (ls) => everyItem(ls, null),
    run: (h, eligible) => h.copy(eligible, true),
  },
];

export type ActionState<T = unknown> = {
  action: ActionMeta;
  availability: Availability<T>;
  /** The action can't be started. */
  disabled: boolean;
  /** Why it is disabled, or what the skipped links mean; null when everything qualifies. */
  reason: string | null;
  /** "eligible/total" when only some links qualify. */
  badge: string | null;
};

export function actionState<T, C>(action: SelectionAction<T, never, C>, selected: T[], ctx: C): ActionState<T> {
  const availability = action.availability(selected, ctx);
  const { eligible, skipped, blocked } = availability;
  return {
    action,
    availability,
    disabled: !!blocked || !selected.length,
    reason: blocked ?? (skipped.length ? (action.partial?.(skipped.length, selected.length) ?? `${skipped.length} skipped`) : null),
    badge: !blocked && eligible.length < selected.length ? `${eligible.length}/${selected.length}` : null,
  };
}

export const actionStates = <T, C>(actions: SelectionAction<T, never, C>[], selected: T[], ctx: C) =>
  actions.map((a) => actionState(a, selected, ctx));

/** Runs an action by id on its eligible items, through the registry's runner. */
export const runAction =
  <T, R, C>(actions: SelectionAction<T, R, C>[], states: ActionState<T>[], runners: R) =>
  (id: string, detail?: string) => {
    const action = actions.find((a) => a.id === id);
    const state = states.find((s) => s.action.id === id);
    if (action && state) void action.run(runners, state.availability.eligible, detail);
  };

type KeyLike = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

/** The action a key press runs. Letters only: ⌘/Ctrl/Alt combinations belong to the app and the browser. */
export function actionForKey<A extends ActionMeta>(e: KeyLike, actions: A[]): A | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  return (
    actions.find((a) => {
      if (!a.shortcut) return false;
      const shift = a.shortcut.startsWith("⇧");
      return shift === e.shiftKey && a.shortcut.slice(shift ? 1 : 0).toLowerCase() === e.key.toLowerCase();
    }) ?? null
  );
}

export type KeyRoute<A> =
  /** Open the command palette (or the phone drawer), or close it when it is the open overlay. */
  | { kind: "palette" }
  /** ⌘K while another dialog or menu is open: swallowed, so the browser's own ⌘K doesn't fire either. */
  | { kind: "ignore" }
  | { kind: "action"; action: A };

export type KeyScene = {
  /** Items selected in the current view. */
  selected: number;
  paletteOpen: boolean;
  /** Focus is in a text field. */
  typing: boolean;
  /** A dialog, sheet, menu or listbox is open (the palette counts when it is open). */
  overlay: boolean;
};

/**
 * What one key press does on a selection surface. ⌘K is the only command key: it always opens the palette,
 * whatever the selection, and closes it again. Letters run selection actions only with a selection and
 * nothing else in the way.
 */
export function routeKey<A extends ActionMeta>(e: KeyLike & { repeat?: boolean }, actions: A[], scene: KeyScene): KeyRoute<A> | null {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k")
    return scene.overlay && !scene.paletteOpen ? { kind: "ignore" } : { kind: "palette" };
  if (!scene.selected || e.repeat || scene.typing || scene.overlay) return null;
  const action = actionForKey(e, actions);
  return action ? { kind: "action", action } : null;
}

const PROGRESS_VERB: Partial<Record<Batch["kind"], string>> = {
  extract: "Extracting",
  autotag: "Auto-tagging",
  lens: "Running lens",
};

export type BulkProgress = { label: string; done: number; total: number };

/** The run in progress among the batches started from the selection: the first kind that still has jobs, summed over its chunks. */
export function bulkProgress(batches: Batch[], started: ReadonlySet<string>): BulkProgress | null {
  const active = batches.filter((b) => started.has(b.id) && b.active > 0);
  const kind = active[0]?.kind;
  if (!kind) return null;
  const same = active.filter((b) => b.kind === kind);
  const total = same.reduce((n, b) => n + b.total, 0);
  const left = same.reduce((n, b) => n + b.active, 0);
  return { label: PROGRESS_VERB[kind] ?? "Working on", done: total - left, total };
}
