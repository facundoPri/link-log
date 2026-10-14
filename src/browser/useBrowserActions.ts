import { useState } from "react";
import { toast } from "sonner";
import {
  BROWSER_LIMITS,
  chunk,
  chunkByBytes,
  jsonBytes,
  stableHash,
  toEvaluationTarget,
  type BrowserTab,
  type EvaluationRequest,
  type EvaluationTarget,
  type ItemResult,
  type MoveTarget,
  type PinnedGroup,
  type SaveResult,
  type TabRef,
} from "@linklog/browser-protocol";
import type { Lens, Library } from "../types";
import { call, evaluationStatus, postEvaluation } from "./api";
import type { BrowserWorkspace, Destination } from "./useBrowserWorkspace";
import type { GroupDraft } from "../components/browser/GroupDialog";
import { groupTitle } from "../components/browser/groups";

/** The tab as the page saw it: commands refuse it if it navigated since. */
const ref = (t: BrowserTab): TabRef => ({ tabId: t.tabId, tabInstanceId: t.tabInstanceId, documentRevision: t.documentRevision });
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type Suggestion = { key: string | null; confidence: number | null; error?: string };
export type AutogroupResult = { suggestions: Map<number, Suggestion>; catalogVersion: string };

export type GroupDialogState = { mode: "create"; tabs: BrowserTab[] } | { mode: "edit"; destination: Destination };

/** At most one Browser dialog is open at a time. */
export type BrowserDialog =
  | { kind: "group"; state: GroupDialogState }
  | { kind: "move"; tabs: BrowserTab[] }
  | { kind: "close"; tabs: BrowserTab[] }
  | { kind: "unpin"; destination: Destination }
  | { kind: "clean"; lens: Lens }
  /** `run` starts on the click that opens the dialog, so it runs exactly once per action. */
  | { kind: "autogroup"; tabs: BrowserTab[]; run: Promise<AutogroupResult> };

function summarize(items: ItemResult[], verb: string) {
  const ok = items.filter((i) => i.ok).length;
  const failed = items.filter((i) => !i.ok);
  if (!failed.length) toast.success(`${verb} ${plural(ok, "tab")}`);
  else
    toast[ok ? "success" : "error"](`${verb} ${ok} of ${plural(items.length, "tab")}`, {
      description: [...new Set(failed.map((f) => f.error))].join(" "),
    });
}

const FINAL_STATES = ["done", "failed", "expired", "acked"];

