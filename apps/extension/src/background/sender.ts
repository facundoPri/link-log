import { isBridgeOrigin, originOf } from "@linklog/browser-protocol";

type Sender = {
  id?: string;
  tab?: { id?: number; url?: string };
  frameId?: number;
  origin?: string;
  url?: string;
  documentLifecycle?: string;
};

/**
 * The manifest match patterns are not enough: accept a bridge connection only from
 * this extension's content script, in the top frame of a tab, on a bridge origin
 * (local http on any port, or a configured Linklog origin). The content script
 * itself only connects on pages that identify as Linklog.
 */
export function isBridgeSender(sender: Sender, extensionId: string, configured: readonly string[]): boolean {
  if (sender.id !== extensionId) return false;
  if (!sender.tab || typeof sender.tab.id !== "number" || sender.tab.id < 0) return false;
  if (sender.frameId !== 0) return false;
  if (sender.documentLifecycle && sender.documentLifecycle !== "active") return false;
  const origin = sender.origin ?? (sender.url ? originOf(sender.url) : null);
  if (!origin || !isBridgeOrigin(origin, configured)) return false;
  // The tab must currently show that origin too (not a stale document).
  const tabOrigin = sender.tab.url ? originOf(sender.tab.url) : origin;
  return tabOrigin === origin;
}

/** Messages from our own extension pages (popup, connect page), never from content scripts. */
export function isExtensionPage(sender: Sender, extensionId: string, baseUrl: string): boolean {
  return sender.id === extensionId && !!sender.url && sender.url.startsWith(baseUrl);
}
