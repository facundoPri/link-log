import {
  BROWSER_LIMITS,
  documentKey,
  jsonBytes,
  PROTOCOL_VERSION,
  toEvaluationTarget,
  type ClaimTarget,
  type Commands,
  type ItemResult,
  type OpenOutcome,
  type PageRequest,
  type TabPreview,
  type TabRef,
} from "@linklog/browser-protocol";
import { EXTENSION_VERSION } from "../config";
import type { ResultCache } from "./cache";
import { captureTab, CaptureError, metadataCapture, previewTab } from "./capture";
import type { GroupMetaStore } from "./groups";
import type { Connection, Hub } from "./hub";
import type { OpenLedger } from "./opens";
import type { TabRegistry } from "./registry";

export type Services = {
  registry: TabRegistry;
  cache: ResultCache;
  groups: GroupMetaStore;
  hub: Hub;
  opens: OpenLedger;
  ids: { installationId: string; browserSessionId: string };
};

type Handler<K extends keyof Commands> = (
  args: Commands[K]["args"],
  ctx: { c: Connection; windowId: number; s: Services },
) => Promise<Commands[K]["result"]>;

class CommandError extends Error {}
const fail = (message: string): never => {
  throw new CommandError(message);
};

/** Revalidates a page-supplied reference against Chrome: never trust ids from the page. */
async function ownTab(ref: TabRef, windowId: number, s: Services): Promise<chrome.tabs.Tab> {
  const tab = await chrome.tabs.get(ref.tabId).catch(() => null);
  if (!tab) return fail("The tab is already closed.");
  if (tab.windowId !== windowId) return fail("The tab is no longer in this window.");
  const instance = s.registry.get(ref.tabId);
  if (instance?.tabInstanceId !== ref.tabInstanceId) return fail("The tab was replaced.");
  if (ref.documentRevision !== undefined && instance.documentRevision !== ref.documentRevision)
    return fail("The tab navigated to another page.");
  if (s.hub.isLinklog(tab)) return fail("Linklog pages are not managed from Browser.");
  return tab;
}

async function each<T extends TabRef>(
  refs: T[],
  windowId: number,
  s: Services,
  check?: (tab: chrome.tabs.Tab, ref: T) => string | null,
): Promise<{ ok: chrome.tabs.Tab[]; items: ItemResult[] }> {
  const ok: chrome.tabs.Tab[] = [];
  const items: ItemResult[] = [];
  for (const ref of refs) {
    try {
      const tab = await ownTab(ref, windowId, s);
      const problem = check?.(tab, ref);
      if (problem) items.push({ tabId: ref.tabId, ok: false, error: problem });
      else {
        ok.push(tab);
        items.push({ tabId: ref.tabId, ok: true });
      }
    } catch (error) {
      items.push({ tabId: ref.tabId, ok: false, error: (error as Error).message });
    }
  }
  return { ok, items };
}

function requireScope(c: Connection): string {
  return c.scope ?? fail("Connect first.");
}

function isWebUrl(url: string) {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** A capture belongs to the document the caller expected; a navigation in between is an error. */
function sameDocument(capture: { url: string }, expectedUrl: string) {
  if (capture.url && documentKey(capture.url) !== documentKey(expectedUrl))
    fail("The tab navigated while it was being read.");
}

async function groupInWindow(groupId: number, windowId: number) {
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group || group.windowId !== windowId) fail("The group is not in this window any more.");
  return group!;
}

// Metadata previews are tiny and cheap to re-read; memory is enough (lost when the worker sleeps).
const previewCache = new Map<string, TabPreview>();
const PREVIEW_CACHE_MAX = 500;

