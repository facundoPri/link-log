import { useState } from "react";
import { Check } from "lucide-react";
import { GROUP_COLORS, type GroupColor } from "@linklog/browser-protocol";
import { cn } from "../../lib/utils";
import { GROUP_STYLE } from "./groups";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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

export type GroupDraft = { name: string; color: GroupColor; description: string; pinned: boolean };

export function GroupDialog({
  title,
  initial,
  tabCount,
  pinLocked,
  sharedNote,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: GroupDraft;
  /** Tabs that will move into a new group; 0 means a pinned destination only. */
  tabCount: number | null;
  pinLocked?: boolean;
  sharedNote?: string;
  onClose: () => void;
  onSubmit: (draft: GroupDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-xs">
            {tabCount
              ? `Groups ${tabCount} selected ${tabCount === 1 ? "tab" : "tabs"} in this window.`
              : tabCount === 0
                ? "A pinned group exists without tabs. It appears as a destination in every window connected to this library."
                : "Chrome keeps the name and color; Linklog keeps the description."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              await onSubmit({ ...draft, name: draft.name.trim(), description: draft.description.trim() });
              onClose();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              autoFocus
              maxLength={80}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Research"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Color</Label>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Group color">
              {GROUP_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === c}
                  aria-label={GROUP_STYLE[c].label}
                  onClick={() => setDraft({ ...draft, color: c })}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-shadow",
                    draft.color === c && "ring-2 ring-ring",
                  )}
                  style={{ background: GROUP_STYLE[c].dot }}
                >
                  {draft.color === c && <Check className="size-3.5 text-white" />}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-description">Description</Label>
            <Textarea
              id="group-description"
              rows={3}
              maxLength={2000}
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="Pull requests I still need to review — not ones already merged"
            />
            <p className="text-xs text-muted-foreground">Autogroup reads this to decide which tabs belong here.</p>
          </div>
          <label className={cn("flex items-start gap-2 text-[13px]", pinLocked && "opacity-70")}>
            <Checkbox
              checked={draft.pinned}
              disabled={pinLocked}
              onCheckedChange={(c) => setDraft({ ...draft, pinned: c === true })}
              className="mt-0.5"
            />
            <span>
              Pin to library
              <span className="block text-xs text-muted-foreground">
                {sharedNote ??
                  "Available as a destination in other windows and profiles connected to this library. Tabs are never shared."}
              </span>
            </span>
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !draft.name.trim() || (tabCount === 0 && !draft.pinned)}>
              {title.startsWith("New") ? "Create group" : "Save group"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
