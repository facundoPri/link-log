import { CONTENT_ORIGINS, LINKLOG_ORIGINS } from "../config";

export type Status = {
  version: string;
  contentAccess: boolean;
  connectedPages: number;
  origins: string[];
  cache: { bytes: number; quota: number; captureBytes: number };
};

export function status(): Promise<Status | null> {
  return chrome.runtime.sendMessage({ type: "status" }).catch(() => null);
}

export async function openLinklog() {
  const patterns = LINKLOG_ORIGINS.map((o) => `${o}/*`);
  const [existing] = patterns.length ? await chrome.tabs.query({ url: patterns }) : [];
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else if (LINKLOG_ORIGINS[0]) await chrome.tabs.create({ url: LINKLOG_ORIGINS[0] });
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
