// R3: a sign-out the server did not confirm is reported, never disguised as a reload, and cleans
// up nothing (the extension's cache, group metadata and handshake stay); cleanup runs only after a
// confirmed sign-out or a 401 (session already gone).
// R7: the auth screen stays mounted while Better Auth re-checks an anonymous session.
import { describe, expect, test } from "bun:test";
import { gateView, signOutFlow, SignOutError } from "../src/session";

describe("sign-out (R3)", () => {
  function deps(signOut: () => Promise<{ error?: { status?: number } | null }>) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        signOut: async () => (calls.push("signOut"), signOut()),
        afterSignOut: async () => void calls.push("cleanup"),
        clearLocal: () => void calls.push("clear"),
        reload: () => void calls.push("reload"),
      },
    };
  }

  test("confirmed: clears this browser's account state and reloads", async () => {
    const { calls, deps: d } = deps(async () => ({ error: null }));
    await signOutFlow(d);
    expect(calls).toEqual(["signOut", "cleanup", "clear", "reload"]);
  });

  for (const [name, signOut] of [
    ["HTTP 503", async () => ({ error: { status: 503, message: "Service unavailable" } })],
    ["HTTP 429", async () => ({ error: { status: 429 } })],
    ["network failure", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ] as const)
    test(`${name}: rejects with a visible error and keeps the page (no silent reload)`, async () => {
      const { calls, deps: d } = deps(signOut);
      await expect(signOutFlow(d)).rejects.toBeInstanceOf(SignOutError);
      // Nothing was cleaned up: no extension forget, no local storage cleared, no reload.
      expect(calls).toEqual(["signOut"]);
      // A retry that succeeds then completes the sign-out.
      d.signOut = async () => (calls.push("signOut"), { error: null });
      await signOutFlow(d);
      expect(calls.slice(-4)).toEqual(["signOut", "cleanup", "clear", "reload"]);
    });

  test("401: the session was already gone, so the page resets", async () => {
    const { calls, deps: d } = deps(async () => ({ error: { status: 401 } }));
    await signOutFlow(d);
    expect(calls).toEqual(["signOut", "cleanup", "clear", "reload"]);
  });
});

describe("session gate (R7)", () => {
  test("only the first lookup shows loading; an anonymous refetch keeps the auth screen", () => {
    expect(gateView({ isPending: true, hasSession: false, settled: false })).toBe("loading");
    expect(gateView({ isPending: false, hasSession: false, settled: true })).toBe("auth");
    // Sign-up triggers a session refetch: still the same auth screen (notice and form survive).
    expect(gateView({ isPending: true, hasSession: false, settled: true })).toBe("auth");
    // Never the private app without a session; a signed-in refetch keeps the app.
    expect(gateView({ isPending: false, hasSession: true, settled: true })).toBe("app");
    expect(gateView({ isPending: true, hasSession: true, settled: true })).toBe("app");
  });
});
