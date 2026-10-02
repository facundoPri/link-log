import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

// Same origin as the UI: the Worker serves /api/auth in production, the Bun proxy forwards it locally.
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [magicLinkClient()],
});

const UNAUTHORIZED = "linklog:unauthorized";
export const announceUnauthorized = () => window.dispatchEvent(new Event(UNAUTHORIZED));
export function onUnauthorized(listener: () => void) {
  window.addEventListener(UNAUTHORIZED, listener);
  return () => window.removeEventListener(UNAUTHORIZED, listener);
}

/** Drops everything this browser kept for the previous account, then reloads from a clean slate. */
export async function signOutAndReset() {
  try {
    await authClient.signOut();
  } finally {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith("linklog.")) localStorage.removeItem(key);
      sessionStorage.clear();
    } catch {}
    window.location.replace("/");
  }
}

export type DevFixture = { label: string; email: string; password: string };
/** Only the local demo server inlines this (scripts/demo.ts); scripts/build.ts refuses to bundle it. */
export function devFixtures(): DevFixture[] {
  try {
    const raw = process.env.BUN_PUBLIC_LINKLOG_DEV_FIXTURES;
    return raw ? (JSON.parse(raw) as DevFixture[]) : [];
  } catch {
    return [];
  }
}
