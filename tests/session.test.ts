// R3: a sign-out the server did not confirm is reported, never disguised as a reload.
// R7: the auth screen stays mounted while Better Auth re-checks an anonymous session.
import { describe, expect, test } from "bun:test";
import { gateView, signOutFlow, SignOutError } from "../src/session";

describe("sign-out (R3)", () => {
  function deps(signOut: () => Promise<{ error?: { status?: number } | null }>) {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        beforeSignOut: async () => void calls.push("before"),
        signOut: async () => (calls.push("signOut"), signOut()),
        clearLocal: () => void calls.push("clear"),
        reload: () => void calls.push("reload"),
      },
    };
  }

  test("confirmed: clears this browser's account state and reloads", async () => {
    const { calls, deps: d } = deps(async () => ({ error: null }));
    await signOutFlow(d);
    expect(calls).toEqual(["before", "signOut", "clear", "reload"]);
  });

  for (const [name, signOut] of [
    ["HTTP 503", async () => ({ error: { status: 503, message: "Service unavailable" } })],
    ["HTTP 429", async () => ({ error: { status: 429 } })],
    ["network failure", async () => Promise.reject(new TypeError("Failed to fetch"))],
  ] as const)
    test(`${name}: rejects with a visible error and keeps the page (no silent reload)`, async () => {
      const { calls, deps: d } = deps(signOut);
      await expect(signOutFlow(d)).rejects.toBeInstanceOf(SignOutError);
      expect(calls).toEqual(["before", "signOut"]);
      // A retry that succeeds then completes the sign-out.
      d.signOut = async () => (calls.push("signOut"), { error: null });
      await signOutFlow(d);
      expect(calls.slice(-3)).toEqual(["signOut", "clear", "reload"]);
    });

  test("401: the session was already gone, so the page resets", async () => {
    const { calls, deps: d } = deps(async () => ({ error: { status: 401 } }));
    await signOutFlow(d);
    expect(calls).toContain("reload");
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
