// PROTOTYPE (FAC-45), throwaway. Three structurally different bulk-action surfaces on the real library route,
// switchable with ?variant=A|B|C, the floating switcher, or ←/→. Every action is a stub: nothing is written,
// deleted or opened. Only mounted on loopback hosts with ?variant= set (see bulkPrototypeVariant).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  MoreHorizontal,
  Sparkles,
  Tag as TagIcon,
  Telescope,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { Lens, Link, Tag } from "../types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import { Kbd } from "@/components/ui/kbd";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { lensIcon } from "./Sidebar";

const VARIANTS = [
  { key: "A", name: "Promoted bar + More" },
  { key: "B", name: "Command palette" },
  { key: "C", name: "Selection panel" },
  { key: "D", name: "Hybrid: A desktop · B narrow · drawer mobile" },
] as const;
type VariantKey = (typeof VARIANTS)[number]["key"];

export function bulkPrototypeVariant(): VariantKey | null {
  if (!["127.0.0.1", "localhost"].includes(window.location.hostname)) return null;
  const v = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  return VARIANTS.some((x) => x.key === v) ? (v as VariantKey) : null;
}

// The plug-in shape FAC-46/FAC-47 would register against: availability splits the selection per link, so every
// surface can say "4 of 6" and why the rest are skipped, and run results come back per link.
type Group = "Process" | "Organize" | "Share" | "Danger";
type Availability = { eligible: Link[]; skipped: { link: Link; reason: string }[]; blocked: string | null };
type Ctx = { tags: Tag[]; jevReason: string | null };
type BulkAction = {
  id: string;
  label: string;
  verb: string;
  group: Group;
  icon: React.ReactNode;
  shortcut?: string;
  ticket?: string;
  picker?: "lens" | "tag";
  undoable?: boolean;
  availability: (links: Link[], ctx: Ctx) => Availability;
  failure?: (link: Link) => string | null;
};

const hasContent = (l: Link) => !!l.content_key || l.content_state === "queued";
const split = (links: Link[], skip: (l: Link) => string | null, blocked: string | null = null): Availability => {
  const eligible: Link[] = [];
  const skipped: Availability["skipped"] = [];
  for (const link of links) {
    const reason = skip(link);
    if (reason) skipped.push({ link, reason });
    else eligible.push(link);
  }
  return { eligible, skipped, blocked };
};
const unreachable = (l: Link) =>
  l.status === "failed" || l.attention_kind === "preview" ? "Site unreachable (stubbed failure)" : null;

const ACTIONS: BulkAction[] = [
  {
    id: "autotag",
    label: "Auto-tag",
    verb: "Tagging",
    group: "Process",
    icon: <Sparkles className="size-3.5" />,
    shortcut: "T",
    availability: (links, ctx) =>
      split(links, (l) => (hasContent(l) ? null : "No content yet"), ctx.jevReason ?? (ctx.tags.length ? null : "Create a tag first")),
  },
  {
    id: "lens",
    label: "Run lens…",
    verb: "Applying lens",
    group: "Process",
    icon: <Telescope className="size-3.5" />,
    shortcut: "L",
    picker: "lens",
    availability: (links, ctx) => split(links, (l) => (hasContent(l) ? null : "Needs context first"), ctx.jevReason),
  },
  {
    id: "extract",
    label: "Extract context",
    verb: "Extracting",
    group: "Process",
    icon: <FileText className="size-3.5" />,
    shortcut: "E",
    availability: (links) => split(links, (l) => (l.processing ? "Already processing" : null)),
    failure: unreachable,
  },
  {
    id: "tag",
    label: "Add tag…",
    verb: "Tagging",
    group: "Organize",
    icon: <TagIcon className="size-3.5" />,
    shortcut: "G",
    picker: "tag",
    availability: (links) => split(links, () => null),
  },
  {
    id: "open",
    label: "Open in tabs",
    verb: "Opening",
    group: "Share",
    icon: <ExternalLink className="size-3.5" />,
    shortcut: "O",
    ticket: "FAC-47",
    availability: (links) => split(links, () => null),
    failure: (l) => (l.domain.startsWith("nowhere") ? "Tab refused by the browser (stubbed failure)" : null),
  },
  {
    id: "copy",
    label: "Copy URLs",
    verb: "Copying",
    group: "Share",
    icon: <Copy className="size-3.5" />,
    shortcut: "C",
    availability: (links) => split(links, () => null),
  },
  {
    id: "copy-titles",
    label: "Copy URLs + titles",
    verb: "Copying",
    group: "Share",
    icon: <Copy className="size-3.5" />,
    shortcut: "⇧C",
    availability: (links) => split(links, () => null),
  },
  {
    id: "delete",
    label: "Delete…",
    verb: "Deleting",
    group: "Danger",
    icon: <Trash2 className="size-3.5" />,
    shortcut: "⌫",
    ticket: "FAC-46",
    undoable: true,
    availability: (links) => split(links, (l) => (l.processing ? "Wait for the running job to finish" : null)),
  },
];
const GROUPS: Group[] = ["Process", "Organize", "Share", "Danger"];