const handlers: { [K in keyof Commands]: Handler<K> } = {
  async hello(args, { c, windowId, s }) {
    c.scope = args.libraryScope;
    c.windowId = windowId;
    return {
      protocol: PROTOCOL_VERSION,
      extensionVersion: EXTENSION_VERSION,
      installationId: s.ids.installationId,
      browserSessionId: s.ids.browserSessionId,
      windowId,
      capabilities: ["tabs", "groups", "lenses", "capture", "save", "close", "open", "forget"],
      contentAccess: s.hub.granted,
    };
  },
  async forget(_args, { c, s }) {
    const scope = requireScope(c);
    const result = await s.cache.forget(scope);
    await s.groups.forget(scope);
    c.scope = null;
    return result;
  },
  async snapshot(_args, { c, s }) {
    requireScope(c);
    return s.hub.fullSnapshot(c);
  },
  async results(args, { c, windowId, s }) {
    const scope = requireScope(c);
    const snap = await s.hub.snapshot(windowId, c.scope);
    return {
      results: await s.cache.read(
        scope,
        s.ids.browserSessionId,
        snap.tabs.map((t) => ({ tabInstanceId: t.tabInstanceId, documentRevision: t.documentRevision })),
        args.lenses,
      ),
    };
  },
  async claim(args, { c, windowId, s }) {
    const scope = requireScope(c);
    const source = args.source ?? "dom";
    const snap = await s.hub.snapshot(windowId, c.scope);
    const explicit = args.tabInstanceIds ? new Set(args.tabInstanceIds) : null;
    // Activating a lens covers every eligible tab in the window, whatever is selected
    // or filtered in the page. Only an explicit retry narrows it.
    const candidates = snap.tabs.map((t) => ({
      tabInstanceId: t.tabInstanceId,
      documentRevision: t.documentRevision,
      eligible:
        (!explicit || explicit.has(t.tabInstanceId)) &&
        (source === "metadata" ? !!explicit && t.status !== "loading" : t.content === "available"),
    }));
    const { requestId, claimed, skipped } = await s.cache.claim({
      scope,
      session: s.ids.browserSessionId,
      lens: args.lens,
      candidates,
      force: args.force && explicit ? explicit : undefined,
      limit: args.limit ?? 20,
      resumeRequestId: args.resumeRequestId,
    });
    if (!requestId) return { requestId: null, targets: [], skipped, attempted: [] };
    const targets: ClaimTarget[] = [];
    const summaries = new Map<string, ClaimTarget["capture"]>();
    const failures = new Map<string, string>();
    const overflow = new Set<string>();
    // Budget in UTF-8 bytes of exactly what the page will POST for these targets.
    const budget = BROWSER_LIMITS.maxRequestBytes - BROWSER_LIMITS.requestOverheadBytes;
    let bytes = 0;
    let full = false;
    for (const claim of claimed) {
      const tab = snap.tabs.find((t) => t.tabInstanceId === claim.tabInstanceId)!;
      if (full) {
        overflow.add(claim.targetKey);
        continue;
      }
      try {
        // One capture per document revision serves every lens in the batch.
        let capture = await s.cache.getCapture(claim.tabInstanceId, claim.documentRevision, source);
        if (!capture) {
          capture = source === "metadata" ? metadataCapture(tab) : await captureTab(tab.tabId);
          sameDocument(capture, tab.url);
          await s.cache.putCapture(claim.tabInstanceId, claim.documentRevision, source, capture);
        }
        const target: ClaimTarget = { ...claim, tabId: tab.tabId, url: tab.url, title: tab.title, capture };
        const size = jsonBytes(toEvaluationTarget(target)) + 1;
        if (targets.length && bytes + size > budget) {
          // Keeps each POST under the Worker's body cap; the page claims the rest next.
          overflow.add(claim.targetKey);
          full = true;
          continue;
        }
        bytes += size;
        summaries.set(claim.targetKey, capture);
        targets.push(target);
      } catch (error) {
        failures.set(claim.targetKey, error instanceof CaptureError ? error.message : "The page could not be read.");
      }
    }
    await s.cache.recordCapture(
      requestId,
      new Map(
        [...summaries].map(([k, cap]) => [
          k,
          {
            source: cap.source,
            capturedAt: cap.capturedAt,
            completeness: cap.completeness,
            reasons: cap.reasons,
            chars: cap.chars,
            facts: cap.facts,
          },
        ]),
      ),
      failures,
    );
    if (overflow.size) await s.cache.unclaim(requestId, overflow);
    s.hub.broadcast({ event: "results-changed", windowId }, windowId);
    const attempted = claimed.filter((c) => !overflow.has(c.targetKey)).map((c) => c.tabInstanceId);
    return { requestId: targets.length ? requestId : null, targets, skipped: skipped + overflow.size, attempted };
  },
  async accepted(args, { c, windowId, s }) {
    await s.cache.accepted(args.requestId, args.batchId, args.jobs, requireScope(c));
    s.hub.broadcast({ event: "results-changed", windowId });
    return {};
  },
  async release(args, { c, windowId, s }) {
    await s.cache.release(args.requestId, args.error, args.state, requireScope(c));
    s.hub.broadcast({ event: "results-changed", windowId });
    return {};
  },
  async pending(_args, { c, s }) {
    return { requests: await s.cache.pending(requireScope(c)) };
  },
  async deposit(args, { c, windowId, s }) {
    const result = await s.cache.deposit(
      args.requestId,
      args.batchId,
      args.items,
      (id) => {
        const tabId = s.registry.tabIdOf(id);
        return tabId === undefined ? undefined : s.registry.get(tabId)?.documentRevision;
      },
      requireScope(c),
    );
    if (result.stored.length) s.hub.broadcast({ event: "results-changed", windowId });
    return result;
  },
  async clean(args, { c, windowId, s }) {
    const snap = await s.hub.snapshot(windowId, c.scope);
    const inWindow = snap.tabs.map((t) => t.tabInstanceId);
    const scope = args.tabInstanceIds ? inWindow.filter((id) => args.tabInstanceIds!.includes(id)) : inWindow;
    const result = await s.cache.clean(args.lensIds, scope);
    s.hub.broadcast({ event: "results-changed", windowId });
    return result;
  },
  async capture(args, { c, windowId, s }) {
    const captures: Commands["capture"]["result"]["captures"] = [];
    for (const ref of args.tabs) {
      try {
        const tab = await ownTab(ref, windowId, s);
        const instance = s.registry.get(ref.tabId)!;
        const source = args.source ?? "dom";
        let capture = args.fresh ? null : await s.cache.getCapture(ref.tabInstanceId, instance.documentRevision, source);
        if (!capture) {
          if (source === "dom" && (tab.discarded || tab.status !== "complete"))
            fail(tab.discarded ? "The tab is not loaded." : "The tab is still loading.");
          capture = source === "metadata" ? metadataCapture(tab) : await captureTab(ref.tabId);
          sameDocument(capture, tab.url || "");
          // Navigated while it was read: the capture belongs to another document.
          if (s.registry.get(ref.tabId)?.documentRevision !== instance.documentRevision)
            fail("The tab navigated while it was being read.");
          await s.cache.putCapture(ref.tabInstanceId, instance.documentRevision, source, capture);
        }
        captures.push({ tabId: ref.tabId, capture });
      } catch (error) {
        captures.push({ tabId: ref.tabId, error: (error as Error).message });
      }
    }
    return { captures };
  },
  async previews(args, { c, windowId, s }) {
    // Only tabs the extension may read and that finished loading; the rest keep title + favicon.
    const snap = await s.hub.snapshot(windowId, c.scope);
    const readable = new Map(snap.tabs.filter((t) => t.content === "available").map((t) => [t.tabInstanceId, t]));
    const wanted = args.tabs.filter((r) => readable.get(r.tabInstanceId)?.tabId === r.tabId);
    const previews: TabPreview[] = [];
    let next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const ref = wanted[next++]!;
        const tab = readable.get(ref.tabInstanceId)!;
        const key = `${tab.tabInstanceId}~${tab.documentRevision}`;
        let preview = previewCache.get(key);
        if (!preview) {
          try {
            preview = { tabInstanceId: tab.tabInstanceId, documentRevision: tab.documentRevision, ...(await previewTab(tab.tabId)) };
          } catch {
            continue;
          }
          if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!);
          previewCache.set(key, preview);
        }
        previews.push(preview);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return { previews };
  },
  async closeTabs(args, { windowId, s }) {
    // Close exactly what was selected, and only if it is still the same page.
    const { ok, items } = await each(args.tabs, windowId, s, (tab, ref) =>
      documentKey(tab.url || tab.pendingUrl || "") === documentKey(ref.url) ? null : "The tab navigated to another page.",
    );
    const closed = new Set<number>();
    for (const tab of ok) {
      try {
        await chrome.tabs.remove(tab.id!);
        closed.add(tab.id!);
      } catch (error) {
        const item = items.find((i) => i.tabId === tab.id)!;
        item.ok = false;
        item.error = (error as Error).message || "Chrome refused to close the tab.";
      }
    }
    s.hub.schedule(0);
    return { items };
  },
  async moveToGroup(args, { c, windowId, s }) {
    const scope = requireScope(c);
    const { ok, items } = await each(args.tabs, windowId, s, (tab) =>
      // Autogroup keeps tabs that already have a group, even if one was added while Jev ran.
      args.onlyIfUngrouped && tab.groupId !== undefined && tab.groupId >= 0 ? "Already in a group — kept." : null,
    );
    const tabIds = ok.map((t) => t.id!) as [number, ...number[]];
    if (!tabIds.length) return { items, groupId: null };
    const target = args.target;
    let groupId: number;
    if (target.kind === "group") {
      await groupInWindow(target.groupId, windowId);
      groupId = await chrome.tabs.group({ groupId: target.groupId, tabIds });
    } else {
      // A pinned destination reuses its binding in this window; names never merge groups.
      const bound =
        target.kind === "pinned"
          ? (
              await Promise.all(
                s.groups.groupsBoundTo(target.pinnedId, scope).map((id) => chrome.tabGroups.get(id).catch(() => null)),
              )
            ).find((g) => g?.windowId === windowId)
          : null;
      if (bound) groupId = await chrome.tabs.group({ groupId: bound.id, tabIds });
      else {
        groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, { title: target.title, color: target.color });
        await s.groups.set(
          groupId,
          { description: target.description, pinnedId: target.kind === "pinned" ? target.pinnedId : null },
          scope,
        );
      }
    }
    s.hub.schedule(0);
    return { items, groupId };
  },
  async ungroup(args, { windowId, s }) {
    const { ok, items } = await each(args.tabs, windowId, s, (tab) =>
      tab.groupId === undefined || tab.groupId < 0 ? "Not in a group." : null,
    );
    if (ok.length) await chrome.tabs.ungroup(ok.map((t) => t.id!) as [number, ...number[]]);
    s.hub.schedule(0);
    return { items };
  },
  async updateGroup(args, { c, windowId, s }) {
    await groupInWindow(args.groupId, windowId);
    if (args.title !== undefined || args.color !== undefined)
      await chrome.tabGroups.update(args.groupId, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.color !== undefined ? { color: args.color } : {}),
      });
    if (args.description !== undefined || args.pinnedId !== undefined)
      await s.groups.set(
        args.groupId,
        {
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.pinnedId !== undefined ? { pinnedId: args.pinnedId } : {}),
        },
        requireScope(c),
      );
    s.hub.schedule(0);
    return {};
  },
  async unbindPinned(args, { c, s }) {
    const groups = await s.groups.unbindPinned(args.pinnedId, requireScope(c));
    s.hub.schedule(0);
    return { groups };
  },
  async focusTab(args, { windowId, s }) {
    const tab = await ownTab(args.tab, windowId, s);
    await chrome.tabs.update(tab.id!, { active: true });
    return {};
  },
  async openTabs(args, { c, windowId, s }) {
    const scope = requireScope(c);
    const items = await s.opens.run(scope, args.operationId, async (ledger) => {
      const present = new Set(
        (await chrome.tabs.query({ windowId })).map((t) => documentKey(t.url || t.pendingUrl || "")),
      );
      const items: OpenOutcome[] = [];
      for (const url of args.urls) {
        if (ledger.has(url)) {
          items.push({ url, outcome: "opened" });
          continue;
        }
        if (!isWebUrl(url)) {
          items.push({ url, outcome: "failed", error: "Only web links can be opened." });
          continue;
        }
        const key = documentKey(url);
        if (present.has(key)) {
          items.push({ url, outcome: "already-open" });
          continue;
        }
        try {
          const tab = await chrome.tabs.create({ url, windowId, active: false });
          present.add(key);
          await ledger.record(url, tab.id!);
          items.push({ url, outcome: "opened" });
        } catch (error) {
          items.push({ url, outcome: "failed", error: (error as Error).message || "Chrome could not open the tab." });
        }
      }
      return items;
    });
    s.hub.schedule(0);
    return { items };
  },
  async openPermissions(_args, { c, windowId }) {
    const tab = await chrome.tabs.get(c.tabId).catch(() => null);
    await chrome.tabs.create({
      url: chrome.runtime.getURL("connect.html"),
      windowId,
      index: tab ? tab.index + 1 : undefined,
    });
    return {};
  },
};

export async function handle(request: PageRequest, c: Connection, s: Services) {
  // Nothing but the handshake is accepted before a successful hello on this connection.
  if (request.command !== "hello") requireScope(c);
  // The window is always the sender tab's current window, resolved from Chrome.
  const tab = await chrome.tabs.get(c.tabId);
  const handler = handlers[request.command] as Handler<typeof request.command>;
  return handler(request.args as never, { c, windowId: tab.windowId, s });
}

