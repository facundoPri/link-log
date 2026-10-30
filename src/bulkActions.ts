import { Copy, ExternalLink, FileText, ClipboardList, Sparkles, Telescope, type LucideIcon } from "lucide-react";
import { openLimitReason } from "./browser/openLinks";
import type { Batch, Link, Tag } from "./types";

// The only place that knows which selected links an action applies to. The desktop bar, the palette and the
// keyboard shortcuts all read it, so they cannot disagree. Adding an action is one entry in BULK_ACTIONS plus
// its runner in BulkRunners.

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

export type Availability = {
  eligible: Link[];
  skipped: { link: Link; reason: string }[];
  /** Why the action can't start at all; the UI disables it. */
  blocked: string | null;
};

export type BulkGroup = "Process" | "Organize" | "Share" | "Danger";
export const BULK_GROUPS: BulkGroup[] = ["Process", "Organize", "Share", "Danger"];

/** What a runner needs from the app; each call goes through the same code path as the matching button always did. */
export type BulkRunners = {
  autotag: () => void;
  lens: (lensId: string) => void;
  extract: () => void;
  copy: (links: Link[], withTitles: boolean) => void;
  open: (links: Link[]) => void;
};

export type BulkAction = {
  id: string;
  label: string;
  group: BulkGroup;
  /** Shown in a Kbd and matched against key presses: a letter, optionally prefixed with ⇧. */
  shortcut?: string;
  /** Needs a choice (a lens) before it runs; `run` then receives the chosen id as `detail`. */
  picker?: "lens";
  /** Shown as its own button in the desktop bar. */
  promoted?: boolean;
  icon: LucideIcon;
  /** The desktop bar's text when it should say more than `label`, e.g. "Open 3". */
  barLabel?: (eligible: number) => string;
  /** The mobile drawer tile's label when `label` is too long for a quarter of the row. */
  tileLabel?: string;
  availability: (links: Link[], ctx: BulkContext) => Availability;
  /** Tooltip/row text when only some of the links qualify. */
  partial?: (skipped: number, total: number) => string;
  run: (runners: BulkRunners, eligible: Link[], detail?: string) => void | Promise<void>;
};

// Jev runs on links with content or with an extraction on the way; the others are skipped (or, for auto-tag,
// extracted first when the user asks).
export const lacksContent = (l: Link) => !l.content_key && l.content_state !== "queued";

const everyLink = (links: Link[], blocked: string | null): Availability => ({
  eligible: links,
  skipped: [],
  blocked,
});

const needsContent = (links: Link[], reason: string, blocked: string | null): Availability => ({
  eligible: links.filter((l) => !lacksContent(l)),
  skipped: links.filter(lacksContent).map((link) => ({ link, reason })),
  blocked,
});

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
    availability: (ls, ctx) => everyLink(ls, ctx.running ? STILL_PROCESSING : null),
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
      everyLink(ls, ctx.openReason ?? openLimitReason(ls.length) ?? (ctx.opening ? "Opening links…" : null)),
    run: (h, eligible) => h.open(eligible),
  },
  {
    id: "copy",
    label: "Copy URLs",
    group: "Share",
    shortcut: "C",
    icon: Copy,
    availability: (ls) => everyLink(ls, null),
    run: (h, eligible) => h.copy(eligible, false),
  },
  {
    id: "copy-titles",
    label: "Copy URLs + titles",
    group: "Share",
    shortcut: "⇧C",
    icon: ClipboardList,
    availability: (ls) => everyLink(ls, null),
    run: (h, eligible) => h.copy(eligible, true),
  },
];

export const ACTION_GROUPS = BULK_GROUPS.map((group) => ({
  group,
  actions: BULK_ACTIONS.filter((a) => a.group === group),
})).filter((g) => g.actions.length);

export type ActionState = {
  action: BulkAction;
  availability: Availability;
  /** The action can't be started. */
  disabled: boolean;
  /** Why it is disabled, or what the skipped links mean; null when everything qualifies. */
  reason: string | null;
  /** "eligible/total" when only some links qualify. */
  badge: string | null;
};

export function actionState(action: BulkAction, selected: Link[], ctx: BulkContext): ActionState {
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

export const actionStates = (selected: Link[], ctx: BulkContext) =>
  BULK_ACTIONS.map((a) => actionState(a, selected, ctx));

type KeyLike = Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">;

/** The action a key press runs. Letters only: ⌘/Ctrl/Alt combinations belong to the app and the browser. */
export function actionForKey(e: KeyLike): BulkAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  return (
    BULK_ACTIONS.find((a) => {
      if (!a.shortcut) return false;
      const shift = a.shortcut.startsWith("⇧");
      return shift === e.shiftKey && a.shortcut.slice(shift ? 1 : 0).toLowerCase() === e.key.toLowerCase();
    }) ?? null
  );
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
