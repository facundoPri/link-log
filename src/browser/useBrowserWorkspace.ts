import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserGroup, BrowserTab, PinnedGroup, TabPreview } from "@linklog/browser-protocol";
import { domainOf } from "../url";
import type { Library, Lens } from "../types";
import { useBrowser } from "./useBrowser";
import { useLensRunner } from "./useLensRunner";

export type GroupFilter = number | "none";
/** A place tabs can be moved to: a native group here, or a pinned definition not yet materialized here. */
export type Destination =
  | { kind: "group"; key: string; group: BrowserGroup; pinned: PinnedGroup | null }
  | { kind: "pinned"; key: string; pinned: PinnedGroup };

const ACTIVE_KEY = "linklog.browser.activeLenses";

function readActive(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Domain of a tab, as shown and filtered in the list ("" for pages without a web origin). */
export function tabDomain(tab: BrowserTab): string {
  if (!/^https?:/i.test(tab.url)) return "";
  try {
    return domainOf(tab.url);
  } catch {
    return "";
  }
}

export type BrowserWorkspace = ReturnType<typeof useBrowserWorkspace>;

export function useBrowserWorkspace(library: Library, inBrowser: boolean, loaded: boolean) {
  const browser = useBrowser();
  const browserLenses = useMemo(() => library.lenses.filter((l) => l.scope === "browser"), [library.lenses]);
  const [activeIds, setActiveIds] = useState<string[]>(readActive);
  const [groupFilter, setGroupFilter] = useState<GroupFilter[]>([]);
  const activeLenses = useMemo(
    () => activeIds.map((id) => browserLenses.find((l) => l.id === id)).filter((l): l is Lens => !!l),
    [activeIds, browserLenses],
  );
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_KEY, JSON.stringify(activeIds));
    } catch {
      /* per-viewer convenience only */
    }
  }, [activeIds]);
  // Deleted lenses drop out of the active set — only once the library has loaded,
  // otherwise the empty initial list would switch off every restored lens.
  useEffect(() => {
    if (!loaded) return;
    setActiveIds((ids) => {
      const next = ids.filter((id) => browserLenses.some((l) => l.id === id));
      return next.length === ids.length ? ids : next;
    });
  }, [browserLenses, loaded]);

  const runner = useLensRunner(browser, activeLenses, browserLenses, inBrowser);
  const tabs: BrowserTab[] = browser.snapshot?.tabs ?? [];
  const groups: BrowserGroup[] = browser.snapshot?.groups ?? [];

  // Filters that no longer exist in this window (group closed, page moved) are dropped.
  useEffect(() => {
    setGroupFilter((f) => {
      const next = f.filter((g) => g === "none" || groups.some((x) => x.groupId === g));
      return next.length === f.length ? f : next;
    });
  }, [groups]);

  const destinations = useMemo<Destination[]>(() => {
    const pinned = browser.catalog?.groups ?? [];
    const local: Destination[] = groups.map((group) => ({
      kind: "group",
      key: `g:${group.groupId}`,
      group,
      pinned: pinned.find((p) => p.id === group.pinnedId) ?? null,
    }));
    const bound = new Set(groups.map((g) => g.pinnedId).filter(Boolean));
    return [
      ...local,
      ...pinned.filter((p) => !bound.has(p.id)).map((p): Destination => ({ kind: "pinned", key: `p:${p.id}`, pinned: p })),
    ];
  }, [groups, browser.catalog]);

  const toggleLens = useCallback((id: string) => {
    setActiveIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }, []);
  const deactivate = useCallback((ids: string[]) => setActiveIds((cur) => cur.filter((id) => !ids.includes(id))), []);
  const activate = useCallback((id: string) => setActiveIds((cur) => (cur.includes(id) ? cur : [...cur, id])), []);
  // The tab shown in the inspector (by instance: reopening a URL is another tab).
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  useEffect(() => {
    if (activeTabId && browser.snapshot && !tabs.some((t) => t.tabInstanceId === activeTabId)) setActiveTabId(null);
  }, [tabs, activeTabId, browser.snapshot]);

  const [domainFilter, setDomainFilter] = useState<string[]>([]);
  const toggleDomain = useCallback(
    (d: string) => setDomainFilter((f) => (f.includes(d) ? f.filter((x) => x !== d) : [...f, d])),
    [],
  );

  // Row previews (description + image) come from the page's own metadata, read locally by the
  // extension for tabs it may read. Nothing here is sent to the backend.
  const [previews, setPreviews] = useState<Record<string, TabPreview>>({});
  const previewing = useRef(false);
  const { request, connection } = browser;
  useEffect(() => {
    if (!inBrowser || connection !== "connected") return;
    const missing = tabs.filter(
      (t) => t.content === "available" && previews[t.tabInstanceId]?.documentRevision !== t.documentRevision,
    );
    if (!missing.length || previewing.current) return;
    const timer = setTimeout(() => {
      previewing.current = true;
      request("previews", { tabs: missing.slice(0, 200).map((t) => ({ tabId: t.tabId, tabInstanceId: t.tabInstanceId })) }, 30_000)
        .then(({ previews: got }) =>
          setPreviews((cur) => {
            const next = { ...cur };
            for (const p of got) next[p.tabInstanceId] = p;
            // Tabs that couldn't be read are remembered as empty so they aren't retried in a loop.
            for (const t of missing)
              if (!got.some((p) => p.tabInstanceId === t.tabInstanceId))
                next[t.tabInstanceId] = { tabInstanceId: t.tabInstanceId, documentRevision: t.documentRevision, description: "", siteName: "", image: "" };
            return next;
          }),
        )
        .catch(() => {})
        .finally(() => {
          previewing.current = false;
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [tabs, previews, inBrowser, connection, request]);

  const toggleGroupFilter = useCallback(
    (g: GroupFilter) => setGroupFilter((f) => (f.includes(g) ? f.filter((x) => x !== g) : [...f, g])),
    [],
  );

  return {
    browser,
    runner,
    tabs,
    groups,
    destinations,
    browserLenses,
    activeLenses,
    activeIds,
    toggleLens,
    activate,
    deactivate,
    groupFilter,
    setGroupFilter,
    toggleGroupFilter,
    activeTabId,
    setActiveTabId,
    domainFilter,
    setDomainFilter,
    toggleDomain,
    previews,
  };
}