/** Browser actions shared by the sidebar, rows, selection bar and inspector; dialogs render in <BrowserDialogs>. */
export function useBrowserActions(ws: BrowserWorkspace, setLibrary: (l: Library) => void, clearPicked: (tabIds?: number[]) => void) {
  const { request, catalog, hello } = ws.browser;
  const [dialog, setDialog] = useState<BrowserDialog | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createPinned = async (draft: Omit<GroupDraft, "pinned">): Promise<PinnedGroup> => {
    const id = crypto.randomUUID();
    const { status, data } = await call<{ groups: PinnedGroup[] }>("/browser/groups", "POST", { id, name: draft.name, description: draft.description, color: draft.color });
    if (status >= 400) throw new Error((data as { error?: string }).error || "Could not pin the group.");
    await ws.browser.refreshCatalog();
    return data.groups.find((g) => g.id === id)!;
  };

  const unpin = async (pinnedId: string) => {
    const { status, data } = await call(`/browser/groups/${pinnedId}`, "DELETE", {});
    if (status >= 400) throw new Error(data.error || "Could not unpin the group.");
    await request("unbindPinned", { pinnedId });
    await ws.browser.refreshCatalog();
  };

  const moveTarget = (d: Destination): MoveTarget =>
    d.kind === "group"
      ? { kind: "group", groupId: d.group.groupId }
      : { kind: "pinned", pinnedId: d.pinned.id, title: d.pinned.name, color: d.pinned.color, description: d.pinned.description };

  const catalogVersion = (dests: Destination[]) =>
    stableHash(
      JSON.stringify(
        dests.map((d) => (d.kind === "group" ? [d.key, d.group.title, d.group.description, d.pinned?.description] : [d.key, d.pinned.name, d.pinned.description])),
      ),
    );

  /**
   * Reads the tabs, then asks Jev in as many requests as the per-request target limit and
   * the body size allow (one Activity batch per request), and merges the suggestions.
   */
  const suggest = async (tabs: BrowserTab[]): Promise<AutogroupResult> => {
    if (!catalog || !hello) throw new Error("Connect the extension first.");
    const dests = ws.destinations.slice(0, BROWSER_LIMITS.maxDestinations);
    const version = catalogVersion(dests);
    const suggestions = new Map<number, Suggestion>();
    const byKey = new Map<string, BrowserTab>();
    const targets: EvaluationTarget[] = [];
    for (const part of chunk(tabs, BROWSER_LIMITS.maxTargets)) {
      const { captures } = await request("capture", { tabs: part.map(ref) }, 120_000);
      for (const c of captures) {
        const tab = part.find((t) => t.tabId === c.tabId)!;
        if (!c.capture) {
          suggestions.set(c.tabId, { key: null, confidence: null, error: `Couldn't read this tab: ${c.error ?? "unknown error"}` });
          continue;
        }
        const targetKey = `tab~${tab.tabInstanceId}`;
        byKey.set(targetKey, tab);
        targets.push(toEvaluationTarget({ targetKey, url: tab.url, title: tab.title, capture: c.capture }));
      }
    }
    if (!targets.length) return { suggestions, catalogVersion: version };
    const base = {
      kind: "autogroup" as const,
      libraryId: catalog.libraryId,
      sessionId: hello.browserSessionId,
      catalogVersion: version,
      destinations: dests.map((d) =>
        d.kind === "group"
          ? { key: d.key, name: groupTitle(d.group.title), description: d.group.description || d.pinned?.description || "" }
          : { key: d.key, name: d.pinned.name, description: d.pinned.description },
      ),
    };
    const requestIds: string[] = [];
    const parts = chunkByBytes(targets, {
      maxItems: BROWSER_LIMITS.maxTargets,
      maxBytes: BROWSER_LIMITS.maxRequestBytes,
      overhead: jsonBytes({ ...base, requestId: crypto.randomUUID(), targets: [] }),
    });
    for (const part of parts) {
      const body: EvaluationRequest = { ...base, requestId: crypto.randomUUID(), targets: part };
      const { status, data } = await postEvaluation(body);
      if (status >= 400) throw new Error(data.error || "Autogroup failed.");
      requestIds.push(body.requestId);
    }
    const open = new Set(requestIds);
    for (let i = 0; i < 180 && open.size; i++) {
      for (const requestId of [...open]) {
        const res = await evaluationStatus(requestId);
        if (res.status !== 200 || !res.data.targets.every((t) => FINAL_STATES.includes(t.state))) continue;
        for (const t of res.data.targets) {
          const tab = byKey.get(t.targetKey)!;
          if (t.state === "done" && t.answer?.type === "choice")
            suggestions.set(tab.tabId, { key: t.answer.choice === "none" ? null : t.answer.choice, confidence: t.answer.confidence });
          else suggestions.set(tab.tabId, { key: null, confidence: null, error: t.error ?? "No suggestion." });
        }
        await call(`/browser/evaluations/${requestId}/ack`, "POST", { targetKeys: res.data.targets.map((t) => t.targetKey) }).catch(() => {});
        open.delete(requestId);
      }
      if (open.size) await new Promise((r) => setTimeout(r, 1000));
    }
    if (open.size) throw new Error("Autogroup is taking too long. Check Activity.");
    return { suggestions, catalogVersion: version };
  };

  const actions = {
    busy,
    focus: (tab: BrowserTab) => void request("focusTab", { tab: ref(tab) }).catch((e) => toast.error(e.message)),
    copy: (tab: BrowserTab) => void navigator.clipboard.writeText(tab.url).then(() => toast("URL copied")),
    /** Same as adding the links in All links: the library fetches and extracts them. */
    save: (tabs: BrowserTab[]) =>
      guard(async () => {
        const results: SaveResult[] = [];
        const urls = [...new Set(tabs.map((t) => t.url))];
        const sendable = urls.filter((url) => {
          if (url.length <= BROWSER_LIMITS.maxUrlChars) return true;
          results.push({ url, status: "rejected", error: "The URL is too long to save." });
          return false;
        });
        const parts = chunkByBytes(sendable, { maxItems: BROWSER_LIMITS.maxSaveItems, maxBytes: BROWSER_LIMITS.maxRequestBytes, overhead: 16 });
        for (const part of parts) {
          const { status, data } = await call<Library & { results: SaveResult[] }>("/browser/save", "POST", { urls: part });
          if (status >= 400) throw new Error(data.error || "Could not save.");
          results.push(...data.results);
          const { results: _r, ...lib } = data;
          setLibrary(lib);
        }
        const created = results.filter((r) => r.status === "created").length;
        const dup = results.filter((r) => r.status === "duplicate").length;
        const rejected = results.filter((r) => r.status === "rejected");
        const summary = [created && `${plural(created, "link")} saved`, dup && `${plural(dup, "link")} moved to the top`, rejected.length && `${rejected.length} can't be saved`].filter(Boolean);
        toast[created || dup ? "success" : "error"](summary.join(" · ") || "Nothing saved", {
          description: rejected.length
            ? [...new Set(rejected.map((r) => r.error))].join(" ")
            : created
              ? "Fetching titles and content…"
              : undefined,
        });
      }),
    requestClose: (tabs: BrowserTab[]) => setDialog({ kind: "close", tabs }),
    move: (tabs: BrowserTab[], d: Destination) =>
      guard(async () => {
        const { items } = await request("moveToGroup", { tabs: tabs.map(ref), target: moveTarget(d) });
        summarize(items, "Moved");
      }),
    chooseMove: (tabs: BrowserTab[]) => setDialog({ kind: "move", tabs }),
    ungroup: (tabs: BrowserTab[]) =>
      guard(async () => {
        const { items } = await request("ungroup", { tabs: tabs.filter((t) => t.groupId !== null).map(ref) });
        summarize(items, "Ungrouped");
      }),
    ungroupAll: (groupId: number) => actions.ungroup(ws.tabs.filter((t) => t.groupId === groupId)),
    newGroup: (tabs: BrowserTab[]) => setDialog({ kind: "group", state: { mode: "create", tabs } }),
    editDestination: (destination: Destination) => setDialog({ kind: "group", state: { mode: "edit", destination } }),
    togglePin: (d: Destination) => {
      if (d.kind === "pinned" || d.pinned) {
        setDialog({ kind: "unpin", destination: d });
        return;
      }
      void guard(async () => {
        const pinned = await createPinned({ name: groupTitle(d.group.title), description: d.group.description, color: d.group.color });
        await request("updateGroup", { groupId: d.group.groupId, pinnedId: pinned.id });
        toast.success(`Pinned “${pinned.name}”`, { description: "Available in every window connected to this library." });
      });
    },
    autogroup: (tabs: BrowserTab[]) => {
      const ungrouped = tabs.filter((t) => t.groupId === null);
      if (!ws.destinations.length) toast.error("Create or pin a group with a description first.");
      else if (!ungrouped.length) toast("Autogroup only places tabs that have no group.");
      else {
        const run = suggest(ungrouped);
        run.catch(() => {}); // the dialog shows the error
        setDialog({ kind: "autogroup", tabs: ungrouped, run });
      }
    },
    requestClean: (lens: Lens) => setDialog({ kind: "clean", lens }),
    /** Re-evaluate: every given tab (default: the window) once, even if it has an answer. */
    reevaluate: (lens: Lens, tabs?: BrowserTab[]) =>
      void ws.runner
        .evaluate(lens, (tabs ?? ws.tabs).map((t) => t.tabInstanceId))
        .catch((e) => toast.error((e as Error).message)),
    evaluateMetadata: (lens: Lens, tab: BrowserTab) =>
      void ws.runner.evaluate(lens, [tab.tabInstanceId], "metadata").catch((e) => toast.error((e as Error).message)),
  };

  /** What the dialogs do once confirmed. */
  const ops = {
    close: () => setDialog(null),
    guard,
    move: actions.move,
    ungroup: actions.ungroup,
    newGroup: actions.newGroup,
    createGroup: async (draft: GroupDraft, tabs: BrowserTab[]) => {
      if (!tabs.length) {
        await createPinned(draft);
        toast.success(`Pinned “${draft.name}”`);
        return;
      }
      const pinned = draft.pinned ? await createPinned(draft) : null;
      const { items } = await request("moveToGroup", {
        tabs: tabs.map(ref),
        target: pinned
          ? { kind: "pinned", pinnedId: pinned.id, title: draft.name, color: draft.color, description: draft.description }
          : { kind: "new", title: draft.name, color: draft.color, description: draft.description },
      });
      summarize(items, "Grouped");
      clearPicked(tabs.map((t) => t.tabId));
    },
    editGroup: async (draft: GroupDraft, d: Destination) => {
      const pinnedId = d.kind === "pinned" ? d.pinned.id : d.pinned?.id ?? null;
      if (d.kind === "group")
        await request("updateGroup", { groupId: d.group.groupId, title: draft.name, color: draft.color, description: draft.description });
      if (pinnedId && draft.pinned) {
        // Shared description; name and color are defaults for future destinations.
        const { status, data } = await call(`/browser/groups/${pinnedId}`, "PATCH", { name: draft.name, description: draft.description, color: draft.color });
        if (status >= 400) throw new Error(data.error || "Could not update the pinned group.");
        await ws.browser.refreshCatalog();
      } else if (pinnedId && !draft.pinned) await unpin(pinnedId);
      else if (!pinnedId && draft.pinned && d.kind === "group") {
        const pinned = await createPinned(draft);
        await request("updateGroup", { groupId: d.group.groupId, pinnedId: pinned.id });
      }
    },
    closeTabs: (tabs: BrowserTab[]) =>
      guard(async () => {
        const { items } = await request("closeTabs", { tabs: tabs.map((t) => ({ ...ref(t), url: t.url })) });
        summarize(items, "Closed");
        clearPicked(items.filter((i) => i.ok).map((i) => i.tabId));
      }),
    unpin: (d: Destination) =>
      guard(async () => {
        await unpin(d.kind === "pinned" ? d.pinned.id : d.pinned!.id);
        toast.success("Unpinned");
      }),
    clean: (lens: Lens) => {
      ws.deactivate([lens.id]);
      return guard(async () => {
        const removed = await ws.runner.clean([lens.id]);
        toast.success(`Cleaned ${plural(removed, "result")}`);
      });
    },
    applyAutogroup: async (assignments: { tab: BrowserTab; key: string }[], version: string) => {
      if (catalogVersion(ws.destinations.slice(0, BROWSER_LIMITS.maxDestinations)) !== version)
        toast("Groups changed while Jev was working", { description: "Suggestions still apply only to groups that exist now." });
      const byKey = new Map<string, BrowserTab[]>();
      for (const a of assignments) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a.tab]);
      let moved = 0,
        kept = 0,
        missing = 0;
      for (const [key, tabs] of byKey) {
        const d = ws.destinations.find((x) => x.key === key);
        if (!d) {
          missing += tabs.length;
          continue;
        }
        // Revalidated in the extension: a tab grouped meanwhile stays where it is.
        const { items } = await request("moveToGroup", { tabs: tabs.map(ref), target: moveTarget(d), onlyIfUngrouped: true });
        moved += items.filter((i) => i.ok).length;
        kept += items.filter((i) => !i.ok).length;
      }
      toast.success(`Grouped ${plural(moved, "tab")}`, {
        description: [kept && `${kept} kept in the group they have now`, missing && `${missing} skipped: their group is gone`].filter(Boolean).join(" · ") || undefined,
      });
      clearPicked(assignments.map((a) => a.tab.tabId));
    },
  };

  return { actions, dialog, ops };
}

export type BrowserActions = ReturnType<typeof useBrowserActions>;
