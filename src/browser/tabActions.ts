import { BookmarkPlus, ClipboardList, Copy, FolderInput, FolderMinus, Sparkles, XCircle } from "lucide-react";
import type { BrowserTab } from "@linklog/browser-protocol";
import { everyItem, splitBy, type SelectionAction } from "../bulkActions";
import { plural } from "../lib/format";

// Browser's counterpart of BULK_ACTIONS: the same surfaces (bar, chip, palette, drawer, keys) read it, so the
// availability rules for tabs live only here.

export type TabContext = {
  /** Another tab action is in flight. */
  busy: boolean;
  /** Why Jev-backed actions can't run (not configured), or null. */
  jevReason: string | null;
  /** Groups and pinned groups the tabs can move to. */
  destinations: number;
};

export type TabRunners = {
  save: (tabs: BrowserTab[]) => void;
  move: (tabs: BrowserTab[], destinationKey: string) => void;
  autogroup: (tabs: BrowserTab[]) => void;
  ungroup: (tabs: BrowserTab[]) => void;
  copy: (tabs: BrowserTab[], withTitles: boolean) => void;
  close: (tabs: BrowserTab[]) => void;
};

export type TabAction = SelectionAction<BrowserTab, TabRunners, TabContext>;

const BUSY = "Another tab action is running";
const grouped = (t: BrowserTab) => t.groupId !== null;

export const TAB_ACTIONS: TabAction[] = [
  {
    id: "save",
    label: "Save to Library",
    group: "Library",
    shortcut: "S",
    promoted: true,
    icon: BookmarkPlus,
    barLabel: (n) => `Save ${n}`,
    tileLabel: "Save",
    availability: (ts, ctx) => everyItem(ts, ctx.busy ? BUSY : null),
    run: (h, eligible) => h.save(eligible),
  },
  {
    id: "group",
    label: "Move to group",
    group: "Organize",
    shortcut: "G",
    picker: "group",
    promoted: true,
    icon: FolderInput,
    tileLabel: "Group",
    availability: (ts, ctx) => everyItem(ts, ctx.busy ? BUSY : null),
    run: (h, eligible, key) => {
      if (key) h.move(eligible, key);
    },
  },
  {
    id: "autogroup",
    label: "Autogroup",
    group: "Organize",
    shortcut: "A",
    promoted: true,
    icon: Sparkles,
    availability: (ts, ctx) => {
      const av = splitBy(ts, (t) => !grouped(t), "Already in a group", null);
      const blocked =
        ctx.jevReason ??
        (!ctx.destinations
          ? "Create or pin a group with a description first"
          : !av.eligible.length
            ? "Autogroup only places tabs that have no group"
            : ctx.busy
              ? BUSY
              : null);
      return { ...av, blocked };
    },
    partial: (n, total) => `${n} of ${total} already have a group and stay there`,
    run: (h, eligible) => h.autogroup(eligible),
  },
  {
    id: "ungroup",
    label: "Remove from group",
    group: "Organize",
    shortcut: "U",
    icon: FolderMinus,
    tileLabel: "Ungroup",
    availability: (ts, ctx) => {
      const av = splitBy(ts, grouped, "Not in a group", null);
      return { ...av, blocked: !av.eligible.length ? "None of these tabs is in a group" : ctx.busy ? BUSY : null };
    },
    partial: (n, total) => `${n} of ${total} aren't in a group`,
    run: (h, eligible) => h.ungroup(eligible),
  },
  {
    id: "copy",
    label: "Copy URLs",
    group: "Share",
    shortcut: "C",
    icon: Copy,
    availability: (ts) => everyItem(ts, null),
    run: (h, eligible) => h.copy(eligible, false),
  },
  {
    id: "copy-titles",
    label: "Copy URLs + titles",
    group: "Share",
    shortcut: "⇧C",
    icon: ClipboardList,
    availability: (ts) => everyItem(ts, null),
    run: (h, eligible) => h.copy(eligible, true),
  },
  {
    id: "close",
    label: "Close tabs",
    group: "Danger",
    icon: XCircle,
    barLabel: (n) => `Close ${plural(n, "tab")}`,
    availability: (ts, ctx) => everyItem(ts, ctx.busy ? BUSY : null),
    run: (h, eligible) => h.close(eligible),
  },
];
