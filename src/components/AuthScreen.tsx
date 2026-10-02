import { useState, type FormEvent, type ReactNode } from "react";
import { Link2 } from "lucide-react";
import { authClient, devFixtures } from "../auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "sign-in" | "sign-up" | "magic" | "forgot";
type Notice = { tone: "info" | "error"; text: string } | null;

// Errors arrive as ?error=… after a failed verification or magic-link click.
function linkErrorNotice(): Notice {
  const error = new URLSearchParams(window.location.search).get("error");
  if (!error) return null;
  return {
    tone: "error",
    text: /expired|invalid|token/i.test(error)
      ? "That link is invalid, expired or already used. Request a new one."
      : "That link could not be used. Try again.",
  };
}

function message(error: { message?: string; code?: string; status?: number } | null | undefined, fallback: string) {
  if (!error) return fallback;
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  if (error.code === "EMAIL_NOT_VERIFIED")
    return "Confirm your email first. If your last link expired, we just sent a new one.";
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") return "Wrong email or password.";
  if (error.code === "PASSWORD_TOO_SHORT") return "Use at least 10 characters.";
  return error.message || fallback;
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Link2 className="size-4" />
          Linklog
        </div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {children}
      </div>
    </div>
  );
}

function NoticeText({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
      {notice.text}
    </p>
  );
}

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(linkErrorNotice);
  const fixtures = devFixtures();

  const go = (next: Mode) => {
    setMode(next);
    setNotice(null);
  };
  const run = async (fn: () => Promise<Notice | void>) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await fn();
      if (result) setNotice(result);
    } catch {
      setNotice({ tone: "error", text: "Something went wrong. Try again." });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mode === "sign-in") {
        const { error } = await authClient.signIn.email({ email, password });
        if (error) return { tone: "error", text: message(error, "Could not sign in.") };
        window.history.replaceState(null, "", "/");
        onSignedIn();
        return;
      }
      if (mode === "sign-up") {
        const { error } = await authClient.signUp.email({
          email,
          password,
          name: email.split("@")[0] || "Linklog user",
          callbackURL: "/",
        });
        if (error) return { tone: "error", text: message(error, "Could not create the account.") };
        setPassword("");
        // Same answer whether or not the address already has an account.
        return { tone: "info", text: `Check ${email} for a confirmation link. It expires in 1 hour.` };
      }
      if (mode === "magic") {
        const { error } = await authClient.signIn.magicLink({
          email,
          callbackURL: "/",
          newUserCallbackURL: "/",
          errorCallbackURL: "/",
        });
        if (error) return { tone: "error", text: message(error, "Could not send the link.") };
        return { tone: "info", text: `If ${email} can sign in, a link is on its way. It works once and expires in 5 minutes.` };
      }
      const { error } = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
      if (error) return { tone: "error", text: message(error, "Could not send the reset link.") };
      return { tone: "info", text: `If ${email} has an account, a reset link is on its way. It expires in 1 hour.` };
    });
  };

  const title = { "sign-in": "Sign in", "sign-up": "Create your account", magic: "Email me a sign-in link", forgot: "Reset your password" }[mode];
  const needsPassword = mode === "sign-in" || mode === "sign-up";

  return (
    <Shell title={title}>
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="auth-email">Email</Label>
          <Input id="auth-email" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        {needsPassword && (
          <div className="space-y-1.5">
            <Label htmlFor="auth-password">Password</Label>
            <Input
              id="auth-password"
              type="password"
              required
              minLength={mode === "sign-up" ? 10 : undefined}
              maxLength={128}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {mode === "sign-up" && <p className="text-xs text-muted-foreground">At least 10 characters. You'll confirm your email before signing in.</p>}
          </div>
        )}
        {mode === "magic" && (
          <p className="text-xs text-muted-foreground">
            New here? The link also creates your account. If you created an account with a password but never confirmed the email, using a link removes that password; set a new one later with “Forgot password”.
          </p>
        )}
        <NoticeText notice={notice} />
        <Button type="submit" className="w-full" disabled={busy}>
          {{ "sign-in": "Sign in", "sign-up": "Create account", magic: "Send link", forgot: "Send reset link" }[mode]}
        </Button>
      </form>
      <div className="flex flex-col gap-1 text-xs">
        {mode !== "sign-in" && <Button variant="link" size="sm" className="h-auto justify-start p-0" onClick={() => go("sign-in")}>Sign in with a password</Button>}
        {mode !== "magic" && <Button variant="link" size="sm" className="h-auto justify-start p-0" onClick={() => go("magic")}>Email me a sign-in link</Button>}
        {mode !== "sign-up" && <Button variant="link" size="sm" className="h-auto justify-start p-0" onClick={() => go("sign-up")}>Create an account</Button>}
        {mode === "sign-in" && <Button variant="link" size="sm" className="h-auto justify-start p-0" onClick={() => go("forgot")}>Forgot password?</Button>}
      </div>
      {fixtures.length > 0 && mode === "sign-in" && (
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <p className="text-xs text-muted-foreground">Local demo accounts (disposable state only). Fills the form; sign-in stays real.</p>
          <div className="flex gap-2">
            {fixtures.map((f) => (
              <Button key={f.email} type="button" variant="outline" size="sm" onClick={() => { setEmail(f.email); setPassword(f.password); }}>
                {f.label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

export function ResetPasswordScreen() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<Notice>(
    !token || params.get("error") ? { tone: "error", text: "This reset link is invalid or expired. Request a new one." } : null,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setNotice({ tone: "error", text: "The passwords don't match." });
    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? "" });
    setBusy(false);
    if (error) return setNotice({ tone: "error", text: message(error, "This reset link is invalid or expired. Request a new one.") });
    setDone(true);
  };

  if (done)
    return (
      <Shell title="Password updated">
        <p className="text-sm text-muted-foreground">Your other sessions were signed out. Sign in with the new password.</p>
        <Button className="w-full" onClick={() => window.location.replace("/")}>Go to sign in</Button>
      </Shell>
    );
  return (
    <Shell title="Choose a new password">
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="reset-password">New password</Label>
          <Input id="reset-password" type="password" required minLength={10} maxLength={128} autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="reset-confirm">Repeat it</Label>
          <Input id="reset-confirm" type="password" required minLength={10} maxLength={128} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <NoticeText notice={notice} />
        <Button type="submit" className="w-full" disabled={busy || !token}>Save password</Button>
      </form>
      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => window.location.replace("/")}>Back to sign in</Button>
    </Shell>
  );
}
