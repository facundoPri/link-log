import { useState } from "react";
import { toast } from "sonner";
import {
  BROWSER_LIMITS,
  stableHash,
  type BrowserGroup,
  type BrowserTab,
  type Capture,
  type EvaluationCapture,
  type ItemResult,
  type MoveTarget,
  type PinnedGroup,
  type SaveResult,
  type TabRef,
} from "@linklog/browser-protocol";
import type { Lens, Library } from "../types";
import { call, evaluationStatus, evaluationTargets, postEvaluation } from "./api";
import type { BrowserWorkspace, Destination } from "./useBrowserWorkspace";
import { GroupDialog, type GroupDraft } from "../components/browser/GroupDialog";
import { AutogroupDialog, type Suggestion } from "../components/browser/AutogroupDialog";
import { GroupPicker } from "../components/browser/GroupPicker";
import { groupTitle } from "../components/browser/groups";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const ref = (t: BrowserTab): TabRef => ({ tabId: t.tabId, tabInstanceId: t.tabInstanceId });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function captureBody(c: Capture): EvaluationCapture {
  return evaluationTargets([{ targetKey: "x", tabId: 0, tabInstanceId: "x", documentRevision: 0, generation: 0, url: c.url, title: c.title, capture: c }])[0]!.capture;
}

function summarize(items: ItemResult[], verb: string) {
  const ok = items.filter((i) => i.ok).length;
  const failed = items.filter((i) => !i.ok);
  if (!failed.length) toast.success(`${verb} ${plural(ok, "tab")}`);
  else
    toast[ok ? "success" : "error"](`${verb} ${ok} of ${plural(items.length, "tab")}`, {
      description: [...new Set(failed.map((f) => f.error))].join(" "),
    });
}

type GroupDialogState =
  | { mode: "create"; tabs: BrowserTab[] }
  | { mode: "edit"; destination: Destination };

