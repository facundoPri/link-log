import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "./api";
import type { Job, Lens, LensResult, LensScope, Library, Link, Tag } from "./types";
import { jevUnavailable, needsAttention } from "./attention";
import { clipboardUrls, pastedUrls } from "./url";
import { Sidebar, type View } from "./components/Sidebar";
import { Toolbar, type ContextFilter } from "./components/Toolbar";
import { LinkList } from "./components/LinkList";
import { PendingLinks } from "./components/PendingLinks";
import { SelectionBar } from "./components/SelectionBar";
import { Inspector } from "./components/Inspector";
import { TagDialog } from "./components/TagDialog";
import { AddLinkDialog } from "./components/AddLinkDialog";
import { LensDialog, type LensDraft } from "./components/LensDialog";
import { lensBucket, lensSelectedKeys } from "./components/LensVerdict";
import { LensHeader } from "./components/LensHeader";
import { ActivitySheet } from "./components/ActivitySheet";
import { BrowserView } from "./components/browser/BrowserView";
import { BrowserSidebar } from "./components/browser/BrowserSidebar";
import { tabDomain, useBrowserWorkspace } from "./browser/useBrowserWorkspace";
import { useSavedLookup } from "./browser/saved";
import { useOpenLinks } from "./browser/openLinks";
import { BrowserInspector } from "./components/browser/BrowserInspector";
import { BrowserDialogs } from "./components/browser/BrowserDialogs";
import { useBrowserActions } from "./browser/useBrowserActions";
import { usd, tokens } from "./lib/format";
import { submitInChunks, type BatchReply } from "./batches";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import "./index.css";

function useMedia(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const fn = () => setMatches(mql.matches);
    fn();
    mql.addEventListener("change", fn);
    return () => mql.removeEventListener("change", fn);
  }, [query]);
  return matches;
}

function isInput(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input,textarea,select,[contenteditable="true"]')
  );
}

