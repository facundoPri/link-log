import { useState } from "react";
import { toast } from "sonner";
import { api } from "../api";
import type { Library } from "../types";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SettingsDialog({
  library,
  onClose,
  onChange,
}: {
  library: Library;
  onClose: () => void;
  onChange: (library: Library) => void;
}) {
  const [saving, setSaving] = useState(false);
  const save = async (preview_fallback: boolean) => {
    setSaving(true);
    try {
      onChange(await api<Library>("/settings", "PUT", { preview_fallback }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Applies to the whole library.</DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3">
          <Checkbox
            id="preview-fallback"
            className="mt-0.5"
            checked={library.settings.preview_fallback}
            disabled={saving}
            onCheckedChange={(checked) => void save(checked === true)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="preview-fallback">If the content can't be extracted, use the preview for Jev</Label>
            <p className="text-xs text-muted-foreground">
              When getting the content fails for good, the title and description are saved as its content, so the
              link can still be auto-tagged and isn't left in Needs attention. You can retry getting the content later.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
