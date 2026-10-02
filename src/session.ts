// Session decisions shared by the gate and the sign-out flow, free of browser/React imports so
// they are unit-tested directly (tests/session.test.ts).

export type GateView = "loading" | "auth" | "app";

/**
 * What Root renders. Loading only covers the very first session lookup: a later refetch without a
 * session (e.g. right after sign-up, when Better Auth re-checks the session) keeps the auth screen
 * mounted, so its notice ("check your email") and form survive. A signed-in user stays on the app.
 */
export function gateView(state: { isPending: boolean; hasSession: boolean; settled: boolean }): GateView {
  if (state.hasSession) return "app";
  if (state.isPending && !state.settled) return "loading";
  return "auth";
}

export class SignOutError extends Error {}

/**
 * Ends the session on the server, then clears this browser's account state and reloads. If the
 * server did not confirm (HTTP error or network failure) nothing is cleared and the error is
 * thrown, so the UI can say so and offer a retry. 401 means the session was already gone.
 */
export async function signOutFlow(deps: {
  beforeSignOut: () => Promise<unknown>;
  signOut: () => Promise<{ error?: { status?: number; message?: string } | null }>;
  clearLocal: () => void;
  reload: () => void;
}) {
  await deps.beforeSignOut();
  let error: { status?: number; message?: string } | null | undefined;
  try {
    ({ error } = await deps.signOut());
  } catch {
    throw new SignOutError("Could not reach Linklog to sign out. Check your connection and try again.");
  }
  if (error && error.status !== 401) throw new SignOutError("Could not sign out. You are still signed in; try again.");
  deps.clearLocal();
  deps.reload();
}
