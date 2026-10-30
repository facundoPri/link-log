import { useRef, useState } from "react";
import { toast } from "sonner";
import { BROWSER_LIMITS, type OpenOutcome } from "@linklog/browser-protocol";
import { plural } from "../lib/format";
import type { Link } from "../types";
import type { BrowserState } from "./useBrowser";

/** Why links can't be opened through the extension right now, or null. */
export function openUnavailable({ connection, hello }: Pick<BrowserState, "connection" | "hello">): string | null {
  switch (connection) {
    case "unsupported":
      return "Opening links needs desktop Chrome with the Linklog extension";
    case "missing":
      return "Install or enable the Linklog extension to open links";
    case "outdated":
      return "Update the Linklog extension to open links";
    case "reload":
      return "Reload this page to reconnect the extension";
    case "checking":
    case "reconnecting":
      return "Connecting to the Linklog extension…";
    case "connected":
      if (!hello) return "Connecting to the Linklog extension…";
      return hello.capabilities.includes("open") ? null : "Update the Linklog extension to open links";
  }
}

export const openLimitReason = (count: number) =>
  count > BROWSER_LIMITS.maxOpenUrls ? `Open up to ${BROWSER_LIMITS.maxOpenUrls} links at once` : null;

export type OpenSummary = { kind: "success" | "error"; message: string; description?: string };

const MAX_LISTED_FAILURES = 3;

export function summarizeOpen(items: OpenOutcome[], links: Pick<Link, "url" | "title">[]): OpenSummary {
  const opened = items.filter((i) => i.outcome === "opened").length;
  const already = items.filter((i) => i.outcome === "already-open").length;
  const failed = items.filter((i) => i.outcome === "failed");
  if (!failed.length) {
    const message = !opened
      ? `${plural(already, "link")} already open`
      : `Opened ${plural(opened, "link")}${already ? ` · ${already} already open` : ""}`;
    return { kind: "success", message };
  }
  const titles = new Map<string, string>();
  for (const l of links) if (!titles.has(l.url)) titles.set(l.url, l.title || l.url);
  const listed = failed.slice(0, MAX_LISTED_FAILURES).map((f) => `${titles.get(f.url) ?? f.url}: ${f.error}`);
  if (failed.length > listed.length) listed.push(`+${failed.length - listed.length} more`);
  return {
    kind: "error",
    message: `Opened ${opened + already} of ${plural(items.length, "link")}`,
    description: listed.join("; "),
  };
}

export function useOpenLinks(browser: BrowserState) {
  const [opening, setOpening] = useState(false);
  const busy = useRef(false);
  const { request } = browser;

  // A retry re-sends the same operationId and URLs: the extension replays what it opened and
  // skips what is already there, so retrying an unconfirmed request can't duplicate tabs.
  async function attempt(operationId: string, urls: string[], links: Link[]) {
    if (busy.current) return;
    busy.current = true;
    setOpening(true);
    const action = { label: "Retry", onClick: () => void attempt(operationId, urls, links) };
    try {
      const { items } = await request("openTabs", { operationId, urls }, 30_000);
      const summary = summarizeOpen(items, links);
      if (summary.kind === "success") toast.success(summary.message);
      else toast.error(summary.message, { description: summary.description, action, duration: 10_000 });
    } catch (error) {
      toast.error("Couldn't confirm which links opened", { description: (error as Error).message, action, duration: 10_000 });
    } finally {
      busy.current = false;
      setOpening(false);
    }
  }

  return {
    reason: (count: number) => openUnavailable(browser) ?? openLimitReason(count),
    opening,
    open: async (links: Link[]) => {
      const urls = [...new Set(links.map((l) => l.url))];
      if (urls.length) await attempt(crypto.randomUUID(), urls, links);
    },
  };
}
