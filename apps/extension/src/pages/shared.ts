import { CONTENT_ORIGINS, LINKLOG_URL } from "../config";

export type Status = {
  version: string;
  contentAccess: boolean;
  connectedPages: number;
  /** Tabs with a connected Linklog page. */
  linklogTabs: number[];
  origins: string[];
  cache: { bytes: number; quota: number; captureBytes: number };
};

export function status(): Promise<Status | null> {
  return chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
}

export async function openLinklog() {
  // A tab whose Linklog page is connected right now; otherwise open the configured URL.
  const [tabId] = (await status())?.linklogTabs ?? [];
  const existing = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else await chrome.tabs.create({ url: LINKLOG_URL });
}

export function requestContent() {
  // Must run inside the click handler: Chrome requires a user gesture.
  return chrome.permissions.request({ origins: CONTENT_ORIGINS });
}

export function revokeContent() {
  return chrome.permissions.remove({ origins: CONTENT_ORIGINS });
}

export function kb(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
