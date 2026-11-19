import { BROWSER_LIMITS, type BrowserGroup, type BrowserTab } from "@linklog/browser-protocol";
import type { BrowserWorkspace, Destination } from "../../browser/useBrowserWorkspace";
import type { BrowserActions, GroupDialogState } from "../../browser/useBrowserActions";
import { plural } from "../../lib/format";
import { GroupDialog, type GroupDraft } from "./GroupDialog";
import { AutogroupDialog } from "./AutogroupDialog";
import { GroupPicker } from "./GroupPicker";
import { groupTitle } from "./groups";
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

function Confirm({
  open,
  title,
  description,
  action,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  action: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const destinationName = (d: Destination) => (d.kind === "group" ? d.pinned?.name ?? groupTitle(d.group.title) : d.pinned.name);

/** The dialogs of Browser actions: one at a time, driven by `useBrowserActions`. */
export function BrowserDialogs({ ws, controller }: { ws: BrowserWorkspace; controller: BrowserActions }) {
  const { dialog, ops } = controller;
  const close = ops.close;
  return (
    <>
      {dialog?.kind === "group" && (
        <GroupDialogHost state={dialog.state} onClose={close} onCreate={ops.createGroup} onEdit={ops.editGroup} />
      )}
      <Dialog open={dialog?.kind === "move"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="p-0 sm:max-w-sm" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Move to group</DialogTitle>
          </DialogHeader>
          {dialog?.kind === "move" && (
            <GroupPicker
              destinations={ws.destinations}
              canUngroup={dialog.tabs.some((t) => t.groupId !== null)}
              onPick={(d) => {
                close();
                void ops.move(dialog.tabs, d);
              }}
              onNew={() => ops.newGroup(dialog.tabs)}
              onUngroup={() => {
                close();
                void ops.ungroup(dialog.tabs);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Confirm
        open={dialog?.kind === "close"}
        title={`Close ${plural(dialog?.kind === "close" ? dialog.tabs.length : 0, "tab")}?`}
        description="Only the selected tabs close. Nothing is saved or removed from All links; Chrome's own history is the only way back."
        action="Close tabs"
        onCancel={close}
        onConfirm={() => {
          if (dialog?.kind !== "close") return;
          close();
          void ops.closeTabs(dialog.tabs);
        }}
      />
      <Confirm
        open={dialog?.kind === "unpin"}
        title={`Unpin “${dialog?.kind === "unpin" ? destinationName(dialog.destination) : ""}”?`}
        description="It stops being a destination in other windows and profiles connected to this library. Groups already open in Chrome stay, with their tabs and description."
        action="Unpin"
        onCancel={close}
        onConfirm={() => {
          if (dialog?.kind !== "unpin") return;
          close();
          void ops.unpin(dialog.destination);
        }}
      />
      <Confirm
        open={dialog?.kind === "clean"}
        title={`Clean “${dialog?.kind === "clean" ? dialog.lens.name : ""}” results?`}
        description="Stored answers for the tabs in this window are removed and the lens turns off, so nothing is re-evaluated right away. The lens definition and your groups stay. Answers still on their way are discarded."
        action="Clean results"
        onCancel={close}
        onConfirm={() => {
          if (dialog?.kind !== "clean") return;
          close();
          void ops.clean(dialog.lens);
        }}
      />
      {dialog?.kind === "autogroup" && (
        <AutogroupDialog
          tabs={dialog.tabs}
          destinations={ws.destinations.slice(0, BROWSER_LIMITS.maxDestinations)}
          run={dialog.run}
          onApply={ops.applyAutogroup}
          onClose={close}
        />
      )}
    </>
  );
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
  const pinned = d.pinned;
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
