import { useId, useState } from "react";
import type { MoveTarget } from "@linklog/browser-protocol";
import type { Destination } from "../../browser/useBrowserWorkspace";
import { openLimitReason } from "../../browser/openLinks";
import { plural } from "../../lib/format";
import { pastedUrls } from "../../url";
import { groupTitle } from "./groups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const NONE = "none";
const NEW = "new";

const destinationName = (d: Destination) => (d.kind === "group" ? d.pinned?.name ?? groupTitle(d.group.title) : d.pinned.name);

/** Browser's URL entry: opens tabs in this window, optionally into a group. It never saves to the Library. */
export function OpenLinksDialog({
  text: initialText,
  destinations,
  unavailable,
  canGroup,
  toTarget,
  onClose,
  onOpen,
}: {
  text: string;
  destinations: Destination[];
  /** Why tabs can't be opened right now (extension missing, outdated, connecting), or null. */
  unavailable: string | null;
  /** The extension can group the tabs it opens (the "open-group" capability). */
  canGroup: boolean;
  toTarget: (d: Destination) => MoveTarget;
  onClose: () => void;
  onOpen: (urls: string[], target: MoveTarget | null, groupName: string | null) => Promise<void>;
}) {
  const [text, setText] = useState(initialText);
  const [choice, setChoice] = useState(NONE);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // The hint shows while typing; it is announced only once a submit was tried, not on every invalid keystroke.
  const [attempted, setAttempted] = useState(false);
  const groupId = useId();
  const urls = pastedUrls(text);
  const destination = destinations.find((d) => d.key === choice) ?? null;
  const target: MoveTarget | null =
    choice === NEW ? { kind: "new", title: name.trim(), color: "blue", description: "" } : destination ? toTarget(destination) : null;
  const groupName = choice === NEW ? name.trim() : destination ? destinationName(destination) : null;
  const problem =
    unavailable ??
    openLimitReason(urls.length) ??
    (text.trim() && !urls.length ? "Paste http or https links, separated by spaces or new lines." : null) ??
    (choice === NEW && !name.trim() ? "Name the new group." : null) ??
    (choice !== NONE && choice !== NEW && !destination ? "That group is gone. Pick another one." : null);

  async function submit() {
    setAttempted(true);
    if (problem || !urls.length || busy) return;
    setBusy(true);
    try {
      await onOpen(urls, target, groupName);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open links</DialogTitle>
          <DialogDescription>
            Opens them as background tabs in this Chrome window. Nothing is saved to your Library.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <Textarea
            autoFocus
            rows={3}
            value={text}
            aria-label="Links to open"
            placeholder="https://… — paste one URL or several, one per line"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="space-y-1.5">
            <Label htmlFor={groupId}>Group</Label>
            <select
              id={groupId}
              value={choice}
              disabled={!canGroup}
              onChange={(e) => setChoice(e.target.value)}
              className="h-8 w-full rounded-md border bg-transparent px-2 text-sm disabled:opacity-50"
            >
              <option value={NONE}>Don't group</option>
              {destinations.map((d) => (
                <option key={d.key} value={d.key}>
                  {destinationName(d)}
                  {d.kind === "pinned" ? " (pinned, creates it here)" : ""}
                </option>
              ))}
              <option value={NEW}>New group…</option>
            </select>
            {choice === NEW && (
              <Input aria-label="New group name" placeholder="Group name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            )}
            {!unavailable && (
              <p className="text-xs text-muted-foreground">
                {canGroup
                  ? "Only tabs opened now join the group; pages already open in this window stay where they are."
                  : "Update the Linklog extension to open links into a group."}
              </p>
            )}
          </div>
          {problem && (text.trim() || unavailable) && (
            <p role={attempted || unavailable ? "alert" : undefined} className="text-xs text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !!problem || !urls.length}>
              {busy ? "Opening…" : urls.length ? `Open ${plural(urls.length, "tab")}` : "Open tabs"}
              <Kbd className="ml-1">⌘↵</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
