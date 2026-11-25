import { BookmarkPlus, ClipboardList, Copy, FolderInput, FolderMinus, Moon, Sparkles, SunMedium, XCircle } from "lucide-react";
import type { BrowserTab } from "@linklog/browser-protocol";
import { everyItem, splitBy, type SelectionAction } from "../bulkActions";
import { plural } from "../lib/format";
import { loadBlocked, SLEEP_WARNING, sleepBlocked } from "./sleeping";

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
  load: (tabs: BrowserTab[]) => void;
  sleep: (tabs: BrowserTab[]) => void;
  copy: (tabs: BrowserTab[], withTitles: boolean) => void;
  close: (tabs: BrowserTab[]) => void;
};

export type TabAction = SelectionAction<BrowserTab, TabRunners, TabContext>;

const BUSY = "Another tab action is running";
/** One reason shared by every skipped tab (e.g. no content access) says itself; mixed ones get `general`. */
const sharedReason = (skipped: { reason: string }[], general: string) => {
  const reasons = new Set(skipped.map((x) => x.reason));
  return reasons.size === 1 ? [...reasons][0]! : general;
};
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
      // Pinned tabs are never grouped: Chrome would unpin them.
      const eligible = ts.filter((t) => !grouped(t) && !t.pinned);
      const skipped = ts
        .filter((t) => grouped(t) || t.pinned)
        .map((item) => ({ item, reason: item.pinned ? "Pinned, stays in place" : "Already in a group" }));
      const blocked =
        ctx.jevReason ??
        (!ctx.destinations
          ? "Create or pin a group with a description first"
          : !ts.some((t) => !grouped(t))
            ? "Autogroup only places tabs that have no group"
            : !eligible.length
              ? "Pinned tabs are never grouped; they stay in place"
              : ctx.busy
                ? BUSY
                : null);
      return { eligible, skipped, blocked };
    },
    partial: (n, total) => `${n} of ${total} are pinned or already have a group, and stay there`,
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
    id: "load",
    label: "Load content",
    group: "Memory",
    icon: SunMedium,
    tileLabel: "Load",
    availability: (ts, ctx) => {
      const eligible = ts.filter((t) => !loadBlocked(t));
      const skipped = ts.filter((t) => loadBlocked(t)).map((item) => ({ item, reason: loadBlocked(item)! }));
      return { eligible, skipped, blocked: !eligible.length ? sharedReason(skipped, "None of the selected tabs is sleeping") : ctx.busy ? BUSY : null };
    },
    partial: (n, total) => `${n} of ${total} aren't sleeping or can't be read`,
    run: (h, eligible) => h.load(eligible),
  },
  {
    id: "sleep",
    label: "Put to sleep",
    group: "Memory",
    icon: Moon,
    tileLabel: "Sleep",
    hint: SLEEP_WARNING,
    availability: (ts, ctx) => {
      const eligible = ts.filter((t) => !sleepBlocked(t));
      const skipped = ts.filter((t) => sleepBlocked(t)).map((item) => ({ item, reason: sleepBlocked(item)! }));
      return {
        eligible,
        skipped,
        blocked: !eligible.length ? sharedReason(skipped, "Already asleep, active, playing audio or a browser page") : ctx.busy ? BUSY : null,
      };
    },
    partial: (n, total) => `${n} of ${total} are asleep, active, playing audio or a browser page`,
    run: (h, eligible) => h.sleep(eligible),
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
