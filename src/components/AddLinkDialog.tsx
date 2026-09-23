import { useState } from "react";
import type { Tag } from "../types";
import { pastedUrls } from "../url";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TagChip } from "./TagChip";
import { TagPicker } from "./TagPicker";

export function AddLinkDialog({
  tags,
  onClose,
  onSave,
  onImport,
}: {
  tags: Tag[];
  onClose: () => void;
  onSave: (url: string, tags: string[]) => Promise<void>;
  onImport: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const urls = pastedUrls(text);
  const multiple = text.trim().split(/\s+/).filter(Boolean).length > 1;

  async function submit() {
    setError("");
    if (!text.trim()) return;
    setBusy(true);
    try {
      if (urls.length === 1) {
        await onSave(urls[0]!, selected);
      } else if (urls.length > 1) {
        onImport(text);
      } else {
        throw new Error(
          "Paste http or https links, separated by spaces or new lines.",
        );
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add link</DialogTitle>
          <DialogDescription className="sr-only">
            Save one or more links
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
            <Label>Tags</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {selected.map((name) => (
                <TagChip
                  key={name}
                  tag={
                    tags.find((t) => t.name === name) ?? {
                      id: name,
                      name,
                      description: "",
                      threshold: 0.8,
                      version: 1,
                    }
                  }
                  onRemove={() =>
                    setSelected(selected.filter((s) => s !== name))
                  }
                />
              ))}
              <TagPicker
                tags={tags}
                value={selected}
                onToggle={(name) =>
                  setSelected(
                    selected.includes(name)
                      ? selected.filter((s) => s !== name)
                      : [...selected, name],
                  )
                }
                onCreate={(name) =>
                  !selected.includes(name) && setSelected([...selected, name])
                }
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    Add tag
                  </Button>
                }
              />
            </div>
            {multiple && urls.length > 1 && (
              <p className="text-xs text-muted-foreground">
                Tags apply to single links. {urls.length} URLs detected —
                they'll be imported without tags.
              </p>
            )}
          </div>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="submit" disabled={busy || !text.trim()}>
              Save
              <Kbd className="ml-1">{multiple ? "⌘↵" : "↵"}</Kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
