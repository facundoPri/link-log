import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Tag } from "../types";
import { api } from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { Library } from "../types";

export function TagDialog({
  tag,
  onClose,
  onChange,
  linkCount,
}: {
  tag: Tag | "new";
  onClose: () => void;
  onChange: (library: Library) => void;
  linkCount: (tagId: string) => number;
}) {
  const editing = tag !== "new";
  const [name, setName] = useState(editing ? tag.name : "");
  const [description, setDescription] = useState(
    editing ? tag.description : "",
  );
  const [threshold, setThreshold] = useState(
    editing ? Math.round(tag.threshold * 100) : 80,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // autofocus the name field
  }, []);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (!editing) {
        const lib = await api("/tags", "POST", { name });
        const created = lib.tags.find(
          (t) => t.name === name.trim().toLocaleLowerCase(),
        );
        if (
          created &&
          (description.trim() || threshold !== Math.round(created.threshold * 100))
        ) {
          const lib2 = await api(`/tags/${created.id}`, "PATCH", {
            name: created.name,
            description,
            threshold: threshold / 100,
          });
          onChange(lib2);
        } else {
          onChange(lib);
        }
        toast.success("Tag created");
      } else {
        const lib = await api(`/tags/${tag.id}`, "PATCH", {
          name,
          description,
          threshold: threshold / 100,
        });
        onChange(lib);
        toast.success("Tag updated");
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit tag" : "New tag"}</DialogTitle>
          <DialogDescription className="sr-only">
            {editing ? "Edit tag details" : "Create a tag"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tag-name">Name</Label>
            <Input
              id="tag-name"
              autoFocus
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tag-description">Description</Label>
            <Textarea
              id="tag-description"
              rows={4}
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Articles about building products with LLMs — not general ML research"
            />
            <p className="text-xs text-muted-foreground">
              Tell the AI what belongs here. Examples and exclusions help.
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="tag-threshold">Confidence threshold</Label>
              <span className="text-xs tabular text-muted-foreground">
                {threshold}%
              </span>
            </div>
            <Slider
              id="tag-threshold"
              min={50}
              max={99}
              step={1}
              value={[threshold]}
              onValueChange={([v]) => setThreshold(v!)}
            />
            <p className="text-xs text-muted-foreground">
              Links scoring at or above this get the tag during auto-tagging.
            </p>
          </div>
          {editing && (
            <p className="text-xs text-muted-foreground">
              Changes apply to future auto-tag runs. Existing scores are kept.
            </p>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          {editing ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={busy}
                >
                  Delete tag
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Delete “{editing ? tag.name : ""}”?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    It will be removed from {editing ? linkCount(tag.id) : 0}{" "}
                    links. Scores are kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      try {
                        onChange(
                          await api(`/tags/${tag.id}`, "DELETE", {}),
                        );
                        toast.success("Tag deleted");
                        onClose();
                      } catch (e) {
                        toast.error((e as Error).message);
                      }
                    }}
                  >
                    Delete tag
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={busy || !name.trim()}
            >
              {editing ? "Save changes" : "Create tag"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