type Run = {
  id: number;
  action: BulkAction;
  detail?: string;
  ids: string[];
  done: number;
  failed: { link: Link; reason: string }[];
  skipped: number;
  phase: "undo" | "running" | "done";
};

function useStubRuns(onSelect: (ids: string[]) => void) {
  const [runs, setRuns] = useState<Run[]>([]);
  const seq = useRef(0);
  const start = (action: BulkAction, avail: Availability, detail?: string) => {
    if (action.id.startsWith("copy")) {
      const text = avail.eligible
        .map((l) => (action.id === "copy-titles" && l.title ? `${l.url} — ${l.title}` : l.url))
        .join("\n");
      void navigator.clipboard.writeText(text).then(
        () => toast.success(`${avail.eligible.length} links copied`),
        () => toast.error("Could not copy links"),
      );
      return;
    }
    const run: Run = {
      id: ++seq.current,
      action,
      detail,
      ids: avail.eligible.map((l) => l.id),
      done: 0,
      failed: [],
      skipped: avail.skipped.length,
      phase: action.undoable ? "undo" : "running",
    };
    setRuns((r) => [run, ...r].slice(0, 4));
    const step = (i: number) => {
      setRuns((all) =>
        all.map((r) => {
          if (r.id !== run.id || r.phase === "done") return r;
          if (r.phase === "undo") return { ...r, phase: "running" };
          const link = avail.eligible[i];
          if (!link) return { ...r, phase: "done" };
          const reason = action.failure?.(link);
          return reason ? { ...r, failed: [...r.failed, { link, reason }] } : { ...r, done: r.done + 1 };
        }),
      );
      if (i < avail.eligible.length) setTimeout(() => step(i + 1), 450);
    };
    setTimeout(() => step(0), action.undoable ? 5000 : 300);
    onSelect([]);
  };
  const undo = (id: number) => setRuns((r) => r.filter((x) => x.id !== id));
  const dismiss = undo;
  return { runs, start, undo, dismiss };
}

type Props = {
  variant: VariantKey;
  links: Link[];
  visible: Link[];
  tags: Tag[];
  lenses: Lens[];
  jevReason: string | null;
  onSelect: (ids: string[]) => void;
};

export function BulkActionsPrototype(props: Props) {
  const { runs, start, undo, dismiss } = useStubRuns(props.onSelect);
  const ctx = { tags: props.tags, jevReason: props.jevReason };
  const avail = useMemo(
    () => new Map(ACTIONS.map((a) => [a.id, a.availability(props.links, ctx)])),
    [props.links, props.tags, props.jevReason],
  );
  const shared = { ...props, avail, runs, start, undo, dismiss };
  return (
    <>
      {props.variant === "A" && <VariantA {...shared} />}
      {props.variant === "B" && <VariantB {...shared} />}
      {props.variant === "C" && <VariantC {...shared} />}
      {props.variant === "D" && <VariantD {...shared} />}
      <PrototypeSwitcher current={props.variant} selected={props.links.length} />
    </>
  );
}

type Shared = Props & ReturnType<typeof useStubRuns> & { avail: Map<string, Availability> };

const countLabel = (a: Availability, total: number) =>
  a.blocked ? null : a.eligible.length === total ? null : `${a.eligible.length}/${total}`;
const reasonOf = (a: Availability, total: number) =>
  a.blocked ??
  (a.eligible.length === 0
    ? `None of the ${total} can run: ${a.skipped[0]?.reason}`
    : a.skipped.length
      ? `${a.skipped.length} of ${total} will be skipped: ${[...new Set(a.skipped.map((s) => s.reason))].join(", ")}`
      : null);
const disabled = (a: Availability) => !!a.blocked || !a.eligible.length;

