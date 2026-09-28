import { useEffect, useState } from "react";
import { ChevronsUpDown, CircleAlert, Loader2, Sparkles } from "lucide-react";
import type { BrowserTab } from "@linklog/browser-protocol";
import type { Destination } from "../../browser/useBrowserWorkspace";
import type { AutogroupResult, Suggestion } from "../../browser/useBrowserActions";
import { cn } from "../../lib/utils";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function destName(d: Destination) {
  return d.kind === "group" ? groupTitle(d.group.title) : d.pinned.name;
}
function destColor(d: Destination) {
  return GROUP_STYLE[d.kind === "group" ? d.group.color : d.pinned.color].dot;
}

function Dot({ d }: { d: Destination | undefined }) {
  if (!d) return <span aria-hidden className="size-2 shrink-0 rounded-full ring-1 ring-inset ring-border" />;
  const pinnedOnly = d.kind === "pinned";
  return (
    <span
      aria-hidden
      className="size-2 shrink-0 rounded-full"
      style={pinnedOnly ? { boxShadow: `inset 0 0 0 1.5px ${destColor(d)}` } : { background: destColor(d) }}
    />
  );
}

function DestinationSelect({
  label,
  destinations,
  value,
  suggested,
  disabled,
  onChange,
}: {
  label: string;
  destinations: Destination[];
  value: string;
  suggested: string | null;
  disabled: boolean;
  onChange: (key: string) => void;
}) {
  const current = destinations.find((d) => d.key === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" aria-label={label} disabled={disabled} className="h-7 w-40 justify-between gap-2 px-2 text-xs font-normal">
          <span className="flex min-w-0 items-center gap-2">
            <Dot d={current} />
            <span className={cn("truncate", !current && "text-muted-foreground")}>{current ? destName(current) : "Don't group"}</span>
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {destinations.map((d) => (
            <DropdownMenuRadioItem key={d.key} value={d.key} className="gap-2 text-xs">
              <Dot d={d} />
              <span className="truncate">{destName(d)}</span>
              {d.key === suggested && <span className="ml-auto pl-2 text-2xs text-brand">Suggested</span>}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="none" className="text-xs text-muted-foreground">
            Don't group
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Review step: suggestions are proposals; nothing moves until Apply. The run was
 * started by the click that opened this dialog; the dialog only shows its outcome,
 * so re-mounting it (React StrictMode in dev) never asks Jev twice.
 */
export function AutogroupDialog({
  tabs,
  destinations,
  run,
  onApply,
  onClose,
}: {
  tabs: BrowserTab[];
  destinations: Destination[];
  run: Promise<AutogroupResult>;
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
    run
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
  }, [run]);
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
                <div key={tab.tabId} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px]">{tab.title || tab.url}</p>
                    <p className={cn("truncate text-2xs", s?.error ? "text-destructive" : "text-muted-foreground")}>
                      {s?.error
                        ? s.error
                        : s?.confidence != null
                          ? `${Math.round(s.confidence * 100)}% match`
                          : "No clear match"}
                    </p>
                  </div>
                  <DestinationSelect
                    label={`Group for ${tab.title}`}
                    destinations={destinations}
                    value={choice.get(tab.tabId) ?? "none"}
                    suggested={s?.key ?? null}
                    disabled={phase === "applying"}
                    onChange={(key) => setChoice((m) => new Map(m).set(tab.tabId, key))}
                  />
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
