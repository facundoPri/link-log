import { useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from "react";
import { CircleAlert, CircleCheck, KeyRound, Link2, Link2Off, Loader2, Mail, MailCheck } from "lucide-react";
import { authClient, devFixtures } from "../auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import "./auth-screen.css";

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

// Roomier controls than the app's compact defaults: these pages have one job each.
const control = "h-11 rounded-xl px-3.5 text-base md:text-[15px]";
const action = "h-11 w-full rounded-xl text-[15px] font-medium";
const inlineLink = "h-auto rounded-sm p-0 text-sm font-medium text-foreground";

function Shell({ title, subtitle, badge, children }: { title: string; subtitle?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-screen flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center px-5 sm:px-8">
        <span className="flex items-center gap-2">
          <span className="flex size-6 items-center justify-center rounded-md bg-brand">
            <Link2 className="size-3.5 text-brand-foreground" strokeWidth={2.5} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Linklog</span>
        </span>
      </header>
      {/* Top-anchored rather than centered, so switching forms never moves the heading. */}
      <main className="flex flex-1 justify-center px-5 pt-[clamp(16px,10vh,112px)] pb-16">
        <div key={title} className="w-full max-w-[360px] animate-in duration-200 fade-in-0">
          <div className="mb-8 flex flex-col items-center text-center">
            {badge && <span className="mb-5 flex size-12 items-center justify-center rounded-full bg-muted [&_svg]:size-6">{badge}</span>}
            <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.02em] text-balance">{title}</h1>
            {subtitle && <p className="mt-2 text-[15px] leading-6 text-balance text-muted-foreground">{subtitle}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

function Field({ id, label, hint, children, ...input }: { id: string; label: string; hint?: ReactNode; children?: ReactNode } & ComponentProps<"input">) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} className={control} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && (
        <p id={`${id}-hint`} className="text-[13px] leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

// Both live regions stay mounted (empty when idle) so screen readers announce what lands in them.
function Notices({ notice }: { notice: Notice }) {
  const callout = (tone: "info" | "error") =>
    notice?.tone === tone && (
      <p
        className={cn(
          "mt-4 flex gap-2.5 rounded-xl border px-3.5 py-3 text-[13px] leading-5 animate-in duration-200 fade-in-0 slide-in-from-top-1",
          tone === "error" ? "border-destructive/25 bg-destructive/[0.06]" : "border-brand/20 bg-brand-soft/60",
        )}
      >
        {tone === "error" ? <CircleAlert className="mt-0.5 size-4 text-destructive" aria-hidden /> : <MailCheck className="mt-0.5 size-4 text-brand" aria-hidden />}
        <span>{notice.text}</span>
      </p>
    );
  return (
    <>
      <div role="alert">{callout("error")}</div>
      <div role="status">{callout("info")}</div>
    </>
  );
}

function Submit({ busy, children }: { busy: boolean; children: string }) {
  return (
    <Button type="submit" disabled={busy} className={cn(action, "mt-5", busy && "cursor-progress disabled:opacity-100")}>
      {/* The label stays put while pending; the spinner sits just left of it. */}
      <span className="relative">
        {busy && <Loader2 className="absolute top-1/2 right-full mr-2 size-4 -translate-y-1/2 animate-spin motion-reduce:animate-none" aria-hidden />}
        {children}
      </span>
    </Button>
  );
}

const COPY: Record<Mode, { title: string; subtitle: string; submit: string }> = {
  "sign-in": { title: "Sign in", subtitle: "Welcome back to your link library.", submit: "Sign in" },
  "sign-up": { title: "Create your account", subtitle: "Start a library for everything worth keeping.", submit: "Create account" },
  magic: { title: "Email me a sign-in link", subtitle: "We'll email you a link that signs you in.", submit: "Send link" },
  forgot: { title: "Reset your password", subtitle: "Enter your account email and we'll send you a link to choose a new one.", submit: "Send reset link" },
};
// [prompt, button, target] under the form.
const SWITCH: Record<Mode, [string, string, Mode]> = {
  "sign-in": ["New to Linklog?", "Create an account", "sign-up"],
  "sign-up": ["Already have an account?", "Sign in with a password", "sign-in"],
  magic: ["New to Linklog?", "Create an account", "sign-up"],
  forgot: ["Remembered it?", "Back to sign in", "sign-in"],
};

export function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(linkErrorNotice);
  // Bumped by every submit and mode switch: an answer that arrives after either is dropped, so a
  // slow request can't put its notice on another form or re-enable a newer one mid-request.
  const attempt = useRef(0);
  const fixtures = devFixtures();

  const go = (next: Mode) => {
    attempt.current++;
    setMode(next);
    setNotice(null);
    setBusy(false);
  };

  const send = async (): Promise<Notice> => {
    if (mode === "sign-in") {
      const { error } = await authClient.signIn.email({ email, password });
      if (error) return { tone: "error", text: message(error, "Could not sign in.") };
      // Even if the form changed meanwhile, the session now exists: let the gate pick it up.
      window.history.replaceState(null, "", "/");
      onSignedIn();
      return null;
    }
    if (mode === "sign-up") {
      const { error } = await authClient.signUp.email({
        email,
        password,
        name: email.split("@")[0] || "Linklog user",
        callbackURL: "/",
      });
      if (error) return { tone: "error", text: message(error, "Could not create the account.") };
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
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const id = ++attempt.current;
    setBusy(true);
    setNotice(null);
    let result: Notice;
    try {
      result = await send();
    } catch {
      result = { tone: "error", text: "Something went wrong. Try again." };
    }
    if (id !== attempt.current) return;
    setBusy(false);
    setNotice(result);
    if (mode === "sign-up" && result?.tone === "info") setPassword("");
  };

  const copy = COPY[mode];
  const [prompt, switchLabel, switchTo] = SWITCH[mode];
  const alternative = mode === "magic" ? { icon: <KeyRound />, label: "Sign in with a password", to: "sign-in" as const } : { icon: <Mail />, label: "Email me a sign-in link", to: "magic" as const };

  return (
    <Shell title={copy.title} subtitle={copy.subtitle}>
      <form onSubmit={submit}>
        <div className="space-y-4">
          <Field
            id="auth-email"
            label="Email"
            type="email"
            name="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {(mode === "sign-in" || mode === "sign-up") && (
            <Field
              id="auth-password"
              label="Password"
              type="password"
              name="password"
              required
              minLength={mode === "sign-up" ? 10 : undefined}
              maxLength={128}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={mode === "sign-up" && "At least 10 characters. You'll confirm your email before signing in."}
            >
              {mode === "sign-in" && (
                <Button type="button" variant="link" className={cn(inlineLink, "text-muted-foreground hover:text-foreground")} onClick={() => go("forgot")}>
                  Forgot password?
                </Button>
              )}
            </Field>
          )}
          {mode === "magic" && (
            <p className="text-[13px] leading-5 text-muted-foreground">
              New here? The link also creates your account. If you created an account with a password but never confirmed the email, using a link removes that password; set a new one later with “Forgot password”.
            </p>
          )}
        </div>
        <Notices notice={notice} />
        <Submit busy={busy}>{copy.submit}</Submit>
      </form>

      {mode !== "forgot" && (
        <>
          <div className="my-5 flex items-center gap-3 text-xs font-medium tracking-wide text-muted-foreground uppercase before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
            or
          </div>
          <Button type="button" variant="outline" className={cn(action, "shadow-none")} onClick={() => go(alternative.to)}>
            {alternative.icon}
            {alternative.label}
          </Button>
        </>
      )}

      <p className="mt-8 text-center text-sm text-muted-foreground">
        {prompt}{" "}
        <Button type="button" variant="link" className={inlineLink} onClick={() => go(switchTo)}>
          {switchLabel}
        </Button>
      </p>

      {fixtures.length > 0 && mode === "sign-in" && (
        <div className="mt-8 space-y-2.5 rounded-xl border border-dashed p-3.5">
          <p className="text-xs text-muted-foreground">Local demo accounts (disposable state only). Fills the form; sign-in stays real.</p>
          <div className="flex flex-wrap gap-2">
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
  const [notice, setNotice] = useState<Notice>(null);
  const toSignIn = () => window.location.replace("/");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setNotice({ tone: "error", text: "The passwords don't match." });
    setBusy(true);
    setNotice(null);
    try {
      const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? "" });
      if (error) setNotice({ tone: "error", text: message(error, "This reset link is invalid or expired. Request a new one.") });
      else setDone(true);
    } catch {
      setNotice({ tone: "error", text: "Something went wrong. Try again." });
    } finally {
      setBusy(false);
    }
  };

  if (done)
    return (
      <Shell title="Password updated" subtitle="Your other sessions were signed out. Sign in with the new password." badge={<CircleCheck className="text-brand" />}>
        <Button className={action} onClick={toSignIn}>Go to sign in</Button>
      </Shell>
    );
  if (!token || params.get("error"))
    return (
      <Shell
        title="Reset link expired"
        subtitle="This reset link is invalid or expired. Go back and choose “Forgot password?” to get a new one."
        badge={<Link2Off className="text-muted-foreground" />}
      >
        <Button className={action} onClick={toSignIn}>Back to sign in</Button>
      </Shell>
    );
  return (
    <Shell title="Choose a new password" subtitle="Saving it signs out your other sessions.">
      <form onSubmit={submit}>
        <div className="space-y-4">
          <Field
            id="reset-password"
            label="New password"
            type="password"
            name="new-password"
            required
            minLength={10}
            maxLength={128}
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            hint="At least 10 characters."
          />
          <Field
            id="reset-confirm"
            label="Confirm new password"
            type="password"
            name="confirm-password"
            required
            minLength={10}
            maxLength={128}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        <Notices notice={notice} />
        <Submit busy={busy}>Save password</Submit>
      </form>
      <p className="mt-8 text-center text-sm">
        <Button type="button" variant="link" className={cn(inlineLink, "text-muted-foreground hover:text-foreground")} onClick={toSignIn}>
          Back to sign in
        </Button>
      </p>
    </Shell>
  );
}