function RunLine({ run, onSelect, undo, dismiss, compact }: { run: Run; onSelect: (ids: string[]) => void; undo: (id: number) => void; dismiss: (id: number) => void; compact?: boolean }) {
  const total = run.ids.length;
  const settled = run.done + run.failed.length;
  const name = `${run.action.label.replace("…", "")}${run.detail ? ` · ${run.detail}` : ""}`;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-[12px]" data-run={run.phase}>
      <div className="flex items-center gap-2">
        {run.phase === "undo" ? (
          <Trash2 className="size-3.5 text-destructive" />
        ) : run.phase === "running" ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : run.failed.length ? (
          <CircleAlert className="size-3.5 text-amber-600" />
        ) : (
          <Check className="size-3.5 text-emerald-600" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {run.phase === "undo"
            ? `Deleting ${total} links in 5 s (stub)`
            : run.phase === "running"
              ? `${run.action.verb} ${settled}/${total}`
              : `${name}: ${run.done} done${run.failed.length ? ` · ${run.failed.length} failed` : ""}${run.skipped ? ` · ${run.skipped} skipped` : ""}`}
        </span>
        {run.phase === "undo" && (
          <Button size="xs" variant="outline" onClick={() => undo(run.id)}>
            <Undo2 className="size-3" /> Undo
          </Button>
        )}
        {run.phase === "done" && run.failed.length > 0 && (
          <Button size="xs" variant="outline" onClick={() => onSelect(run.failed.map((f) => f.link.id))}>
            Select failed
          </Button>
        )}
        {run.phase !== "undo" && (
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss result" onClick={() => dismiss(run.id)}>
            <X className="size-3" />
          </Button>
        )}
      </div>
      {run.phase === "running" && <Progress value={(settled / Math.max(total, 1)) * 100} className="h-1" />}
      {!compact &&
        run.failed.map((f) => (
          <div key={f.link.id} className="truncate pl-5 text-muted-foreground">
            {f.link.title || f.link.url}: {f.reason}
          </div>
        ))}
    </div>
  );
}

function ActionPicker({ action, lenses, tags, onPick, children }: { action: BulkAction; lenses: Lens[]; tags: Tag[]; onPick: (detail: string) => void; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const items = action.picker === "lens" ? lenses.map((l) => ({ id: l.id, name: l.name, icon: lensIcon(l.type, "size-3.5") })) : tags.map((t) => ({ id: t.id, name: t.name, icon: <TagIcon className="size-3.5" /> }));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={action.picker === "lens" ? "Pick a lens…" : "Pick a tag…"} />
          <CommandList>
            <CommandEmpty>Nothing yet</CommandEmpty>
            <CommandGroup>
              {items.map((i) => (
                <CommandItem key={i.id} value={i.name} onSelect={() => (setOpen(false), onPick(i.name))}>
                  {i.icon}
                  {i.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function confirmDelete(a: Availability) {
  return window.confirm(
    `PROTOTYPE: delete ${a.eligible.length} links?${a.skipped.length ? `\n${a.skipped.length} still processing will be skipped.` : ""}\nYou get 5 s to undo. Nothing is really deleted.`,
  );
}

// A: today's floating pill, kept as the home of the count. Three promoted actions; the rest live in one grouped
// "More" menu. Partial eligibility shows as "4/6" on the button. Runs stack above the pill.
function VariantA(p: Shared) {
  const total = p.links.length;
  const promoted = ["autotag", "lens", "open"];
  const run = (a: BulkAction, detail?: string) => {
    const av = p.avail.get(a.id)!;
    if (a.id === "delete" && !confirmDelete(av)) return;
    p.start(a, av, detail);
  };
  const button = (a: BulkAction) => {
    const av = p.avail.get(a.id)!;
    const count = countLabel(av, total);
    const btn = (
      <Button size="sm" variant={a.id === "autotag" ? "default" : "ghost"} disabled={disabled(av)} title={reasonOf(av, total) ?? undefined} onClick={a.picker ? undefined : () => run(a)}>
        {a.icon}
        {a.id === "open" ? `Open ${av.eligible.length}` : a.label.replace("Run lens…", "Lens")}
        {count && <span className="rounded bg-muted px-1 text-2xs tabular text-muted-foreground">{count}</span>}
      </Button>
    );
    return a.picker ? (
      <ActionPicker key={a.id} action={a} lenses={p.lenses} tags={p.tags} onPick={(d) => run(a, d)}>
        {btn}
      </ActionPicker>
    ) : (
      <span key={a.id}>{btn}</span>
    );
  };
  return (
    <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2">
      {p.runs.map((r) => (
        <div key={r.id} className="w-[420px] max-w-full rounded-lg border bg-popover px-3 py-2 shadow-md">
          <RunLine run={r} onSelect={p.onSelect} undo={p.undo} dismiss={p.dismiss} />
        </div>
      ))}
      {total > 0 && (
        <div aria-label="Selected link actions" className="flex items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tabular">
                {total} selected <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => p.onSelect(p.visible.map((l) => l.id))}>Select all {p.visible.length} visible</DropdownMenuItem>
              <DropdownMenuItem onClick={() => p.onSelect(p.links.filter((l) => !hasContent(l)).map((l) => l.id))}>Keep only links without content</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => p.onSelect([])}>Clear selection</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-5" />
          {ACTIONS.filter((a) => promoted.includes(a.id)).map(button)}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost">
                <MoreHorizontal className="size-3.5" /> More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {GROUPS.map((g) => {
                const items = ACTIONS.filter((a) => a.group === g && !promoted.includes(a.id));
                if (!items.length) return null;
                return (
                  <div key={g}>
                    {g !== "Process" && <DropdownMenuSeparator />}
                    <DropdownMenuLabel className="text-2xs text-muted-foreground">{g}</DropdownMenuLabel>
                    {items.map((a) => {
                      const av = p.avail.get(a.id)!;
                      return (
                        <DropdownMenuItem
                          key={a.id}
                          variant={a.group === "Danger" ? "destructive" : "default"}
                          disabled={disabled(av)}
                          onClick={() => (a.picker ? toast("Tag picker opens here (stub)") : run(a))}
                        >
                          {a.icon}
                          <span className="flex-1">{a.label}</span>
                          <span className="text-2xs tabular text-muted-foreground">{countLabel(av, total) ?? total}</span>
                        </DropdownMenuItem>
                      );
                    })}
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-5" />
          <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => p.onSelect([])}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

// B: the selection chip only holds the count and one entry point. ⌘K (or the chip) opens a palette with every
// action, eligibility counts and reasons inline, and per-action shortcuts. Progress lives in the chip.
function VariantB(p: Shared) {
  const [open, setOpen] = useState(false);
  const [page, setPageRaw] = useState<BulkAction | null>(null);
  const [search, setSearch] = useState("");
  const setPage = (a: BulkAction | null) => (setSearch(""), setPageRaw(a));
  const total = p.links.length;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && total) {
        // ⌘K is Add link today; with a selection it becomes the selection's palette (Linear's model).
        e.preventDefault();
        e.stopImmediatePropagation();
        setPage(null);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [total]);
  const run = (a: BulkAction, detail?: string) => {
    const av = p.avail.get(a.id)!;
    if (a.picker && !detail) return setPage(a);
    setOpen(false);
    if (a.id === "delete" && !confirmDelete(av)) return;
    p.start(a, av, detail);
  };
  const live = p.runs.find((r) => r.phase !== "done") ?? p.runs[0];
  return (
    <>
      {(total > 0 || live) && (
        <div aria-label="Selected link actions" className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-popover p-1 pl-3 shadow-lg">
          {total > 0 && <span className="text-[13px] font-medium tabular">{total} selected</span>}
          {total > 0 && (
            <Button size="sm" variant="secondary" className="rounded-full" onClick={() => (setPage(null), setOpen(true))}>
              Actions <Kbd>⌘K</Kbd>
            </Button>
          )}
          {live && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" className="rounded-full">
                  {live.phase === "done" ? (live.failed.length ? <CircleAlert className="size-3.5 text-amber-600" /> : <Check className="size-3.5 text-emerald-600" />) : <Loader2 className="size-3.5 animate-spin" />}
                  {live.phase === "undo" ? "Undo delete" : live.phase === "running" ? `${live.done + live.failed.length}/${live.ids.length}` : live.failed.length ? `${live.failed.length} failed` : "Done"}
                </Button>
              </PopoverTrigger>
              <PopoverContent side="top" sideOffset={8} className="w-96 space-y-3">
                {p.runs.map((r) => (
                  <RunLine key={r.id} run={r} onSelect={p.onSelect} undo={p.undo} dismiss={p.dismiss} />
                ))}
              </PopoverContent>
            </Popover>
          )}
          {total > 0 && (
            <Button size="icon-sm" variant="ghost" className="rounded-full" aria-label="Clear selection" onClick={() => p.onSelect([])}>
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      <CommandDialog open={open} onOpenChange={setOpen} title="Bulk actions" description={`Act on ${total} selected links`} className="sm:max-w-xl">
        <div className="border-b px-3 py-2 text-[12px] text-muted-foreground">
          {page ? (
            <button className="hover:underline" onClick={() => setPage(null)}>
              ← {page.label.replace("…", "")}
            </button>
          ) : (
            <>Acting on <b className="text-foreground">{total} selected</b></>
          )}
        </div>
        <CommandInput
          value={search}
          onValueChange={setSearch}
          placeholder={page ? `Pick a ${page.picker}…` : "Type an action, or press its letter"}
          onKeyDown={(e) => {
            if (page || search || e.metaKey || e.ctrlKey) return;
            const hit = ACTIONS.find((a) => a.shortcut?.toLowerCase() === e.key.toLowerCase() || (a.shortcut === "⌫" && e.key === "Backspace"));
            if (hit && !disabled(p.avail.get(hit.id)!)) {
              e.preventDefault();
              run(hit);
            }
          }}
        />
        <CommandList className="max-h-[420px]">
          <CommandEmpty>No matching action</CommandEmpty>
          {page ? (
            <CommandGroup>
              {(page.picker === "lens" ? p.lenses.map((l) => l.name) : p.tags.map((t) => t.name)).map((n) => (
                <CommandItem key={n} value={n} onSelect={() => run(page, n)}>
                  {page.icon}
                  {n}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            GROUPS.map((g) => (
              <CommandGroup key={g} heading={g}>
                {ACTIONS.filter((a) => a.group === g).map((a) => {
                  const av = p.avail.get(a.id)!;
                  const reason = reasonOf(av, total);
                  return (
                    <CommandItem key={a.id} value={a.label} disabled={disabled(av)} onSelect={() => run(a)} className={a.group === "Danger" ? "text-destructive" : ""}>
                      {a.icon}
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          {a.label} <span className="text-muted-foreground">{av.blocked ? "" : `${av.eligible.length} of ${total}`}</span>
                          {a.ticket && <span className="ml-1 rounded bg-muted px-1 text-2xs text-muted-foreground">{a.ticket}</span>}
                        </span>
                        {reason && <span className="block truncate text-2xs text-muted-foreground">{reason}</span>}
                      </span>
                      {a.shortcut && <CommandShortcut>{a.shortcut}</CommandShortcut>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}

// C: no floating bar. A docked panel on the right owns the selection: the selected links themselves, every action as
// a full row with its eligible count and skip reason, a separated danger zone, and a per-link run log.
function VariantC(p: Shared) {
  const total = p.links.length;
  if (!total && !p.runs.length) return null;
  const run = (a: BulkAction, detail?: string) => {
    const av = p.avail.get(a.id)!;
    if (a.id === "delete" && !confirmDelete(av)) return;
    p.start(a, av, detail);
  };
  return (
    <aside aria-label="Selected link actions" className="fixed top-0 right-0 bottom-0 z-40 flex w-[360px] flex-col border-l bg-background shadow-xl">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="flex-1 text-[15px] font-semibold tabular">{total ? `${total} selected` : "Selection"}</span>
        <Button size="xs" variant="ghost" onClick={() => p.onSelect(p.visible.map((l) => l.id))}>
          All {p.visible.length}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => p.onSelect([])}>
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {total > 0 && (
          <ul className="max-h-36 overflow-y-auto border-b px-2 py-1">
            {p.links.map((l) => (
              <li key={l.id} className="group flex items-center gap-2 rounded px-2 py-0.5 text-[12px] hover:bg-muted">
                {l.favicon ? <img src={l.favicon} className="size-3.5" /> : <span className="size-3.5 rounded bg-muted" />}
                <span className="min-w-0 flex-1 truncate">{l.title || l.url}</span>
                {!hasContent(l) && <span className="text-2xs text-muted-foreground">no content</span>}
                <button aria-label={`Deselect ${l.title}`} className="opacity-0 group-hover:opacity-100" onClick={() => p.onSelect(p.links.filter((x) => x.id !== l.id).map((x) => x.id))}>
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {total > 0 &&
          GROUPS.map((g) => (
            <section key={g} className={`px-2 py-2 ${g === "Danger" ? "mt-2 border-t border-destructive/30" : ""}`}>
              <h3 className={`px-2 pb-1 text-2xs font-medium uppercase tracking-wide ${g === "Danger" ? "text-destructive" : "text-muted-foreground"}`}>{g}</h3>
              {ACTIONS.filter((a) => a.group === g).map((a) => {
                const av = p.avail.get(a.id)!;
                const reason = reasonOf(av, total);
                const row = (
                  <button
                    disabled={disabled(av)}
                    onClick={a.picker ? undefined : () => run(a)}
                    className={`flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent ${a.group === "Danger" ? "text-destructive" : ""}`}
                  >
                    <span className="mt-0.5">{a.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        {a.label}
                        {a.ticket && <span className="rounded bg-muted px-1 text-2xs text-muted-foreground">{a.ticket}</span>}
                      </span>
                      {reason && <span className="block text-2xs text-muted-foreground">{reason}</span>}
                    </span>
                    <span className="text-[12px] tabular text-muted-foreground">{av.blocked ? "–" : `${av.eligible.length}/${total}`}</span>
                  </button>
                );
                return a.picker ? (
                  <ActionPicker key={a.id} action={a} lenses={p.lenses} tags={p.tags} onPick={(d) => run(a, d)}>
                    {row}
                  </ActionPicker>
                ) : (
                  <div key={a.id}>{row}</div>
                );
              })}
            </section>
          ))}
      </div>
      {p.runs.length > 0 && (
        <div className="max-h-[40%] space-y-3 overflow-y-auto border-t bg-muted/40 px-4 py-3">
          <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Results</h3>
          {p.runs.map((r) => (
            <RunLine key={r.id} run={r} onSelect={p.onSelect} undo={p.undo} dismiss={p.dismiss} />
          ))}
        </div>
      )}
    </aside>
  );
}

// D: the owner's pick after A/B/C. Desktop keeps A's bar, with More and ⌘K opening a compact, scroll-free palette.
// Narrow screens fall back to B's chip and the same palette. Phones get a chip that opens a bottom drawer. Direct
// single-key shortcuts work on every layout while links are selected.
type Layout = "desktop" | "narrow" | "mobile";
function useLayout(): Layout {
  const read = (): Layout => (window.innerWidth < 768 ? "mobile" : window.innerWidth < 1100 ? "narrow" : "desktop");
  const [layout, setLayout] = useState(read);
  useEffect(() => {
    const sync = () => setLayout(read());
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);
  return layout;
}

const matches = (a: BulkAction, e: KeyboardEvent) => {
  if (!a.shortcut || e.metaKey || e.ctrlKey || e.altKey) return false;
  if (a.shortcut === "⌫") return e.key === "Backspace" || e.key === "Delete";
  if (a.shortcut.startsWith("⇧")) return e.shiftKey && e.key.toLowerCase() === a.shortcut.slice(1).toLowerCase();
  return !e.shiftKey && e.key.toLowerCase() === a.shortcut.toLowerCase();
};

function VariantD(p: Shared) {
  const layout = useLayout();
  const [palette, setPalette] = useState<{ page: BulkAction | null } | null>(null);
  const [drawer, setDrawer] = useState<{ page: BulkAction | null } | null>(null);
  const total = p.links.length;
  const run = (a: BulkAction, detail?: string) => {
    const av = p.avail.get(a.id)!;
    if (disabled(av)) return toast(reasonOf(av, total) ?? `${a.label} is unavailable`);
    if (a.picker && !detail) return layout === "mobile" ? setDrawer({ page: a }) : setPalette({ page: a });
    setPalette(null);
    setDrawer(null);
    if (a.id === "delete" && !confirmDelete(av)) return;
    p.start(a, av, detail);
  };
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!total) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopImmediatePropagation();
        setPalette((o) => (o ? null : { page: null }));
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable]") || document.querySelector("[role=dialog], [role=menu]")) return;
      const hit = ACTIONS.find((a) => matches(a, e));
      if (hit) {
        e.preventDefault();
        runRef.current(hit);
      }
    };
    // Escape that closes an overlay must not also reach App's window handler, which clears the selection.
    let overlayOpen = false;
    const note = (e: KeyboardEvent) => {
      if (e.key === "Escape") overlayOpen = !!document.querySelector("[role=dialog], [role=menu], [data-radix-popper-content-wrapper]");
    };
    const swallow = (e: KeyboardEvent) => {
      if (e.key === "Escape" && overlayOpen) e.stopPropagation();
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("keydown", note, true);
    document.addEventListener("keydown", swallow);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("keydown", note, true);
      document.removeEventListener("keydown", swallow);
    };
  }, [total]);
  const status = p.runs.find((r) => r.phase !== "done") ?? p.runs[0];
  return (
    <>
      {layout === "desktop" ? (
        <DesktopBar {...p} run={run} openPalette={() => setPalette({ page: null })} />
      ) : (
        (total > 0 || status) && (
          <div
            aria-label="Selected link actions"
            className={`fixed z-40 flex items-center gap-1 border bg-popover p-1 shadow-lg ${layout === "mobile" ? "right-3 bottom-[calc(3.75rem+env(safe-area-inset-bottom))] left-3 rounded-2xl pl-4" : "bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full pl-3"}`}
          >
            {total > 0 && <span className="flex-1 text-[13px] font-medium whitespace-nowrap tabular">{total} selected</span>}
            {status && <RunChip run={status} {...p} />}
            {total > 0 && (
              <Button
                size={layout === "mobile" ? "default" : "sm"}
                className={layout === "mobile" ? "h-10 rounded-xl" : "rounded-full"}
                variant={layout === "mobile" ? "default" : "secondary"}
                onClick={() => (layout === "mobile" ? setDrawer({ page: null }) : setPalette({ page: null }))}
              >
                Actions {layout === "narrow" && <Kbd>⌘K</Kbd>}
              </Button>
            )}
            {total > 0 && (
              <Button size={layout === "mobile" ? "icon" : "icon-sm"} variant="ghost" className="rounded-full" aria-label="Clear selection" onClick={() => p.onSelect([])}>
                <X className="size-4" />
              </Button>
            )}
          </div>
        )
      )}
      {layout !== "mobile" && (
        <CompactPalette {...p} page={palette?.page ?? null} open={!!palette} onOpenChange={(o) => setPalette(o ? { page: null } : null)} setPage={(page) => setPalette({ page })} run={run} />
      )}
      {layout === "mobile" && (
        <ActionDrawer {...p} page={drawer?.page ?? null} open={!!drawer} onOpenChange={(o) => setDrawer(o ? { page: null } : null)} setPage={(page) => setDrawer({ page })} run={run} />
      )}
    </>
  );
}

function RunChip({ run, runs, onSelect, undo, dismiss }: Shared & { run: Run }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="rounded-full">
          {run.phase === "done" ? run.failed.length ? <CircleAlert className="size-3.5 text-amber-600" /> : <Check className="size-3.5 text-emerald-600" /> : <Loader2 className="size-3.5 animate-spin" />}
          {run.phase === "undo" ? "Undo" : run.phase === "running" ? `${run.done + run.failed.length}/${run.ids.length}` : run.failed.length ? `${run.failed.length} failed` : "Done"}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={8} className="w-[min(24rem,calc(100vw-1.5rem))] space-y-3">
        {runs.map((r) => (
          <RunLine key={r.id} run={r} onSelect={onSelect} undo={undo} dismiss={dismiss} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function DesktopBar(p: Shared & { run: (a: BulkAction, detail?: string) => void; openPalette: () => void }) {
  const total = p.links.length;
  const promoted = ["autotag", "lens", "open"];
  return (
    <div className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex w-max -translate-x-1/2 flex-col items-center gap-2">
      {p.runs.map((r) => (
        <div key={r.id} className="w-[440px] rounded-lg border bg-popover px-3 py-2 shadow-md">
          <RunLine run={r} onSelect={p.onSelect} undo={p.undo} dismiss={p.dismiss} />
        </div>
      ))}
      {total > 0 && (
        <div aria-label="Selected link actions" className="flex items-center gap-1 rounded-xl border bg-popover p-1.5 shadow-lg">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="tabular">
                {total} selected <ChevronDown className="size-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => p.onSelect(p.visible.map((l) => l.id))}>Select all {p.visible.length} visible</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => p.onSelect([])}>Clear selection</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-5" />
          {ACTIONS.filter((a) => promoted.includes(a.id)).map((a) => {
            const av = p.avail.get(a.id)!;
            const count = countLabel(av, total);
            const reason = reasonOf(av, total);
            return (
              <Tooltip key={a.id}>
                <TooltipTrigger asChild>
                  <span>
                    <Button size="sm" variant={a.id === "autotag" ? "default" : "ghost"} disabled={disabled(av)} onClick={() => p.run(a)}>
                      {a.icon}
                      {a.id === "open" ? `Open ${av.eligible.length}` : a.id === "lens" ? "Lens" : a.label}
                      {count && <span className="rounded bg-muted px-1 text-2xs tabular text-muted-foreground">{count}</span>}
                      <Kbd className={a.id === "autotag" ? "bg-white/20 text-current" : ""}>{a.shortcut}</Kbd>
                    </Button>
                  </span>
                </TooltipTrigger>
                {reason && <TooltipContent>{reason}</TooltipContent>}
              </Tooltip>
            );
          })}
          <Button size="sm" variant="ghost" onClick={p.openPalette}>
            <MoreHorizontal className="size-3.5" /> More <Kbd>⌘K</Kbd>
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => p.onSelect([])}>
            <X className="size-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}

type PageProps = Shared & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: BulkAction | null;
  setPage: (page: BulkAction | null) => void;
  run: (a: BulkAction, detail?: string) => void;
};
const pickerItems = (p: PageProps, a: BulkAction) =>
  a.picker === "lens"
    ? p.lenses.map((l) => ({ id: l.id, name: l.name, icon: lensIcon(l.type, "size-4") }))
    : p.tags.map((t) => ({ id: t.id, name: t.name, icon: <TagIcon className="size-4" /> }));

// Compact: one line per action, the reason trails the label, groups sit in a left gutter. Eight actions fit without
// a scrollbar at 820 px tall.
function CompactPalette(p: PageProps) {
  const total = p.links.length;
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(""), [p.page, p.open]);
  return (
    <CommandDialog open={p.open} onOpenChange={p.onOpenChange} title="Bulk actions" description={`Act on ${total} selected links`} showCloseButton={false} className="top-[30%] sm:max-w-[560px]">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[12px] text-muted-foreground">
        {p.page ? (
          <button className="hover:text-foreground" onClick={() => p.setPage(null)}>
            ← {p.page.label.replace("…", "")} on {total} links
          </button>
        ) : (
          <span className="flex-1">
            Acting on <b className="text-foreground tabular">{total} selected</b>
          </span>
        )}
        {!p.page && <span>Press a key to run directly</span>}
      </div>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder={p.page ? `Pick a ${p.page.picker}…` : "Filter actions…"}
        onKeyDown={(e) => {
          if (p.page || search || e.metaKey || e.ctrlKey) return;
          const hit = ACTIONS.find((a) => matches(a, e.nativeEvent));
          if (hit) {
            e.preventDefault();
            p.run(hit);
          }
        }}
      />
      <CommandList className="max-h-none overflow-visible">
        <CommandEmpty>No matching action</CommandEmpty>
        {p.page ? (
          <CommandGroup>
            {pickerItems(p, p.page).map((i) => (
              <CommandItem key={i.id} value={i.name} onSelect={() => p.run(p.page!, i.name)} className="!py-2">
                {i.icon}
                {i.name}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : (
          GROUPS.map((g) => (
            <CommandGroup key={g} className="!px-1.5 !py-1 [&_[cmdk-group-items]]:grid [&_[cmdk-group-items]]:grid-cols-[4.5rem_1fr] [&_[cmdk-group-items]]:items-start">
              <div className={`row-span-3 px-2 pt-2 text-2xs font-medium uppercase tracking-wide ${g === "Danger" ? "text-destructive" : "text-muted-foreground"}`}>{g}</div>
              {ACTIONS.filter((a) => a.group === g).map((a) => {
                const av = p.avail.get(a.id)!;
                const reason = av.blocked ?? (av.skipped.length ? `${av.skipped.length} skipped: ${av.skipped[0]!.reason.toLowerCase()}` : null);
                return (
                  <CommandItem key={a.id} value={a.label} disabled={disabled(av)} onSelect={() => p.run(a)} className={`col-start-2 !py-1.5 ${g === "Danger" ? "text-destructive data-[selected=true]:text-destructive" : ""}`}>
                    <span className="[&_svg]:!size-4">{a.icon}</span>
                    <span className="whitespace-nowrap">{a.label}</span>
                    {reason && <span className="min-w-0 truncate text-2xs text-muted-foreground">{reason}</span>}
                    <span className="ml-auto text-[12px] tabular text-muted-foreground">{av.blocked ? "–" : `${av.eligible.length}/${total}`}</span>
                    {a.shortcut && <Kbd className="min-w-6 justify-center">{a.shortcut}</Kbd>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))
        )}
      </CommandList>
    </CommandDialog>
  );
}

// Mobile: a bottom drawer with thumb-sized tiles. The danger action is a separate full-width button, pickers replace
// the tiles in place, and results sit above the tiles while a run is visible.
function ActionDrawer(p: PageProps) {
  const total = p.links.length;
  return (
    <Sheet open={p.open} onOpenChange={p.onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false} className="max-h-[85dvh] gap-0 rounded-t-2xl px-4 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted-foreground/30" />
        <div className="mb-3 flex items-center gap-2">
          {p.page ? (
            <button className="flex items-center gap-1 text-[15px] font-semibold" onClick={() => p.setPage(null)}>
              <ArrowLeft className="size-4" /> {p.page.label.replace("…", "")}
            </button>
          ) : (
            <SheetTitle className="flex-1 text-[15px] tabular">{total} selected</SheetTitle>
          )}
          <SheetDescription className="sr-only">Actions for the selected links</SheetDescription>
          {!p.page && (
            <Button size="sm" variant="ghost" onClick={() => p.onSelect(p.visible.map((l) => l.id))}>
              Select all {p.visible.length}
            </Button>
          )}
        </div>
        {p.page ? (
          <div className="flex flex-col overflow-y-auto">
            {pickerItems(p, p.page).map((i) => (
              <button key={i.id} className="flex min-h-12 items-center gap-3 border-b px-1 text-left text-[15px] last:border-0 active:bg-muted" onClick={() => p.run(p.page!, i.name)}>
                {i.icon}
                {i.name}
              </button>
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              {ACTIONS.filter((a) => a.group !== "Danger").map((a) => {
                const av = p.avail.get(a.id)!;
                const count = countLabel(av, total);
                return (
                  <button
                    key={a.id}
                    disabled={disabled(av)}
                    onClick={() => p.run(a)}
                    className="relative flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl bg-muted/60 px-1 text-center text-[12px] leading-tight font-medium active:bg-muted disabled:opacity-40 [&_svg]:!size-5"
                  >
                    {a.icon}
                    <span>{a.label.replace("…", "").replace("Extract context", "Extract").replace("Copy URLs + titles", "Copy + titles").replace("Open in tabs", "Open tabs")}</span>
                    {count && <span className="absolute top-1.5 right-1.5 rounded-full bg-background px-1.5 text-2xs tabular text-muted-foreground">{count}</span>}
                  </button>
                );
              })}
            </div>
            {ACTIONS.some((a) => p.avail.get(a.id)!.skipped.length && !p.avail.get(a.id)!.blocked) && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                Numbers show how many of the {total} each action can run on. {p.links.filter((l) => !hasContent(l)).length} have no content yet, so AI actions skip them.
              </p>
            )}
            {ACTIONS.filter((a) => a.group === "Danger").map((a) => {
              const av = p.avail.get(a.id)!;
              return (
                <Button key={a.id} variant="outline" disabled={disabled(av)} onClick={() => p.run(a)} className="mt-3 h-11 w-full rounded-xl border-destructive/40 text-destructive">
                  <Trash2 className="size-4" /> Delete {av.eligible.length} {av.eligible.length === 1 ? "link" : "links"}
                </Button>
              );
            })}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PrototypeSwitcher({ current, selected }: { current: VariantKey; selected: number }) {
  const go = (step: number) => {
    const i = VARIANTS.findIndex((v) => v.key === current);
    const next = VARIANTS[(i + step + VARIANTS.length) % VARIANTS.length]!.key;
    const url = new URL(window.location.href);
    url.searchParams.set("variant", next);
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const name = VARIANTS.find((v) => v.key === current)!.name;
  return (
    <div aria-label="Prototype variant switcher" className="fixed bottom-3 left-1/2 z-[60] max-[767px]:z-30 flex -translate-x-1/2 items-center gap-1 rounded-full bg-fuchsia-700 px-1.5 py-1 text-[12px] font-medium text-white shadow-2xl ring-2 ring-fuchsia-300">
      <button aria-label="Previous variant" className="rounded-full p-1 hover:bg-white/20" onClick={() => go(-1)}>
        <ArrowLeft className="size-3.5" />
      </button>
      <span className="max-w-[calc(100vw-6rem)] truncate px-1 whitespace-nowrap">
        PROTOTYPE {current} ({name}) · {selected} selected
      </span>
      <button aria-label="Next variant" className="rounded-full p-1 hover:bg-white/20" onClick={() => go(1)}>
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  );
}

export function useBulkPrototypeVariant() {
  const [variant, setVariant] = useState(bulkPrototypeVariant);
  useEffect(() => {
    const sync = () => setVariant(bulkPrototypeVariant());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return variant;
}
