import { useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { Lens, LensLevel, LensOption, LensType } from "../types";
import { cn } from "../lib/utils";
import { lensIcon } from "./Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type LensDraft = Omit<Lens, "id" | "version" | "created_at"> & {
  runNow: boolean;
};

const TYPE_INFO: Record<LensType, { title: string; blurb: string }> = {
  noul: { title: "Yes / No", blurb: "A calibrated yes or no" },
  choice: { title: "Pick one", blurb: "The single best option" },
  multi: { title: "Pick many", blurb: "Every option that applies" },
  score: { title: "Score", blurb: "A level on an ordered scale" },
};

const QUESTION_PLACEHOLDER: Record<LensType, string> = {
  noul: "Does this talk about using AI to build IoT products?",
  choice: "Which category does this link fit best?",
  multi: "Which of these topics does the article cover?",
  score: "How relevant is this link for your reference library?",
};

function EditorRow({
  index,
  label,
  description,
  removable,
  labelPlaceholder,
  descriptionPlaceholder,
  onLabel,
  onDescription,
  onRemove,
  onEnter,
}: {
  index?: number;
  label: string;
  description: string;
  removable: boolean;
  labelPlaceholder: string;
  descriptionPlaceholder: string;
  onLabel: (v: string) => void;
  onDescription: (v: string) => void;
  onRemove: () => void;
  onEnter: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {index !== undefined && (
        <span className="w-4 shrink-0 text-right text-2xs tabular text-muted-foreground">
          {index}
        </span>
      )}
      <Input
        value={label}
        maxLength={60}
        placeholder={labelPlaceholder}
        className="h-8 flex-1"
        onChange={(e) => onLabel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      <Input
        value={description}
        maxLength={300}
        placeholder={descriptionPlaceholder}
        className="h-8 flex-1 text-muted-foreground"
        onChange={(e) => onDescription(e.target.value)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Remove"
        onClick={onRemove}
        className={cn(!removable && "invisible")}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}

export function LensDialog({
  lens,
  selectedCount,
  onClose,
  onSave,
}: {
  lens: Lens | "new";
  selectedCount: number;
  onClose: () => void;
  onSave: (draft: LensDraft) => Promise<void>;
}) {
  const editing = lens !== "new";
  const [name, setName] = useState(editing ? lens.name : "");
  const [type, setType] = useState<LensType>(editing ? lens.type : "noul");
  const [question, setQuestion] = useState(editing ? lens.question : "");
  const [options, setOptions] = useState<LensOption[]>(
    editing && (lens.type === "choice" || lens.type === "multi")
      ? lens.options
          .filter((o) => o.key !== "other")
          .map((o) => ({ ...o }))
      : [
          { key: "option_0", label: "", description: "" },
          { key: "option_1", label: "", description: "" },
        ],
  );
  const [levels, setLevels] = useState<LensLevel[]>(
    editing && lens.type === "score"
      ? lens.levels.map((l) => ({ ...l }))
      : [
          { label: "", description: "" },
          { label: "", description: "" },
        ],
  );
  const [criteria, setCriteria] = useState(
    editing && lens.type === "noul" ? { ...lens.criteria } : { yes: "", no: "" },
  );
  const [criteriaOpen, setCriteriaOpen] = useState(
    editing && lens.type === "noul" && !!(lens.criteria.yes || lens.criteria.no),
  );
  const [threshold, setThreshold] = useState(
    editing ? Math.round(lens.threshold * 100) : 80,
  );
  const [runNow, setRunNow] = useState(!!selectedCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nextKey = useRef(
    editing ? lens.options.length : 2,
  );

  const addOption = () =>
    setOptions((o) => [
      ...o,
      {
        key: `option_${Date.now().toString(36)}_${nextKey.current++}`,
        label: "",
        description: "",
      },
    ]);
  const addLevel = () =>
    setLevels((l) => [...l, { label: "", description: "" }]);

  const showThreshold = type === "noul" || type === "multi";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit lens" : "New lens"}</DialogTitle>
          <DialogDescription className="sr-only">
            A saved question answered for each link with context
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              const filledOptions = options.filter((o) => o.label.trim());
              if (
                (type === "choice" || type === "multi") &&
                filledOptions.length !== options.length
              )
                throw new Error("Fill in every option label or remove the row.");
              const filledLevels = levels.filter((l) => l.label.trim());
              if (type === "score" && filledLevels.length !== levels.length)
                throw new Error("Fill in every level label or remove the row.");
              await onSave({
                name: name.trim(),
                type,
                question: question.trim(),
                threshold: threshold / 100,
                options:
                  type === "choice" || type === "multi"
                    ? filledOptions.map((o) => ({
                        ...o,
                        label: o.label.trim(),
                        description: o.description.trim(),
                      }))
                    : [],
                levels:
                  type === "score"
                    ? filledLevels.map((l) => ({
                        label: l.label.trim(),
                        description: l.description.trim(),
                      }))
                    : [],
                criteria:
                  type === "noul"
                    ? { yes: criteria.yes.trim(), no: criteria.no.trim() }
                    : { yes: "", no: "" },
                runNow,
              });
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {(Object.keys(TYPE_INFO) as LensType[]).map((t) => (
              <button
                key={t}
                type="button"
                disabled={editing}
                onClick={() => setType(t)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-md border p-2 text-left transition-colors",
                  type === t
                    ? "border-brand bg-brand/5 ring-1 ring-brand/30"
                    : "hover:bg-accent/60",
                  editing && "cursor-not-allowed opacity-50",
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  {lensIcon(t)}
                  {TYPE_INFO[t].title}
                </span>
                <span className="text-2xs leading-snug text-muted-foreground">
                  {TYPE_INFO[t].blurb}
                </span>
              </button>
            ))}
          </div>
          {editing && (
            <p className="-mt-2 text-2xs text-muted-foreground">
              Type can't be changed — create a new lens instead.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="lens-name">Name</Label>
            <Input
              id="lens-name"
              required
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Research relevance"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lens-question">Question</Label>
            <Textarea
              id="lens-question"
              required
              rows={2}
              maxLength={2000}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={QUESTION_PLACEHOLDER[type]}
            />
          </div>
          {(type === "choice" || type === "multi") && (
            <div className="space-y-1.5">
              <Label>Options</Label>
              <div className="space-y-1.5">
                {options.map((o, i) => (
                  <EditorRow
                    key={o.key}
                    label={o.label}
                    description={o.description}
                    removable={options.length > 2}
                    labelPlaceholder="Option"
                    descriptionPlaceholder="Description — optional"
                    onLabel={(v) =>
                      setOptions((os) =>
                        os.map((x, j) => (j === i ? { ...x, label: v } : x)),
                      )
                    }
                    onDescription={(v) =>
                      setOptions((os) =>
                        os.map((x, j) =>
                          j === i ? { ...x, description: v } : x,
                        ),
                      )
                    }
                    onRemove={() =>
                      setOptions((os) => os.filter((_, j) => j !== i))
                    }
                    onEnter={() => {
                      if (options.length < 11) addOption();
                    }}
                  />
                ))}
              </div>
              {options.length < 11 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addOption}
                >
                  <Plus className="size-3.5" />
                  Add option
                </Button>
              )}
              {type === "choice" && (
                <p className="text-xs text-muted-foreground">
                  “Other” is added automatically for links that match none.
                </p>
              )}
            </div>
          )}
          {type === "score" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Levels</Label>
                <span className="text-2xs text-muted-foreground">
                  Lowest first · 2–10
                </span>
              </div>
              <div className="space-y-1.5">
                {levels.map((l, i) => (
                  <EditorRow
                    key={i}
                    index={i}
                    label={l.label}
                    description={l.description}
                    removable={levels.length > 2}
                    labelPlaceholder="Level"
                    descriptionPlaceholder="What this level looks like — optional"
                    onLabel={(v) =>
                      setLevels((ls) =>
                        ls.map((x, j) => (j === i ? { ...x, label: v } : x)),
                      )
                    }
                    onDescription={(v) =>
                      setLevels((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, description: v } : x,
                        ),
                      )
                    }
                    onRemove={() =>
                      setLevels((ls) => ls.filter((_, j) => j !== i))
                    }
                    onEnter={() => {
                      if (levels.length < 10) addLevel();
                    }}
                  />
                ))}
              </div>
              {levels.length < 10 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addLevel}
                >
                  <Plus className="size-3.5" />
                  Add level
                </Button>
              )}
            </div>
          )}
          {showThreshold && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="lens-threshold">
                  {type === "multi"
                    ? "Selected when confidence ≥"
                    : "Confidence threshold"}
                </Label>
                <span className="text-xs tabular text-muted-foreground">
                  {threshold}%
                </span>
              </div>
              <Slider
                id="lens-threshold"
                min={50}
                max={99}
                step={1}
                value={[threshold]}
                onValueChange={([v]) => setThreshold(v!)}
              />
            </div>
          )}
          {type === "noul" && (
            <Collapsible open={criteriaOpen} onOpenChange={setCriteriaOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-ml-2"
                >
                  Define yes and no (optional)
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-2 pt-1">
                <Textarea
                  rows={2}
                  maxLength={500}
                  value={criteria.yes}
                  onChange={(e) =>
                    setCriteria((c) => ({ ...c, yes: e.target.value }))
                  }
                  placeholder="Counts as yes — e.g. The article gives concrete examples of…"
                  aria-label="Counts as yes"
                />
                <Textarea
                  rows={2}
                  maxLength={500}
                  value={criteria.no}
                  onChange={(e) =>
                    setCriteria((c) => ({ ...c, no: e.target.value }))
                  }
                  placeholder="Counts as no — e.g. The article only mentions it in passing"
                  aria-label="Counts as no"
                />
              </CollapsibleContent>
            </Collapsible>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="sm:justify-between">
            <div className="flex items-center gap-2">
              {!editing && !!selectedCount && (
                <label className="flex items-center gap-2 text-[13px]">
                  <Checkbox
                    checked={runNow}
                    onCheckedChange={(c) => setRunNow(c === true)}
                  />
                  Run on the {selectedCount} selected{" "}
                  {selectedCount === 1 ? "link" : "links"} now
                </label>
              )}
              {editing && (
                <span className="text-xs text-muted-foreground">
                  Existing results keep the version they were computed with.
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !name.trim() || !question.trim()}
              >
                {editing ? "Save lens" : "Create lens"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