export function App({
  account,
  onSignOut,
}: {
  account: { email: string };
  onSignOut: () => void;
}) {
  const [library, setLibrary] = useState<Library>({
    links: [],
    tags: [],
    lenses: [],
    batches: [],
    capabilities: { markdown: false, jev: false, provider: "typesafe" },
  });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [domainFilter, setDomainFilter] = useState<string[]>([]);
  const [context, setContext] = useState<ContextFilter>("any");
  const [ascending, setAscending] = useState(false);
  const [dialog, setDialog] = useState<
    | "add"
    | { tag: Tag | "new" }
    | { lens: Lens | "new"; scope?: LensScope }
    | null
  >(null);
  const [browserPicked, setBrowserPicked] = useState<string[]>([]);
  const [lensFilter, setLensFilter] = useState<Set<string>>(new Set());
  const [lensMinLevel, setLensMinLevel] = useState<number | null>(null);
  const [lensScoreSort, setLensScoreSort] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem("linklog.sidebar") !== "closed",
  );
  const [deleteLink, setDeleteLink] = useState<Link | null>(null);
  const [deleteTag, setDeleteTag] = useState<Tag | null>(null);
  const [deleteLens, setDeleteLens] = useState<Lens | null>(null);
  const [confirmAutoTag, setConfirmAutoTag] = useState(false);
  const [confirmNoContent, setConfirmNoContent] = useState(false);
  const [extractFirst, setExtractFirst] = useState(false);
  const [confirmExtract, setConfirmExtract] = useState<string[] | null>(null);
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focusTags, setFocusTags] = useState(false);
  const [jobsByLink, setJobsByLink] = useState<
    Map<string, { kind: "extract" | "preview" | "autotag" | "lens" | "query"; status: string; step: string | null }>
  >(new Map());
  const dragDepth = useRef(0);
  const [pendingUrls, setPendingUrls] = useState<string[]>([]);
  const pendingSaves = useRef(new Map<string, string>());
  const captureQueue = useRef(Promise.resolve());
  const captureActive = useRef(true);
  useEffect(() => {
    captureActive.current = true;
    return () => {
      captureActive.current = false;
      for (const id of new Set(pendingSaves.current.values())) toast.dismiss(id);
    };
  }, []);
  const libraryEpoch = useRef(0);
  const listScroll = useRef<HTMLDivElement>(null);
  const pendingNewUrls = useMemo(() => {
    const saved = new Set(library.links.flatMap((link) => [link.original_url, link.url]));
    return pendingUrls.filter((url) => !saved.has(url));
  }, [pendingUrls, library.links]);
  const inspectorW = useRef(400);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const v = Number(localStorage.getItem("linklog.inspector"));
    inspectorW.current = v >= 320 && v <= 720 ? v : 400;
    return inspectorW.current;
  });
  const search = useRef<HTMLInputElement>(null);
  const sessionBatches = useRef(new Set<string>());
  const narrow = useMedia("(max-width: 1099px)");
  const mobile = useMedia("(max-width: 767px)");
  const ws = useBrowserWorkspace(library, view === "browser", loaded && !loadError);
  const openLinks = useOpenLinks(ws.browser);
  const browserController = useBrowserActions(
    ws,
    setLibrary,
    (tabIds) =>
      setBrowserPicked((cur) =>
        tabIds
          ? cur.filter((id) => !ws.tabs.some((t) => t.tabInstanceId === id && tabIds.includes(t.tabId)))
          : [],
      ),
  );
  const browserActions = browserController.actions;
  const libraryLenses = useMemo(
    () => library.lenses.filter((l) => l.scope !== "browser"),
    [library.lenses],
  );
  const jevReason = jevUnavailable(library.capabilities);

  useEffect(() => {
    localStorage.setItem(
      "linklog.sidebar",
      sidebarOpen ? "open" : "closed",
    );
  }, [sidebarOpen]);

  const refresh = useCallback(async () => {
    const epoch = libraryEpoch.current;
    const data = await api();
    if (epoch === libraryEpoch.current) setLibrary(data);
    setLoaded(true);
    setLoadError("");
    return data;
  }, []);

  useEffect(() => {
    refresh().catch((e) => {
      setLoaded(true);
      setLoadError((e as Error).message);
    });
  }, [refresh]);

  const busyPolling = library.links.some((l) => l.processing) ||
    library.batches.some((b) => b.active > 0);

  // Poll library + per-batch jobs while work is in flight.
  useEffect(() => {
    if (!busyPolling) {
      setJobsByLink(new Map());
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const lib = await refresh();
        const active = lib.batches.filter((b) => b.active > 0);
        if (!alive) return;
        const map = new Map<string, { kind: "extract" | "preview" | "autotag" | "lens" | "query"; status: string; step: string | null }>();
        for (const b of active) {
          try {
            const { jobs } = await api<{ jobs: Job[] }>(`/batches/${b.id}`);
            for (const j of jobs)
              // A waiting job never hides the job it waits for.
              if (j.link_id && ["queued", "running", "waiting"].includes(j.status) && !(j.status === "waiting" && map.has(j.link_id)) && (b.kind === "extract" || b.kind === "preview" || b.kind === "autotag" || b.kind === "lens" || b.kind === "query"))
                map.set(j.link_id, { kind: b.kind, status: j.status, step: j.step });
          } catch {
            /* batch may be gone */
          }
        }
        if (alive) setJobsByLink(map);
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1800);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [busyPolling, refresh]);

  // Batch progress toasts for batches this session created.
  useEffect(() => {
    for (const b of library.batches) {
      if (!sessionBatches.current.has(b.id)) continue;
      const n = b.total;
      const verb =
        b.kind === "autotag"
          ? "Auto-tagging"
          : b.kind === "extract"
            ? "Extracting context for"
            : "Applying lens to";
      if (b.active > 0) {
        toast.loading(`${verb} ${n} ${n === 1 ? "link" : "links"}…`, {
          id: b.id,
          description: `${b.done + b.failed + b.cancelled} of ${n} done`,
          action: { label: "Cancel", onClick: () => void cancelBatch(b.id) },
        });
      } else if (b.cancelled === n) {
        toast("Cancelled", { id: b.id });
        sessionBatches.current.delete(b.id);
      } else if (b.failed === 0) {
        const ran = n - b.cancelled;
        toast.success(
          b.kind === "autotag"
            ? `Auto-tagged ${ran} ${ran === 1 ? "link" : "links"}`
            : b.kind === "extract"
              ? `Extracted ${ran} ${ran === 1 ? "link" : "links"}`
              : `Lens applied to ${ran} ${ran === 1 ? "link" : "links"}`,
          {
            id: b.id,
            description:
              b.usage?.usd != null
                ? `${usd(b.usage.usd)} · ${tokens(b.usage.input_tokens + b.usage.output_tokens)} tokens`
                : undefined,
            action: { label: "Activity", onClick: () => setActivityOpen(true) },
          },
        );
        sessionBatches.current.delete(b.id);
      } else {
        toast[b.failed === n ? "error" : "success"](
          `${verb.replace("ing", "ed")} ${n} ${n === 1 ? "link" : "links"}`,
          {
            id: b.id,
            description: `${b.failed} failed — see Activity`,
            action: { label: "Activity", onClick: () => setActivityOpen(true) },
          },
        );
        sessionBatches.current.delete(b.id);
      }
    }
  }, [library.batches]);

  const showRecentLinks = useCallback(() => {
    setView("all");
    setQuery("");
    setTagIds([]);
    setDomainFilter([]);
    setContext("any");
    setAscending(false);
    listScroll.current?.scrollTo({ top: 0 });
  }, []);

  const save = useCallback(async (url: string, tags: string[] = []) => {
    libraryEpoch.current++;
    const data = await api("/links", "POST", { url, tags });
    libraryEpoch.current++;
    setLibrary(data);
    setLoaded(true);
    showRecentLinks();
    if (data.duplicate) toast.success("Link moved to the top", { description: "Already in your library." });
    else toast.success("Link saved");
  }, [showRecentLinks]);

  const capture = useCallback((text: string) => {
    const parsed = pastedUrls(text);
    if (!parsed.length) {
      toast.error("Paste http or https links, separated by spaces or new lines.");
      return;
    }
    // A second paste while the first request is pending must not send the same URLs again.
    const urls = parsed.filter((url) => !pendingSaves.current.has(url));
    if (!urls.length) {
      toast.loading("Saving links…", {
        id: pendingSaves.current.get(parsed[0]!),
        description: "These links are already being saved.",
      });
      return;
    }
    const id = crypto.randomUUID();
    const count = (n: number) => `${n} ${n === 1 ? "link" : "links"}`;
    const summary = (added: number, existing: number) => [
      added ? `${count(added)} saved` : "",
      existing ? `${count(existing)} moved to the top` : "",
    ].filter(Boolean).join(" · ");
    for (const url of urls) pendingSaves.current.set(url, id);
    setPendingUrls([...pendingSaves.current.keys()]);
    libraryEpoch.current++;
    showRecentLinks();
    toast.loading(`Saving ${count(urls.length)}…`, { id });
    // Serialize separate pastes so an older response cannot replace a newer library snapshot.
    captureQueue.current = captureQueue.current.then(async () => {
      let added = 0, existing = 0, confirmed = 0;
      try {
        for (let offset = 0; offset < urls.length; offset += 100) {
          if (!captureActive.current) return;
          const chunk = urls.slice(offset, offset + 100);
          const data = await api<Library & { imported: number; duplicates: number }>("/import", "POST", { urls: chunk });
          if (!captureActive.current) return;
          libraryEpoch.current++;
          setLibrary(data);
          setLoaded(true);
          setLoadError("");
          added += data.imported;
          existing += data.duplicates;
          confirmed += chunk.length;
          for (const url of chunk) pendingSaves.current.delete(url);
          setPendingUrls([...pendingSaves.current.keys()]);
          toast.loading(`Saving ${count(urls.length)}…`, { id, description: `${confirmed} of ${urls.length} confirmed` });
        }
        toast.success(summary(added, existing), {
          id,
          description: added ? "New links will be processed in the background." : "Already in your library.",
        });
      } catch (e) {
        if (!captureActive.current) return;
        toast.error(confirmed ? summary(added, existing) : "Couldn't confirm the save", {
          id,
          description: `${(e as Error).message} You can paste again to retry; links won't be duplicated.`,
        });
      } finally {
        for (const url of urls) pendingSaves.current.delete(url);
        setPendingUrls([...pendingSaves.current.keys()]);
      }
    });
  }, [showRecentLinks]);

  const mutate = useCallback(async (path: string, method: string, body: unknown = {}) => {
    setLibrary(await api(path, method, body));
  }, []);

  const runBatch = useCallback(
    async (
      kind: "autotag" | "extract" | "lens",
      ids: string[],
      lensId?: string,
    ) => {
      setRunning(true);
      try {
        const { batchIds, skipped } = await submitInChunks<Library & BatchReply>(
          ids,
          (chunk) => api<Library & BatchReply>("/batches", "POST", { kind, ids: chunk, lensId }),
          (data) => setLibrary(data),
        );
        for (const id of batchIds) sessionBatches.current.add(id);
        if (skipped.length)
          toast(`Skipped ${skipped.length} ${skipped.length === 1 ? "link" : "links"} without content`, {
            description: "Extract the content first.",
          });
        await refresh();
      } catch (e) {
        toast.error((e as Error).message);
        throw e;
      } finally {
        setRunning(false);
      }
    },
    [refresh],
  );

  // Keyboard: ⌘K add, / search, Esc close inspector, ↑/↓ navigate while inspector open.
  const filteredRef = useRef<Link[]>([]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog("add");
        return;
      }
      // Browser view has its own search, selection and Escape handling.
      if (view === "browser" && e.key !== "\\") return;
      if (e.key === "/" && !isInput(e.target) && !dialog) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "\\" &&
        !isInput(e.target) &&
        !mobile
      ) {
        e.preventDefault();
        setSidebarOpen((o) => !o);
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "a" &&
        !isInput(e.target) &&
        !dialog
      ) {
        e.preventDefault();
        setPicked(filteredRef.current.map((l) => l.id));
        return;
      }
      if (e.key === "Escape" && !dialog) {
        if (activeId) setActiveId(null);
        else setPicked([]);
        return;
      }
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        activeId &&
        !dialog &&
        !isInput(e.target)
      ) {
        const list = filteredRef.current;
        const i = list.findIndex((l) => l.id === activeId);
        const next = list[i + (e.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          e.preventDefault();
          setActiveId(next.id);
        }
      }
    };
    const paste = (e: ClipboardEvent) => {
      if (isInput(e.target) || dialog || activityOpen) return;
      const urls = e.clipboardData ? clipboardUrls(e.clipboardData) : [];
      if (urls.length) {
        e.preventDefault();
        capture(urls.join("\n"));
      } else if (/https?:\/\//i.test(e.clipboardData?.getData("text/plain") || "")) {
        toast.error("Couldn't read this link list", { description: "Use one URL per line, or copy links with their titles." });
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", paste);
    };
  }, [dialog, activeId, activityOpen, capture, view]);

  useEffect(() => {
    setTagIds((current) => current.filter((id) => library.tags.some((t) => t.id === id)));
    setPicked((current) => current.filter((id) => library.links.some((l) => l.id === id)));
    if (activeId && !library.links.some((l) => l.id === activeId)) setActiveId(null);
  }, [library, activeId]);

  const activeLens =
    typeof view === "object"
      ? (library.lenses.find((l) => l.id === view.id) ?? null)
      : null;
  const activeLensId = activeLens?.id ?? null;
  useEffect(() => {
    setLensFilter(new Set());
    setLensMinLevel(null);
    setLensScoreSort(activeLens?.type === "score");
  }, [activeLensId]);

  const activeLensResults = useMemo(
    () =>
      activeLens
        ? library.links
            .map((l) => l.lens_results.find((r) => r.lens_id === activeLens.id))
            .filter((r): r is LensResult => !!r)
        : [],
    [library.links, activeLens],
  );

  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const resultOf = (l: Link) =>
      activeLens
        ? l.lens_results.find((r) => r.lens_id === activeLens.id)
        : undefined;
    return library.links
      .filter(
        (l) =>
          (!domainFilter.length || domainFilter.includes(l.domain)) &&
          (context === "any" ||
            (context === "with" ? !!l.content_key : !l.content_key)) &&
          (view !== "untagged" || !l.tags.length) &&
          (view !== "attention" || needsAttention(l)) &&
          (!activeLens ||
            (() => {
              const r = resultOf(l);
              if (!r) return false;
              const a = r.answer;
              if (activeLens.type === "noul")
                return (
                  !lensFilter.size ||
                  lensFilter.has(lensBucket(activeLens, r))
                );
              if (activeLens.type === "choice")
                return (
                  !lensFilter.size ||
                  (a.type === "choice" && lensFilter.has(a.choice))
                );
              if (activeLens.type === "multi") {
                if (!lensFilter.size) return true;
                const keys = lensSelectedKeys(activeLens, r);
                return (
                  (lensFilter.has("none") && !keys.length) ||
                  keys.some((k) => lensFilter.has(k))
                );
              }
              if (activeLens.type === "score" && lensMinLevel !== null)
                return a.type === "score" && a.score >= lensMinLevel;
              return true;
            })()) &&
          tagIds.every((id) => l.tags.some((t) => t.id === id)) &&
          words.every((word) =>
            [l.title, l.description, l.domain, l.url, l.original_url, ...l.tags.map((t) => t.name)]
              .join(" ")
              .toLocaleLowerCase()
              .includes(word),
          ),
      )
      .sort((a, b) => {
        if (activeLens?.type === "score" && lensScoreSort) {
          const sa = resultOf(a)?.answer;
          const sb = resultOf(b)?.answer;
          const va = sa?.type === "score" ? sa.score : -1;
          const vb = sb?.type === "score" ? sb.score : -1;
          if (vb !== va) return vb - va;
        }
        return ascending
          ? (a.last_saved_at ?? a.created_at).localeCompare(b.last_saved_at ?? b.created_at)
          : (b.last_saved_at ?? b.created_at).localeCompare(a.last_saved_at ?? a.created_at);
      });
  }, [library.links, query, domainFilter, context, view, tagIds, ascending, activeLens, lensFilter, lensMinLevel, lensScoreSort]);
  filteredRef.current = filtered;

  const domains = useMemo(() => {
    const map = new Map<string, { count: number; favicon: string | null }>();
    for (const l of library.links) {
      const d = map.get(l.domain);
      if (d) {
        d.count++;
        if (!d.favicon && l.favicon) d.favicon = l.favicon;
      } else {
        map.set(l.domain, { count: 1, favicon: l.favicon });
      }
    }
    return [...map.entries()]
      .map(([name, v]) => ({ name, count: v.count, favicon: v.favicon }))
      .sort((a, b) => b.count - a.count);
  }, [library.links]);

  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of library.links)
      for (const t of l.tags) counts[t.id] = (counts[t.id] ?? 0) + 1;
    return counts;
  }, [library.links]);

  const activeLink = library.links.find((l) => l.id === activeId) ?? null;
  const visibleOrder = new Map(filtered.map((link, index) => [link.id, index]));
  const pickedLinks = library.links
    .filter((link) => picked.includes(link.id))
    .sort(
      (a, b) =>
        (visibleOrder.get(a.id) ?? library.links.length) -
        (visibleOrder.get(b.id) ?? library.links.length),
    );
  const activeBatch = library.batches.find((b) => b.active > 0);
  const isFiltered = !!(
    query ||
    domainFilter.length ||
    context !== "any" ||
    tagIds.length ||
    view !== "all"
  );

  const clearFilters = () => {
    setQuery("");
    setDomainFilter([]);
    setContext("any");
    setTagIds([]);
    setLensFilter(new Set());
    setLensMinLevel(null);
    setView("all");
  };

  const toggleTagFilter = (id: string) => {
    if (view === "untagged" || view === "attention") setView("all");
    setTagIds((c) => (c.includes(id) ? c.filter((t) => t !== id) : [...c, id]));
  };

  const toggleDomainFilter = (name: string) => {
    setDomainFilter((c) =>
      c.includes(name) ? c.filter((d) => d !== name) : [...c, name],
    );
  };

  const pickMany = (ids: string[], checked: boolean) =>
    setPicked((cur) =>
      checked
        ? [...new Set([...cur, ...ids])]
        : cur.filter((id) => !ids.includes(id)),
    );

  // Selected links with no content and no extraction on the way: auto-tag skips them unless the user
  // explicitly asks to extract them first (Jev never starts an extraction by itself).
  const noContent = pickedLinks.filter((l) => !l.content_key && l.content_state !== "queued");
  const doAutoTag = async (extract = extractFirst) => {
    setConfirmAutoTag(false);
    setConfirmNoContent(false);
    setExtractFirst(false);
    try {
      const targets = extract ? noContent.filter((l) => !l.processing).map((l) => l.id) : [];
      // The auto-tag jobs of these links wait for their extraction and start when it settles.
      if (targets.length) await runBatch("extract", targets);
      // "Auto-tag N with content" sends only those N; the server still skips any that changed meanwhile.
      await runBatch("autotag", extract ? picked : picked.filter((id) => !noContent.some((l) => l.id === id)));
      if (!extract && noContent.length) toast(`Skipped ${noContent.length} ${noContent.length === 1 ? "link" : "links"} without content`, { description: "Extract the content first." });
      setPicked([]);
    } catch {
      /* toasted */
    }
  };
  const proceedAutoTag = (extract: boolean) => {
    setConfirmNoContent(false);
    if (manualTagged) {
      setExtractFirst(extract);
      setConfirmAutoTag(true);
    } else void doAutoTag(extract);
  };

  const doExtract = async (ids: string[]) => {
    setConfirmExtract(null);
    try {
      await runBatch("extract", ids);
      setPicked((cur) => cur.filter((id) => !ids.includes(id)));
    } catch {
      /* toasted */
    }
  };

  const requestExtract = (ids: string[]) => {
    const targets = library.links.filter((l) => ids.includes(l.id));
    if (targets.length === 1 && !targets[0]!.content_key) {
      void doExtract(ids);
      return;
    }
    setConfirmExtract(ids);
  };

  const cancelBatch = async (id: string) => {
    try {
      const data = await api<Library & { cancelled?: number; dependents?: number }>(
        `/batches/${id}`,
        "DELETE",
      );
      setLibrary(data);
      toast(
        data.cancelled
          ? `Cancelled ${data.cancelled} queued ${data.cancelled === 1 ? "job" : "jobs"}${data.dependents ? `, and ${data.dependents} waiting for that extraction` : ""}`
          : "Nothing left to cancel",
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const manualTagged = pickedLinks.filter((l) =>
    l.tags.some((t) => t.origin === "manual"),
  ).length;


  const sidebar = (
    <Sidebar
      library={library}
      view={view}
      tagIds={tagIds}
      activeBatch={
        activeBatch
          ? {
              label:
                activeBatch.kind === "autotag"
                  ? "Auto-tagging"
                  : activeBatch.kind === "extract"
                    ? "Extracting"
                    : activeBatch.kind === "preview"
                      ? "Fetching preview"
                      : "Applying lens",
              done: activeBatch.done + activeBatch.failed + activeBatch.cancelled,
              total: activeBatch.total,
            }
          : null
      }
      onView={(v) => {
        setView(v);
        setTagIds([]);
        setMenuOpen(false);
      }}
      onToggleTag={(id) => {
        toggleTagFilter(id);
        setMenuOpen(false);
      }}
      onNewTag={() => setDialog({ tag: "new" })}
      onEditTag={(tag) => setDialog({ tag })}
      onDeleteTag={setDeleteTag}
      onOpenLens={(id) => {
        setView({ kind: "lens", id });
        setActiveId(null);
        setMenuOpen(false);
      }}
      onNewLens={() => setDialog({ lens: "new" })}
      onEditLens={(lens) => setDialog({ lens })}
      onDeleteLens={setDeleteLens}
      onActivity={() => {
        setActivityOpen(true);
        setMenuOpen(false);
      }}
      account={account}
      onSignOut={onSignOut}
      browserCount={ws.browser.snapshot ? ws.tabs.length : null}
      browserPanel={
        <BrowserSidebar
          ws={ws}
          onNewGroup={() =>
            browserActions.newGroup(
              ws.tabs.filter((t) => browserPicked.includes(t.tabInstanceId)),
            )
          }
          onEditDestination={browserActions.editDestination}
          onTogglePin={browserActions.togglePin}
          onUngroupAll={(groupId) => void browserActions.ungroupAll(groupId)}
          onSelectGroup={(groupId) =>
            setBrowserPicked(
              ws.tabs.filter((t) => t.groupId === groupId).map((t) => t.tabInstanceId),
            )
          }
          onNewLens={() => setDialog({ lens: "new", scope: "browser" })}
          onEditLens={(lens) => setDialog({ lens })}
          onDeleteLens={setDeleteLens}
          onCleanLens={browserActions.requestClean}
          onReevaluateLens={(lens) => browserActions.reevaluate(lens)}
        />
      }
    />
  );

  const savedTab = useSavedLookup(library);
  const savedUrlSet = useMemo(
    () => new Set(library.links.flatMap((l) => [l.original_url, l.url])),
    [library.links],
  );
  const activeTab =
    view === "browser" ? ws.tabs.find((t) => t.tabInstanceId === ws.activeTabId) ?? null : null;
  const browserInspector = activeTab && (
    <BrowserInspector
      key={activeTab.tabInstanceId}
      tab={activeTab}
      group={ws.groups.find((g) => g.groupId === activeTab.groupId)}
      saved={savedTab(activeTab)}
      preview={ws.previews[activeTab.tabInstanceId]}
      domain={tabDomain(activeTab)}
      lenses={ws.activeLenses}
      records={ws.runner.results[activeTab.tabInstanceId]}
      savedUrls={savedUrlSet}
      read={async (fresh) => {
        const { captures } = await ws.browser.request(
          "capture",
          // With the revision: a tab that navigated meanwhile is refused, never shown with another page's content.
          { tabs: [{ tabId: activeTab.tabId, tabInstanceId: activeTab.tabInstanceId, documentRevision: activeTab.documentRevision }], fresh },
          60_000,
        );
        const c = captures[0];
        if (!c?.capture) throw new Error(c?.error || "The page could not be read.");
        return c.capture;
      }}
      onClose={() => ws.setActiveTabId(null)}
      onFocus={() => browserActions.focus(activeTab)}
      onCopy={() => browserActions.copy(activeTab)}
      onSave={() => void browserActions.save([activeTab])}
      onMove={() => browserActions.chooseMove([activeTab])}
      onUngroup={() => void browserActions.ungroup([activeTab])}
      onCloseTab={() => browserActions.requestClose([activeTab])}
      onRetry={(lens) => browserActions.reevaluate(lens, [activeTab])}
      onMetadata={(lens) => browserActions.evaluateMetadata(lens, activeTab)}
      onAllowAccess={() => void ws.browser.request("openPermissions", {}).catch(() => {})}
      onToggleGroup={ws.toggleGroupFilter}
      onDomainFilter={ws.toggleDomain}
      onSaveRelated={(url) => save(url)}
      jevReason={ws.jevReason}
    />
  );
  const showInspector = view === "browser" ? !!activeTab : !!activeLink;
  const closeInspector = () => (view === "browser" ? ws.setActiveTabId(null) : setActiveId(null));

  const libraryInspector = activeLink && (
    <Inspector
      link={activeLink}
      tags={library.tags}
      lenses={libraryLenses}
      onClose={() => setActiveId(null)}
      onChange={setLibrary}
      onDeleted={() => {
        void refresh();
        setActiveId(null);
      }}
      onRunLens={(lens) => void runBatch("lens", [activeLink.id], lens.id)}
      onOpenLens={(id) => setView({ kind: "lens", id })}
      onToggleTag={toggleTagFilter}
      onAutoTag={() => void runBatch("autotag", [activeLink.id])}
      running={jobsByLink.get(activeLink.id)?.kind ?? null}
      jevReason={jevReason}
      onExtract={() => requestExtract([activeLink.id])}
      onSelectTrack={async (language) => {
        try {
          const data = await api<Library & { batchId?: string }>(`/links/${activeLink.id}/transcript`, "POST", { language });
          setLibrary(data);
          if (data.batchId) sessionBatches.current.add(data.batchId);
        } catch (e) { toast.error((e as Error).message); }
      }}
      onRetry={() => {
        void mutate(`/links/${activeLink.id}/retry`, "POST").catch((e) =>
          toast.error(e.message),
        );
      }}
      onRetryContent={() => {
        void mutate(`/links/${activeLink.id}/retry`, "POST", { step: "content" }).catch((e) =>
          toast.error(e.message),
        );
      }}
      onSaveRelated={(url) => save(url)}
      savedUrls={library.links.flatMap((item) => [item.original_url, item.url])}
      focusTags={focusTags}
    />
  );
  const inspector = view === "browser" ? browserInspector : libraryInspector;

  return (
    <TooltipProvider delayDuration={400}>
    <div
      className="flex h-dvh overflow-hidden"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.some((t) => ["text/uri-list", "text/plain"].includes(t))) {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.some((t) => ["text/uri-list", "text/plain"].includes(t))) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const text =
          e.dataTransfer
            .getData("text/uri-list")
            .split("\n")
            .find((l) => l && !l.startsWith("#")) ||
          e.dataTransfer.getData("text/plain");
        if (text) capture(text);
      }}
    >
      {!mobile && sidebarOpen && (
        <aside className="w-[216px] shrink-0 border-r bg-sidebar animate-in fade-in slide-in-from-left-2 duration-200">
          {sidebar}
        </aside>
      )}
      <Sheet open={mobile && menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent side="left" className="w-[280px] p-0 sm:max-w-[280px]">
          <SheetHeader className="sr-only">
            <SheetTitle>Menu</SheetTitle>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>
      <main className="@container flex min-w-0 flex-1 flex-col">
        {view === "browser" ? (
          <BrowserView
            ws={ws}
            library={library}
            actions={browserActions}
            picked={browserPicked}
            setPicked={setBrowserPicked}
            onToggleSidebar={() =>
              mobile ? setMenuOpen(true) : setSidebarOpen((o) => !o)
            }
            onEditLens={(lens) => setDialog({ lens })}
          />
        ) : (
        <>
        <Toolbar
          view={view}
          lens={activeLens}
          count={filtered.length}
          query={query}
          tagIds={tagIds}
          tags={library.tags}
          domainFilter={domainFilter}
          tagCounts={tagCounts}
          context={context}
          domains={domains}
          ascending={ascending}
          searchRef={search}
          allPicked={
            filtered.length > 0 &&
            filtered.every((l) => picked.includes(l.id))
          }
          somePicked={filtered.some((l) => picked.includes(l.id))}
          onToggleAll={() =>
            filtered.every((l) => picked.includes(l.id))
              ? pickMany(filtered.map((l) => l.id), false)
              : pickMany(filtered.map((l) => l.id), true)
          }
          onQuery={setQuery}
          onToggleDomain={toggleDomainFilter}
          onClearDomains={() => {
            setDomainFilter([]);
            setLensFilter(new Set());
            setLensMinLevel(null);
          }}
          onContext={setContext}
          onToggleTag={toggleTagFilter}
          onRemoveTag={toggleTagFilter}
          onClear={clearFilters}
          onToggleSort={() => setAscending(!ascending)}
          onAdd={() => setDialog("add")}
          onToggleSidebar={() =>
            mobile ? setMenuOpen(true) : setSidebarOpen((o) => !o)
          }
        />
        {activeLens && (
          <LensHeader
            lens={activeLens}
            results={activeLensResults}
            filter={lensFilter}
            minLevel={lensMinLevel}
            scoreSort={lensScoreSort}
            onToggle={(key) =>
              setLensFilter((f) => {
                const next = new Set(f);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onMinLevel={setLensMinLevel}
            onScoreSort={setLensScoreSort}
            onEdit={() => setDialog({ lens: activeLens })}
          />
        )}
        <div ref={listScroll} className={`min-h-0 flex-1 overflow-y-auto ${picked.length ? "pb-24 max-[700px]:pb-32" : ""}`}>
          <PendingLinks urls={pendingNewUrls} />
          {loadError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm font-medium">Couldn't load your library</p>
              <p className="text-xs text-muted-foreground">{loadError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void refresh()
                    .then(() => setLoadError(""))
                    .catch((e) => setLoadError(e.message))
                }
              >
                Retry
              </Button>
            </div>
          ) : pendingNewUrls.length && !library.links.length ? null : (
            <LinkList
              links={filtered}
              loaded={loaded}
              filtered={isFiltered}
              jobsByLink={jobsByLink}
              lens={activeLens}
              activeId={activeId}
              picked={picked}
              onActivate={(id) => {
                setActiveId(id);
                setFocusTags(false);
              }}
              onPicked={(id, c) => pickMany([id], c)}
              onPickedMany={pickMany}
              onAdd={() => setDialog("add")}
              onClearFilters={clearFilters}
              rowActions={{
                onToggleTagFilter: toggleTagFilter,
                onDomainFilter: toggleDomainFilter,
                onEditTags: (link) => {
                  setActiveId(link.id);
                  setFocusTags(true);
                },
                onExtract: (link) => requestExtract([link.id]),
                onRetry: (link, step) =>
                  void mutate(`/links/${link.id}/retry`, "POST", step ? { step } : {}).catch((e) =>
                    toast.error(e.message),
                  ),
                onDismiss: (link) =>
                  void mutate(`/links/${link.id}/dismiss`, "POST").catch((e) =>
                    toast.error(e.message),
                  ),
                onUsePreview: (link) =>
                  void mutate(`/links/${link.id}/use-preview`, "POST").catch((e) =>
                    toast.error(e.message),
                  ),
                onDelete: setDeleteLink,
                onCopyUrl: (link) => {
                  void navigator.clipboard.writeText(link.url);
                  toast("URL copied");
                },
              }}
            />
          )}
        </div>
        </>
        )}
      </main>
      {showInspector && !narrow && (
        <aside
          className="relative shrink-0 border-l animate-in fade-in slide-in-from-right-2 duration-200"
          style={{ width: inspectorWidth }}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            className="absolute inset-y-0 -left-1 z-20 w-1.5 cursor-col-resize hover:bg-brand/40 active:bg-brand/60"
            onDoubleClick={() => {
              inspectorW.current = 400;
              setInspectorWidth(400);
              localStorage.setItem("linklog.inspector", "400");
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              const handle = e.currentTarget;
              handle.setPointerCapture(e.pointerId);
              document.body.style.cursor = "col-resize";
              document.body.style.userSelect = "none";
              const move = (ev: PointerEvent) => {
                const w = Math.min(
                  Math.max(window.innerWidth - ev.clientX, 320),
                  Math.min(720, window.innerWidth * 0.6),
                );
                inspectorW.current = w;
                setInspectorWidth(w);
              };
              const up = () => {
                handle.removeEventListener("pointermove", move);
                document.body.style.cursor = "";
                document.body.style.userSelect = "";
                localStorage.setItem(
                  "linklog.inspector",
                  String(inspectorW.current),
                );
              };
              handle.addEventListener("pointermove", move);
              handle.addEventListener("pointerup", up, { once: true });
            }}
          />
          {inspector}
        </aside>
      )}
      <Sheet
        open={showInspector && narrow}
        onOpenChange={(o) => !o && closeInspector()}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full p-0 sm:max-w-[400px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{view === "browser" ? activeTab?.title : activeLink?.title}</SheetTitle>
          </SheetHeader>
          {inspector}
        </SheetContent>
      </Sheet>
      {!!picked.length && view !== "browser" && (
        <SelectionBar
          links={pickedLinks}
          tags={library.tags}
          lenses={libraryLenses}
          running={running}
          jevReason={jevReason}
          openReason={openLinks.reason(pickedLinks.length)}
          opening={openLinks.opening}
          onOpen={() => void openLinks.open(pickedLinks)}
          onAutoTag={() => {
            if (noContent.length) setConfirmNoContent(true);
            else proceedAutoTag(false);
          }}
          onLens={(lens) =>
            void runBatch("lens", picked, lens.id).then(() => setPicked([]))
          }
          onNewLens={() => setDialog({ lens: "new" })}
          onExtract={() => requestExtract(picked)}
          onClear={() => setPicked([])}
        />
      )}
      {dialog === "add" && (
        <AddLinkDialog
          tags={library.tags}
          onClose={() => setDialog(null)}
          onSave={save}
          onImport={capture}
        />
      )}
      {dialog && typeof dialog === "object" && "lens" in dialog && (
        <LensDialog
          lens={dialog.lens}
          scope={dialog.scope ?? (dialog.lens === "new" ? "library" : dialog.lens.scope)}
          templates={libraryLenses}
          selectedCount={picked.length}
          runBlocked={jevReason}
          onClose={() => setDialog(null)}
          onSave={async (draft: LensDraft) => {
            const { runNow, ...body } = draft;
            const lib =
              dialog.lens === "new"
                ? await api<Library>("/lenses", "POST", body)
                : await api<Library>(
                    `/lenses/${(dialog.lens as Lens).id}`,
                    "PATCH",
                    body,
                  );
            setLibrary(lib);
            toast.success(
              dialog.lens === "new" ? "Lens created" : "Lens updated",
            );
            if (dialog.lens === "new" && draft.scope === "browser") {
              // A new browser lens starts on: it covers every tab of this window.
              const created = lib.lenses.find(
                (l) => l.name.toLowerCase() === draft.name.toLowerCase(),
              );
              if (created) ws.activate(created.id);
            }
            if (runNow && picked.length) {
              const lens = lib.lenses.find(
                (l) => l.name.toLowerCase() === draft.name.toLowerCase(),
              );
              if (lens) await runBatch("lens", picked, lens.id);
            }
          }}
        />
      )}
      {dialog && typeof dialog === "object" && "tag" in dialog && (
        <TagDialog
          tag={dialog.tag}
          onClose={() => setDialog(null)}
          onChange={setLibrary}
          linkCount={(id) =>
            library.links.filter((l) => l.tags.some((t) => t.id === id)).length
          }
        />
      )}
      <AlertDialog open={!!deleteLink} onOpenChange={(o) => !o && setDeleteLink(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this link?</AlertDialogTitle>
            <AlertDialogDescription className="truncate">
              {deleteLink?.title}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteLink) return;
                try {
                  await mutate(`/links/${deleteLink.id}`, "DELETE");
                  toast.success("Link deleted");
                  if (activeId === deleteLink.id) setActiveId(null);
                } catch (e) {
                  toast.error((e as Error).message);
                }
                setDeleteLink(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!deleteTag} onOpenChange={(o) => !o && setDeleteTag(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTag?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              It will be removed from{" "}
              {deleteTag
                ? library.links.filter((l) => l.tags.some((t) => t.id === deleteTag.id)).length
                : 0}{" "}
              links. Scores are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteTag) return;
                try {
                  await mutate(`/tags/${deleteTag.id}`, "DELETE");
                  toast.success("Tag deleted");
                } catch (e) {
                  toast.error((e as Error).message);
                }
                setDeleteTag(null);
              }}
            >
              Delete tag
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!deleteLens} onOpenChange={(o) => !o && setDeleteLens(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteLens?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Its{" "}
              {deleteLens
                ? library.links.reduce(
                    (n, l) =>
                      n +
                      l.lens_results.filter((r) => r.lens_id === deleteLens.id)
                        .length,
                    0,
                  )
                : 0}{" "}
              results are removed too.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteLens) return;
                try {
                  setLibrary(
                    await api<Library>(`/lenses/${deleteLens.id}`, "DELETE"),
                  );
                  if (typeof view === "object" && view.id === deleteLens.id)
                    setView("all");
                  toast.success("Lens deleted");
                } catch (e) {
                  toast.error((e as Error).message);
                }
                setDeleteLens(null);
              }}
            >
              Delete lens
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmNoContent} onOpenChange={setConfirmNoContent}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {noContent.length} of {picked.length} {picked.length === 1 ? "link has" : "links have"} no content yet
            </AlertDialogTitle>
            <AlertDialogDescription>
              Auto-tag reads the page content. Extract it first and those links are auto-tagged as soon as it's ready
              {noContent.length < picked.length ? ", or auto-tag only the links that already have content." : "."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {noContent.length < picked.length && (
              <AlertDialogAction variant="outline" onClick={() => proceedAutoTag(false)}>
                Auto-tag {picked.length - noContent.length} with content
              </AlertDialogAction>
            )}
            <AlertDialogAction onClick={() => proceedAutoTag(true)}>Extract, then auto-tag</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={confirmAutoTag}
        onOpenChange={(o) => {
          setConfirmAutoTag(o);
          if (!o) setExtractFirst(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Auto-tag replaces existing tags</AlertDialogTitle>
            <AlertDialogDescription>
              {manualTagged} {manualTagged === 1 ? "link has" : "links have"} manually added
              tags. Auto-tagging replaces all tags on each link with the AI
              result.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void doAutoTag()}>
              Auto-tag {picked.length} {picked.length === 1 ? "link" : "links"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={!!confirmExtract}
        onOpenChange={(o) => !o && setConfirmExtract(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Extract context for {confirmExtract?.length}{" "}
              {confirmExtract?.length === 1 ? "link" : "links"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const withContent = (confirmExtract ?? []).filter(
                  (id) =>
                    library.links.find((l) => l.id === id)?.content_key,
                ).length;
                return withContent
                  ? `${withContent} of ${confirmExtract?.length} already have context — extracting again replaces it and uses browser time.`
                  : "This fetches each page in a headless browser.";
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmExtract && void doExtract(confirmExtract)}
            >
              Extract
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ActivitySheet
        open={activityOpen}
        batches={library.batches}
        onOpenChange={setActivityOpen}
        onLibrary={setLibrary}
      />
      {dragging && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-center">
            <Link2 className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">Drop to save</p>
          </div>
        </div>
      )}
      <BrowserDialogs ws={ws} controller={browserController} />
      <Toaster position="bottom-right" />
    </div>
    </TooltipProvider>
  );
}
