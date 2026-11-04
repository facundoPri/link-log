import type { BrowserTab, LoadRunView, LoadState, SleepReason } from "@linklog/browser-protocol";

/** Inspector and tooltip detail; the row only ever says "Sleeping". */
export const SLEEP_DETAIL: Record<SleepReason, string> = {
  unloaded: "Chrome unloaded it to save memory.",
  frozen: "Chrome froze it in the background.",
  "not-loaded": "Chrome restored it at startup but never loaded it.",
};

export const LOAD_LABEL: Record<LoadState, string> = {
  queued: "Queued",
  loading: "Loading",
  capturing: "Capturing",
  "putting-to-sleep": "Putting to sleep",
  done: "Loaded",
  failed: "Couldn't load",
  skipped: "Skipped",
};
export const LOAD_IN_PROGRESS: LoadState[] = ["queued", "loading", "capturing", "putting-to-sleep"];

export const LOAD_NOTE = "Loading opens each site in the background with your browser session, a few tabs at a time, then puts it back to sleep.";
export const SLEEP_WARNING = "Frees memory. A page with unsaved changes, such as a half-filled form, may lose them.";

/** Sleeping with nothing captured, or stuck loading: Load content would help. */
export const needsLoad = (t: BrowserTab) => (t.content === "sleeping" && !t.capturedAt) || t.content === "stalled";
export const canLoad = (t: BrowserTab) => t.content === "sleeping" || t.content === "stalled";

/** Why Put to sleep would skip this tab, or null. Mirrors the extension's check. */
export function sleepBlocked(t: BrowserTab): string | null {
  if (t.content === "sleeping") return "Already asleep";
  if (t.content === "restricted") return "Chrome doesn't allow putting this page to sleep";
  if (t.active) return "It's the active tab";
  if (t.audible) return "It's playing audio or video";
  return null;
}

/** Why Load content would skip this tab, or null. */
export function loadBlocked(t: BrowserTab): string | null {
  if (t.content === "restricted") return "Chrome doesn't let extensions read this page";
  if (t.content === "no-permission") return "Allow page content access first";
  if (!canLoad(t)) return "Already loaded";
  return null;
}

export const runActive = (run: LoadRunView | null | undefined) => !!run && (run.status === "running" || run.status === "paused");
