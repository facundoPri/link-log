import { useEffect, useState } from "react";
import { CircleAlert, Loader2, Sparkles } from "lucide-react";
import type { BrowserTab } from "@linklog/browser-protocol";
import type { Destination } from "../../browser/useBrowserWorkspace";
import { GROUP_STYLE, groupTitle } from "./groups";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type Suggestion = { key: string | null; confidence: number | null; error?: string };

function destName(d: Destination) {
  return d.kind === "group" ? groupTitle(d.group.title) : d.pinned.name;
}
function destColor(d: Destination) {
  return GROUP_STYLE[d.kind === "group" ? d.group.color : d.pinned.color].dot;
}

/** Review step: suggestions are proposals; nothing moves until Apply. */
export function AutogroupDialog({
  tabs,
  destinations,
  suggest,
  onApply,
  onClose,
}: {
  tabs: BrowserTab[];
  destinations: Destination[];
  suggest: () => Promise<{ suggestions: Map<number, Suggestion>; catalogVersion: string }>;
  onApply: (assignments: { tab: BrowserTab; key: string }[], catalogVersion: string) => Promise<void>;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"running" | "review" | "applying" | "error">("running");
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<Map<number, string>>(new Map());
  const [suggestions, setSuggestions] = useState<Map<number, Suggestion>>(new Map());
  const [version, setVersion] = useState("");
  useEffect(() => {
    let alive = true;
    suggest()
      .then(({ suggestions, catalogVersion }) => {
        if (!alive) return;
        setSuggestions(suggestions);
        setVersion(catalogVersion);
        setChoice(new Map([...suggestions].map(([tabId, s]) => [tabId, s.key ?? "none"])));
        setPhase("review");
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const assignments = tabs
    .map((tab) => ({ tab, key: choice.get(tab.tabId) ?? "none" }))
    .filter((a) => a.key !== "none" && destinations.some((d) => d.key === a.key));
  return (
    <Dialog open onOpenChange={(o) => !o && phase !== "applying" && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-brand" />
            Autogroup {tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Jev compares each ungrouped tab with the descriptions of your groups. Tabs that already have a group are kept where they are.
          </DialogDescription>
        </DialogHeader>
        {phase === "running" && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading tabs and asking Jev…
          </div>
        )}
        {phase === "error" && (
          <p role="alert" className="flex items-center gap-2 py-4 text-[13px] text-destructive">
            <CircleAlert className="size-4" />
            {error}
          </p>
        )}
        {(phase === "review" || phase === "applying") && (
          <div className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border">
            {tabs.map((tab) => {
              const s = suggestions.get(tab.tabId);
              return (
                <div key={tab.tabId} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{tab.title || tab.url}</p>
                    <p className="truncate text-2xs text-muted-foreground">
                      {s?.error
                        ? s.error
                        : s?.confidence != null
                          ? `Suggested with ${Math.round(s.confidence * 100)}% confidence`
                          : "No suggestion"}
                    </p>
                  </div>
                  <select
                    aria-label={`Group for ${tab.title}`}
                    className="h-7 max-w-44 rounded-md border bg-background px-1.5 text-xs"
                    value={choice.get(tab.tabId) ?? "none"}
                    disabled={phase === "applying"}
                    onChange={(e) => setChoice((m) => new Map(m).set(tab.tabId, e.target.value))}
                  >
                    <option value="none">Don't group</option>
                    {destinations.map((d) => (
                      <option key={d.key} value={d.key}>
                        {destName(d)}
                        {d.kind === "pinned" ? " (pinned)" : ""}
                      </option>
                    ))}
                  </select>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: (() => {
                    const d = destinations.find((x) => x.key === choice.get(tab.tabId));
                    return d ? destColor(d) : "transparent";
                  })() }} />
                </div>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={phase === "applying"}>
            Cancel
          </Button>
          <Button
            disabled={phase !== "review" || !assignments.length}
            onClick={async () => {
              setPhase("applying");
              try {
                await onApply(assignments, version);
                onClose();
              } catch (e) {
                setError((e as Error).message);
                setPhase("error");
              }
            }}
          >
            {phase === "applying" ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Apply {assignments.length || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
