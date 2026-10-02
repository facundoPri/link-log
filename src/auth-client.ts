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

// Cleanup that must only happen once the server confirmed the sign-out, e.g. the Browser view
// asking the extension to forget this account's cached results and group metadata. Each hook gets
// a short deadline; the reload never waits longer. Privacy across accounts does not depend on it
// (the extension reads per account scope); this just leaves nothing behind.
const signedOut = new Set<() => Promise<unknown>>();
export function onSignedOut(hook: () => Promise<unknown>) {
  signedOut.add(hook);
  return () => void signedOut.delete(hook);
}

/**
 * Signs out on the server, then (only if confirmed) runs the signed-out hooks, drops what this
 * browser kept for the account and reloads from a clean slate. Rejects (SignOutError) without
 * touching anything if the server did not confirm, so the caller can show it and retry.
 */
export function signOutAndReset() {
  return signOutFlow({
    signOut: () => authClient.signOut(),
    afterSignOut: () =>
      Promise.race([
        Promise.allSettled([...signedOut].map((hook) => hook())),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]),
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
