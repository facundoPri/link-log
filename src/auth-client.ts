import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";
import { signOutFlow } from "./session";

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

// Work that must run while the session is still valid, e.g. the Browser view asking the extension
// to forget this account's cached results. Each hook gets a short deadline; sign-out never waits on it.
const beforeSignOut = new Set<() => Promise<unknown>>();
export function onBeforeSignOut(hook: () => Promise<unknown>) {
  beforeSignOut.add(hook);
  return () => void beforeSignOut.delete(hook);
}

/**
 * Signs out on the server, then drops everything this browser kept for the account and reloads
 * from a clean slate. Rejects (SignOutError) without clearing anything if the server did not
 * confirm, so the caller can show it and retry.
 */
export function signOutAndReset() {
  return signOutFlow({
    beforeSignOut: () =>
      Promise.race([
        Promise.allSettled([...beforeSignOut].map((hook) => hook())),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]),
    signOut: () => authClient.signOut(),
    clearLocal: () => {
      try {
        for (const key of Object.keys(localStorage)) if (key.startsWith("linklog.")) localStorage.removeItem(key);
        sessionStorage.clear();
      } catch {}
    },
    reload: () => window.location.replace("/"),
  });
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
