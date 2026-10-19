import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { App } from "./App";
import { authClient, onUnauthorized, signOutAndReset } from "./auth-client";
import { AuthScreen, ResetPasswordScreen } from "./components/AuthScreen";
import { gateView } from "./session";

/**
 * Session gate. The SPA shell is public; the library only loads for a signed-in user, and the API
 * enforces ownership regardless of what this component renders.
 */
export function Root() {
  const { data, isPending, refetch } = authClient.useSession();
  // Any 401 from the library API means the session ended (expiry, revocation, sign-out elsewhere).
  useEffect(() => onUnauthorized(() => void refetch()), [refetch]);
  const settled = useRef(false);
  if (!isPending) settled.current = true;

  const signOut = useCallback(() => {
    void signOutAndReset().catch((error: Error) =>
      toast.error(error.message, { duration: 10000, action: { label: "Retry", onClick: () => signOut() } }),
    );
  }, []);

  if (window.location.pathname === "/reset-password") return <ResetPasswordScreen />;
  const view = gateView({ isPending, hasSession: !!data, settled: settled.current });
  if (view === "loading") return <div className="min-h-dvh bg-background" aria-busy="true" />;
  if (view === "auth" || !data) return <AuthScreen onSignedIn={() => void refetch()} />;
  // Keyed by user: switching accounts remounts App, so no state from the previous user survives.
  return <App key={data.user.id} account={{ email: data.user.email }} onSignOut={signOut} />;
}