/** Browser actions shared by the sidebar, rows and selection bar, plus their dialogs. */
export function useBrowserActions(ws: BrowserWorkspace, setLibrary: (l: Library) => void, clearPicked: (tabIds?: number[]) => void) {
  const { request, catalog, hello, setCatalog } = ws.browser;
  const [groupDialog, setGroupDialog] = useState<GroupDialogState | null>(null);
  const [moveFor, setMoveFor] = useState<BrowserTab[] | null>(null);
  const [closeFor, setCloseFor] = useState<BrowserTab[] | null>(null);
  const [unpinFor, setUnpinFor] = useState<Destination | null>(null);
  const [cleanFor, setCleanFor] = useState<Lens | null>(null);
  const [autogroupFor, setAutogroupFor] = useState<BrowserTab[] | null>(null);
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

  const actions = {
    busy,
    focus: (tab: BrowserTab) => void request("focusTab", { tab: ref(tab) }).catch((e) => toast.error(e.message)),
    copy: (tab: BrowserTab) => void navigator.clipboard.writeText(tab.url).then(() => toast("URL copied")),
    save: (tabs: BrowserTab[]) =>
      guard(async () => {
        // Content read locally is saved with the link; no remote extraction is started.
        const readable = tabs.filter((t) => t.content === "available");
        const captures = readable.length ? (await request("capture", { tabs: readable.map(ref) }, 120_000)).captures : [];
        const byTab = new Map(captures.map((c) => [c.tabId, c.capture]));
        const items = tabs.map((t) => ({
          key: String(t.tabId),
          url: t.url,
          title: t.title,
          favicon: t.favIconUrl && /^https?:/.test(t.favIconUrl) ? t.favIconUrl : null,
          image: byTab.get(t.tabId)?.image || null,
          capture: byTab.get(t.tabId) ? captureBody(byTab.get(t.tabId)!) : undefined,
        }));
        const results: SaveResult[] = [];
        for (let i = 0; i < items.length; i += BROWSER_LIMITS.maxSaveItems) {
          const { status, data } = await call<Library & { results: SaveResult[] }>("/browser/save", "POST", {
            items: items.slice(i, i + BROWSER_LIMITS.maxSaveItems),
          });
          if (status >= 400) throw new Error(data.error || "Could not save.");
          results.push(...data.results);
          const { results: _r, ...lib } = data;
          setLibrary(lib);
        }
        const created = results.filter((r) => r.status === "created").length;
        const dup = results.filter((r) => r.status === "duplicate").length;
        const rejected = results.filter((r) => r.status === "rejected");
        const parts = [created && `${plural(created, "link")} saved`, dup && `${dup} already in your library`, rejected.length && `${rejected.length} can't be saved`].filter(Boolean);
        toast[created || dup ? "success" : "error"](parts.join(" · ") || "Nothing saved", {
          description: rejected.length ? [...new Set(rejected.map((r) => r.error))].join(" ") : undefined,
        });
      }),
    requestClose: (tabs: BrowserTab[]) => setCloseFor(tabs),
    move: (tabs: BrowserTab[], d: Destination) =>
      guard(async () => {
        const { items } = await request("moveToGroup", { tabs: tabs.map(ref), target: moveTarget(d) });
        summarize(items, "Moved");
      }),
    chooseMove: (tabs: BrowserTab[]) => setMoveFor(tabs),
    ungroup: (tabs: BrowserTab[]) =>
      guard(async () => {
        const { items } = await request("ungroup", { tabs: tabs.filter((t) => t.groupId !== null).map(ref) });
        summarize(items, "Ungrouped");
      }),
    ungroupAll: (groupId: number) => actions.ungroup(ws.tabs.filter((t) => t.groupId === groupId)),
    newGroup: (tabs: BrowserTab[]) => setGroupDialog({ mode: "create", tabs }),
    editDestination: (destination: Destination) => setGroupDialog({ mode: "edit", destination }),
    togglePin: (d: Destination) => {
      if (d.kind === "pinned" || d.pinned) {
        setUnpinFor(d);
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
      else setAutogroupFor(ungrouped);
    },
    requestClean: (lens: Lens) => setCleanFor(lens),
    reevaluate: (lens: Lens, tabs?: BrowserTab[]) =>
      void ws.runner
        .evaluate(lens, (tabs ?? ws.tabs).map((t) => t.tabInstanceId))
        .catch((e) => toast.error((e as Error).message)),
    evaluateMetadata: (lens: Lens, tab: BrowserTab) =>
      void ws.runner.evaluate(lens, [tab.tabInstanceId], "metadata").catch((e) => toast.error((e as Error).message)),
  };

  const catalogVersion = (dests: Destination[]) =>
    stableHash(
      JSON.stringify(
        dests.map((d) => (d.kind === "group" ? [d.key, d.group.title, d.group.description, d.pinned?.description] : [d.key, d.pinned.name, d.pinned.description])),
      ),
    );

  const suggest = async (tabs: BrowserTab[]) => {
    if (!catalog || !hello) throw new Error("Connect the extension first.");
    const dests = ws.destinations.slice(0, BROWSER_LIMITS.maxDestinations);
    const version = catalogVersion(dests);
    const { captures } = await request("capture", { tabs: tabs.map(ref) }, 120_000);
    const suggestions = new Map<number, Suggestion>();
    const readable = captures.flatMap((c) => {
      const tab = tabs.find((t) => t.tabId === c.tabId)!;
      if (!c.capture) {
        suggestions.set(c.tabId, { key: null, confidence: null, error: `Couldn't read this tab: ${c.error ?? "unknown error"}` });
        return [];
      }
      return [{ tab, capture: c.capture }];
    });
    if (!readable.length) return { suggestions, catalogVersion: version };
    const requestId = crypto.randomUUID();
    const byKey = new Map(readable.map((r) => [`tab~${r.tab.tabInstanceId}`, r.tab]));
    const { status, data } = await postEvaluation({
      kind: "autogroup",
      requestId,
      libraryId: catalog.libraryId,
      sessionId: hello.browserSessionId,
      catalogVersion: version,
      destinations: dests.map((d) =>
        d.kind === "group"
          ? { key: d.key, name: groupTitle(d.group.title), description: d.group.description || d.pinned?.description || "" }
          : { key: d.key, name: d.pinned.name, description: d.pinned.description },
      ),
      targets: evaluationTargets(
        readable.map((r) => ({ targetKey: `tab~${r.tab.tabInstanceId}`, tabId: r.tab.tabId, tabInstanceId: r.tab.tabInstanceId, documentRevision: 0, generation: 0, url: r.tab.url, title: r.tab.title, capture: r.capture })),
      ),
    });
    if (status >= 400) throw new Error(data.error || "Autogroup failed.");
    for (let i = 0; i < 180; i++) {
      const res = await evaluationStatus(requestId);
      if (res.status === 200 && res.data.targets.every((t) => ["done", "failed", "expired", "acked"].includes(t.state))) {
        for (const t of res.data.targets) {
          const tab = byKey.get(t.targetKey)!;
          if (t.state === "done" && t.answer?.type === "choice")
            suggestions.set(tab.tabId, { key: t.answer.choice === "none" ? null : t.answer.choice, confidence: t.answer.confidence });
          else suggestions.set(tab.tabId, { key: null, confidence: null, error: t.error ?? "No suggestion." });
        }
        await call(`/browser/evaluations/${requestId}/ack`, "POST", { targetKeys: res.data.targets.map((t) => t.targetKey) }).catch(() => {});
        return { suggestions, catalogVersion: version };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("Autogroup is taking too long. Check Activity.");
  };

  const applyAutogroup = async (assignments: { tab: BrowserTab; key: string }[], version: string) => {
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
  };

  const dialogs = (
    <>
      {groupDialog && (
        <GroupDialogHost
          state={groupDialog}
          onClose={() => setGroupDialog(null)}
          onCreate={async (draft, tabs) => {
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
          }}
          onEdit={async (draft, d) => {
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
          }}
        />
      )}
      <Dialog open={!!moveFor} onOpenChange={(o) => !o && setMoveFor(null)}>
        <DialogContent className="p-0 sm:max-w-sm" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Move to group</DialogTitle>
          </DialogHeader>
          {moveFor && (
            <GroupPicker
              destinations={ws.destinations}
              canUngroup={moveFor.some((t) => t.groupId !== null)}
              onPick={(d) => {
                void actions.move(moveFor, d);
                setMoveFor(null);
              }}
              onNew={() => {
                setGroupDialog({ mode: "create", tabs: moveFor });
                setMoveFor(null);
              }}
              onUngroup={() => {
                void actions.ungroup(moveFor);
                setMoveFor(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!closeFor} onOpenChange={(o) => !o && setCloseFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {plural(closeFor?.length ?? 0, "tab")}?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the selected tabs close. Nothing is saved or removed from All links; Chrome's own history is the only way back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const tabs = closeFor ?? [];
                setCloseFor(null);
                void guard(async () => {
                  const { items } = await request("closeTabs", { tabs: tabs.map((t) => ({ ...ref(t), url: t.url })) });
                  summarize(items, "Closed");
                  clearPicked(items.filter((i) => i.ok).map((i) => i.tabId));
                });
              }}
            >
              Close tabs
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!unpinFor} onOpenChange={(o) => !o && setUnpinFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Unpin “{unpinFor ? (unpinFor.kind === "group" ? unpinFor.pinned?.name ?? groupTitle(unpinFor.group.title) : unpinFor.pinned.name) : ""}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              It stops being a destination in other windows and profiles connected to this library. Groups already open in Chrome stay, with their tabs and description.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const d = unpinFor!;
                setUnpinFor(null);
                const id = d.kind === "pinned" ? d.pinned.id : d.pinned!.id;
                void guard(async () => {
                  await unpin(id);
                  toast.success("Unpinned");
                });
              }}
            >
              Unpin
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!cleanFor} onOpenChange={(o) => !o && setCleanFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean “{cleanFor?.name}” results?</AlertDialogTitle>
            <AlertDialogDescription>
              Stored answers for the tabs in this window are removed and the lens turns off, so nothing is re-evaluated right away. The lens definition and your groups stay. Answers still on their way are discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const lens = cleanFor!;
                setCleanFor(null);
                ws.deactivate([lens.id]);
                void guard(async () => {
                  const removed = await ws.runner.clean([lens.id]);
                  toast.success(`Cleaned ${plural(removed, "result")}`);
                });
              }}
            >
              Clean results
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {autogroupFor && (
        <AutogroupDialog
          tabs={autogroupFor}
          destinations={ws.destinations.slice(0, BROWSER_LIMITS.maxDestinations)}
          suggest={() => suggest(autogroupFor)}
          onApply={applyAutogroup}
          onClose={() => setAutogroupFor(null)}
        />
      )}
    </>
  );

  return { actions, dialogs };
}

function GroupDialogHost({
  state,
  onClose,
  onCreate,
  onEdit,
}: {
  state: GroupDialogState;
  onClose: () => void;
  onCreate: (draft: GroupDraft, tabs: BrowserTab[]) => Promise<void>;
  onEdit: (draft: GroupDraft, d: Destination) => Promise<void>;
}) {
  if (state.mode === "create")
    return (
      <GroupDialog
        title="New group"
        initial={{ name: "", color: "blue", description: "", pinned: !state.tabs.length }}
        tabCount={state.tabs.length}
        pinLocked={!state.tabs.length}
        onClose={onClose}
        onSubmit={(draft) => onCreate(draft, state.tabs)}
      />
    );
  const d = state.destination;
  const group: BrowserGroup | null = d.kind === "group" ? d.group : null;
  const pinned = d.kind === "pinned" ? d.pinned : d.pinned;
  return (
    <GroupDialog
      title="Edit group"
      initial={{
        name: group ? groupTitle(group.title) : pinned!.name,
        color: group ? group.color : pinned!.color,
        description: (group?.description || pinned?.description) ?? "",
        pinned: !!pinned,
      }}
      tabCount={group ? null : 0}
      sharedNote={
        pinned
          ? "The description is shared with every window and profile of this library. Name and color apply to groups created from now on; open groups elsewhere are not renamed."
          : undefined
      }
      onClose={onClose}
      onSubmit={(draft) => onEdit(draft, d)}
    />
  );
}
