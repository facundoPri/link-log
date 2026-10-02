import { useEffect } from "react";
import { App } from "./App";
import { authClient, onUnauthorized, signOutAndReset } from "./auth-client";
import { AuthScreen, ResetPasswordScreen } from "./components/AuthScreen";

/**
 * Session gate. The SPA shell is public; the library only loads for a signed-in user, and the API
 * enforces ownership regardless of what this component renders.
 */
export function Root() {
  const { data, isPending, refetch } = authClient.useSession();
  // Any 401 from the library API means the session ended (expiry, revocation, sign-out elsewhere).
  useEffect(() => onUnauthorized(() => void refetch()), [refetch]);

  if (window.location.pathname === "/reset-password") return <ResetPasswordScreen />;
  if (isPending) return <div className="min-h-dvh bg-background" aria-busy="true" />;
  if (!data) return <AuthScreen onSignedIn={() => void refetch()} />;
  // Keyed by user: switching accounts remounts App, so no state from the previous user survives.
  return <App key={data.user.id} account={{ email: data.user.email }} onSignOut={() => void signOutAndReset()} />;
}
