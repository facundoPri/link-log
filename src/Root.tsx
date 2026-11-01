import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { App } from "./App";
import { authClient, onUnauthorized, signOutAndReset } from "./auth-client";
import { AuthScreen, ResetPasswordScreen } from "./components/AuthScreen";
import { SettingsPage } from "./components/SettingsPage";
import { gateView } from "./session";

// Two signed-in pages: the library and /settings. Back/forward switch between them; pushState
// fires no popstate of its own, so navigate() sends one.
const subscribePath = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
};
const navigate = (to: string) => {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

/**
 * Session gate. The SPA shell is public; the library only loads for a signed-in user, and the API
 * enforces ownership regardless of what this component renders.
 */
export function Root() {
  const { data, isPending, refetch } = authClient.useSession();
  // Any 401 from the library API means the session ended (expiry, revocation, sign-out elsewhere).
  useEffect(() => onUnauthorized(() => void refetch()), [refetch]);
  const settled = useRef(false);
  const path = useSyncExternalStore(subscribePath, () => window.location.pathname);
  if (!isPending) settled.current = true;

  const signOut = useCallback(() => {
    void signOutAndReset().catch((error: Error) =>
      toast.error(error.message, { duration: 10000, action: { label: "Retry", onClick: () => signOut() } }),
    );
  }, []);

  if (path === "/reset-password") return <ResetPasswordScreen />;
  const view = gateView({ isPending, hasSession: !!data, settled: settled.current });
  if (view === "loading") return <div className="min-h-dvh bg-background" aria-busy="true" />;
  if (view === "auth" || !data) return <AuthScreen onSignedIn={() => void refetch()} />;
  const account = { email: data.user.email };
  if (path === "/settings") return <SettingsPage key={data.user.id} account={account} onSignOut={signOut} onBack={() => navigate("/")} />;
  // Keyed by user: switching accounts remounts App, so no state from the previous user survives.
  return <App key={data.user.id} account={account} onSignOut={signOut} onSettings={() => navigate("/settings")} />;
}
