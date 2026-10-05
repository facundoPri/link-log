import type { AppConfig } from "./config";
import { charge, LIMITS, sha256 } from "./limits";

export type AuthEmailKind = "verify" | "magic" | "reset";
export type AuthEmail = { kind: AuthEmailKind; to: string; url: string };

const COPY: Record<AuthEmailKind, { subject: string; intro: string; action: string; expiry: string }> = {
  verify: {
    subject: "Confirm your Linklog email",
    intro: "Confirm this address to finish creating your Linklog account.",
    action: "Confirm email",
    expiry: "This link expires in 1 hour.",
  },
  magic: {
    subject: "Your Linklog sign-in link",
    intro: "Use this link to sign in to Linklog. It works once.",
    action: "Sign in",
    expiry: "This link expires in 5 minutes.",
  },
  reset: {
    subject: "Reset your Linklog password",
    intro: "Someone asked to reset the password for this address. Signing in with the new password ends your other sessions.",
    action: "Choose a new password",
    expiry: "This link expires in 1 hour.",
  },
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function renderAuthEmail({ kind, to, url }: AuthEmail) {
  const copy = COPY[kind];
  const footer = `Requested for ${to}. If you did not ask for this, ignore this email.`;
  return {
    subject: copy.subject,
    text: `${copy.intro}\n\n${copy.action}: ${url}\n\n${copy.expiry}\n${footer}\n`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>${escapeHtml(copy.intro)}</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#111;color:#fff;border-radius:6px;text-decoration:none">${escapeHtml(copy.action)}</a></p>
<p style="color:#555;font-size:13px">${escapeHtml(copy.expiry)}<br>${escapeHtml(footer)}</p>
</body></html>`,
  };
}

/**
 * Sends auth email without blocking the response (timing parity between known and unknown
 * addresses). Logs only kind and outcome: never the address, URL, token or body.
 */
export function createMailer(env: Env, config: AppConfig, waitUntil: (p: Promise<unknown>) => void) {
  async function deliver(email: AuthEmail) {
    const recipient = email.to.trim().toLowerCase();
    // Both budgets or neither: a send refused by one cap must not use up the other.
    const allowed = await charge(env.DB, [
      { key: "email:day", limit: { window: 86400, max: config.emailDailyLimit }, cost: 1 },
      { key: `email:to:${await sha256(recipient)}`, limit: LIMITS.emailPerRecipient, cost: 1 },
    ]);
    if (!allowed) {
      console.warn(JSON.stringify({ event: "auth_email", kind: email.kind, outcome: "suppressed_limit" }));
      return;
    }
    try {
      await env.EMAIL.send({ to: recipient, from: config.emailFrom, ...renderAuthEmail({ ...email, to: recipient }) });
      console.log(JSON.stringify({ event: "auth_email", kind: email.kind, outcome: "accepted" }));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
      console.error(JSON.stringify({ event: "auth_email", kind: email.kind, outcome: "failed", code }));
    }
  }
  return {
    send(email: AuthEmail) {
      waitUntil(deliver(email).catch(() => console.error(JSON.stringify({ event: "auth_email", kind: email.kind, outcome: "error" }))));
    },
  };
}
