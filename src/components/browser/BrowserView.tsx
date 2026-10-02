import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  Globe,
  Lock,
  PanelLeft,
  Search,
  Unplug,
  X,
} from "lucide-react";
import {
  matchesAllLensFilters,
  type BrowserTab,
  type LensFilter,
} from "@linklog/browser-protocol";
import type { Lens, Library } from "../../types";
import { tabDomain, type BrowserWorkspace } from "../../browser/useBrowserWorkspace";
import { useSavedLookup } from "../../browser/saved";
import type { useBrowserActions } from "../../browser/useBrowserActions";
import { cn } from "../../lib/utils";
import { GROUP_STYLE, groupTitle } from "./groups";
import { Banner, Connect } from "./BrowserConnect";
import { DomainChip, DomainFilter } from "../DomainFilter";
import { TabRow } from "./TabRow";
import { LensFilterBar } from "./LensFilterBar";
import { BrowserSelectionBar } from "./BrowserSelectionBar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Actions = ReturnType<typeof useBrowserActions>["actions"];

export function BrowserView({
  ws,
  library,
  actions,
  picked,
  setPicked,
  onToggleSidebar,
  onEditLens,
}: {
  ws: BrowserWorkspace;
  library: Library;
  actions: Actions;
  picked: string[];
  setPicked: (fn: (ids: string[]) => string[]) => void;
  onToggleSidebar: () => void;
  onEditLens: (lens: Lens) => void;
}) {
  const { browser, runner, tabs, groups, activeLenses } = ws;
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, LensFilter>>({});
  const [sortLensId, setSortLensId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const lastIndex = useRef<number | null>(null);

  // Filters of lenses that were turned off disappear with them.
  useEffect(() => {
    setFilters((f) => Object.fromEntries(Object.entries(f).filter(([id]) => ws.activeIds.includes(id))));
    setSortLensId((id) => (id && !ws.activeIds.includes(id) ? null : id));
  }, [ws.activeIds]);

  // A new window scope (Linklog moved) or closed tabs invalidate the selection.
  useEffect(() => {
    setPicked((ids) => {
      const next = ids.filter((id) => tabs.some((t) => t.tabInstanceId === id));
      return next.length === ids.length ? ids : next;
    });
  }, [tabs, setPicked]);

  const savedOf = useSavedLookup(library);
  const domains = useMemo(() => {
    const map = new Map<string, { name: string; count: number; favicon: string | null }>();
    for (const t of tabs) {
      const name = tabDomain(t);
      if (!name) continue;
      const d = map.get(name);
      if (d) {
        d.count++;
        d.favicon ??= t.favIconUrl;
      } else map.set(name, { name, count: 1, favicon: t.favIconUrl });
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [tabs]);

  const visible = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const groupsById = new Map(groups.map((g) => [g.groupId, g]));
    const list = tabs.filter((t) => {
      if (ws.groupFilter.length && !ws.groupFilter.includes(t.groupId ?? "none")) return false;
      if (ws.domainFilter.length && !ws.domainFilter.includes(tabDomain(t))) return false;
      const answers = (lensId: string) => {
        const r = runner.results[t.tabInstanceId]?.[lensId];
        return r?.state === "done" ? r.answer : null;
      };
      if (!matchesAllLensFilters(activeLenses, answers, Object.values(filters))) return false;
      const hay = [t.title, t.url, ws.previews[t.tabInstanceId]?.description ?? "", t.groupId !== null ? groupsById.get(t.groupId)?.title ?? "" : ""].join(" ").toLocaleLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (sortLensId)
      list.sort((a, b) => {
        const score = (t: BrowserTab) => {
          const ans = runner.results[t.tabInstanceId]?.[sortLensId]?.answer;
          return ans?.type === "score" ? ans.score : -1;
        };
        return score(b) - score(a) || a.index - b.index;
      });
    return list;
  }, [tabs, groups, query, ws.groupFilter, ws.domainFilter, ws.previews, filters, activeLenses, runner.results, sortLensId]);

  const pickedTabs = tabs.filter((t) => picked.includes(t.tabInstanceId));
  const allPicked = visible.length > 0 && visible.every((t) => picked.includes(t.tabInstanceId));
  const somePicked = visible.some((t) => picked.includes(t.tabInstanceId));
  const pickMany = (ids: string[], checked: boolean) =>
    setPicked((cur) => (checked ? [...new Set([...cur, ...ids])] : cur.filter((id) => !ids.includes(id))));

  // One listener for the view's lifetime; it reads the latest state through a ref.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLElement && !!e.target.closest("input,textarea,select,[contenteditable='true']");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      search.current?.focus();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && !typing) {
      e.preventDefault();
      pickMany(visible.map((t) => t.tabInstanceId), true);
    } else if (e.key === "Escape" && !typing && !document.querySelector("[role=dialog],[role=menu],[role=alertdialog]")) {
      if (ws.activeTabId) ws.setActiveTabId(null);
      else setPicked(() => []);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && ws.activeTabId && !typing) {
      const i = visible.findIndex((t) => t.tabInstanceId === ws.activeTabId);
      const next = visible[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        e.preventDefault();
        ws.setActiveTabId(next.tabInstanceId);
        document.querySelector(`[data-tab-id="${next.tabId}"]`)?.scrollIntoView({ block: "nearest" });
      }
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const snapshot = browser.snapshot;
  const filtered = !!(query || ws.groupFilter.length || ws.domainFilter.length || Object.values(filters).some((f) => f.keys.length || f.minLevel !== null));

  return (
    <>
      <div className="shrink-0">
        <div className="flex h-12 items-center gap-2 border-b px-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Toggle sidebar" onClick={onToggleSidebar}>
                <PanelLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Toggle sidebar <Kbd className="ml-1">⌘\</Kbd>
            </TooltipContent>
          </Tooltip>
          {visible.length > 0 && (
            <Checkbox
              aria-label={allPicked ? "Deselect all" : `Select all ${visible.length} tabs`}
              checked={allPicked ? true : somePicked ? "indeterminate" : false}
              onCheckedChange={() => pickMany(visible.map((t) => t.tabInstanceId), !allPicked)}
            />
          )}
          <h1 className="flex min-w-0 items-center gap-2 truncate text-sm font-medium">
            Browser
            <span className="font-normal tabular text-muted-foreground">
              · {filtered ? `${visible.length} of ${tabs.length}` : tabs.length} {tabs.length === 1 ? "tab" : "tabs"}
            </span>
          </h1>
          <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden md:flex">
            {ws.groupFilter.map((g) => {
              const group = groups.find((x) => x.groupId === g);
              return (
                <span
                  key={String(g)}
                  className="inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium"
                  style={group ? { background: GROUP_STYLE[group.color].bg, color: GROUP_STYLE[group.color].fg } : undefined}
                >
                  {group ? groupTitle(group.title) : "Ungrouped"}
                  <button aria-label="Remove group filter" onClick={() => ws.toggleGroupFilter(g)}>
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            {ws.domainFilter.map((name) => (
              <DomainChip
                key={name}
                domain={domains.find((x) => x.name === name) ?? { name, favicon: null }}
                onRemove={() => ws.toggleDomain(name)}
              />
            ))}
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery("");
                  ws.setGroupFilter([]);
                  ws.setDomainFilter([]);
                  setFilters({});
                }}
              >
                Clear
              </Button>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={search}
                aria-label="Search tabs"
                placeholder="Search tabs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-32 min-w-24 pl-8 pr-7 @2xl:w-56"
              />
              {query ? (
                <button aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setQuery("")}>
                  <X className="size-3.5" />
                </button>
              ) : (
                <Kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 sm:inline-flex">/</Kbd>
              )}
            </div>
            <DomainFilter
              domains={domains}
              selected={ws.domainFilter}
              onToggle={ws.toggleDomain}
              onClear={() => ws.setDomainFilter([])}
            />
          </div>
        </div>
        {snapshot && browser.connection !== "connected" && (
          <Banner icon={<Unplug className="size-3.5" />}>
            Reconnecting to the extension… showing the last tabs it reported.
          </Banner>
        )}
        {snapshot && browser.hello && !browser.hello.contentAccess && (
          <Banner
            icon={<Lock className="size-3.5" />}
            action={
              <Button size="sm" variant="outline" className="h-7" onClick={() => void browser.request("openPermissions", {}).catch(() => {})}>
                Allow access
              </Button>
            }
          >
            Allow access to see previews and content of your open tabs, and let lenses read them. Previews (description and image) are read locally for every tab Linklog may access, and their images load from each site's servers. Page text is sent to your library only when a lens evaluates a tab.
          </Banner>
        )}
        {(runner.offline || (browser.backendError && browser.catalog)) && (
          <Banner icon={<CircleAlert className="size-3.5" />}>
            The local API is unavailable. Stored answers stay; new evaluations wait until it's back.
          </Banner>
        )}
        {runner.notice && (
          <Banner
            icon={<CircleAlert className="size-3.5" />}
            action={
              <Button size="sm" variant="ghost" className="h-7" onClick={() => location.reload()}>
                Reload
              </Button>
            }
          >
            {runner.notice}
          </Banner>
        )}
        {snapshot && activeLenses.length > 0 && (
          <LensFilterBar
            lenses={activeLenses}
            tabs={tabs}
            results={runner.results}
            filters={filters}
            sortLensId={sortLensId}
            onFilter={(f) => setFilters((cur) => ({ ...cur, [f.lensId]: f }))}
            onSort={setSortLensId}
            onRetryFailed={(lens) =>
              actions.reevaluate(
                lens,
                // Same set the button counts: failed and expired (unreadable tabs have "Use title").
                tabs.filter((t) => ["failed", "expired"].includes(runner.results[t.tabInstanceId]?.[lens.id]?.state ?? "")),
              )
            }
            onReevaluate={(lens) => actions.reevaluate(lens)}
            onClean={actions.requestClean}
            onEdit={onEditLens}
            onDeactivate={(lens) => ws.deactivate([lens.id])}
          />
        )}
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto", picked.length && "pb-24 max-[700px]:pb-32")}>
        {!snapshot ? (
          <Connect ws={ws} />
        ) : !visible.length ? (
          <div className="flex flex-1 items-center justify-center p-8">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                {filtered ? <Search className="size-5" /> : <Globe className="size-5" />}
              </div>
              <h2 className="text-sm font-medium">{filtered ? "No tabs match" : "No other tabs in this window"}</h2>
              <p className="text-[13px] text-muted-foreground">
                {filtered
                  ? "Filters only change what you see; active lenses still cover every tab."
                  : "Open pages in this window and they appear here. Linklog's own tabs are not listed."}
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y" role="list">
            {visible.map((tab, index) => (
              <TabRow
                key={tab.tabInstanceId}
                tab={tab}
                group={groups.find((g) => g.groupId === tab.groupId)}
                saved={savedOf(tab)}
                preview={ws.previews[tab.tabInstanceId]}
                domain={tabDomain(tab)}
                active={ws.activeTabId === tab.tabInstanceId}
                onActivate={() => ws.setActiveTabId(tab.tabInstanceId)}
                onDomainFilter={ws.toggleDomain}
                lenses={activeLenses}
                records={runner.results[tab.tabInstanceId]}
                picked={picked.includes(tab.tabInstanceId)}
                stale={browser.connection !== "connected"}
                onPicked={(checked, shift) => {
                  if (shift && lastIndex.current !== null) {
                    const a = Math.min(lastIndex.current, index);
                    const b = Math.max(lastIndex.current, index);
                    pickMany(visible.slice(a, b + 1).map((t) => t.tabInstanceId), checked);
                  } else pickMany([tab.tabInstanceId], checked);
                  lastIndex.current = index;
                }}
                onFocus={() => actions.focus(tab)}
                onToggleGroup={ws.toggleGroupFilter}
                onRetry={(lens) => actions.reevaluate(lens, [tab])}
                onMetadata={(lens) => actions.evaluateMetadata(lens, tab)}
                onSave={() => void actions.save([tab])}
                onClose={() => actions.requestClose([tab])}
                onMove={() => actions.chooseMove([tab])}
                onUngroup={() => void actions.ungroup([tab])}
                onCopy={() => actions.copy(tab)}
              />
            ))}
          </div>
        )}
      </div>
      {!!pickedTabs.length && (
        <BrowserSelectionBar
          tabs={pickedTabs}
          destinations={ws.destinations}
          busy={actions.busy}
          onSave={() => void actions.save(pickedTabs)}
          onMove={(d) => void actions.move(pickedTabs, d)}
          onNewGroup={() => actions.newGroup(pickedTabs)}
          onUngroup={() => void actions.ungroup(pickedTabs)}
          onAutogroup={() => actions.autogroup(pickedTabs)}
          onClose={() => actions.requestClose(pickedTabs)}
          onClear={() => setPicked(() => [])}
        />
      )}
    </>
  );
}
