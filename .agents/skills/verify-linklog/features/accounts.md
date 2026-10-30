# Accounts and privacy

Each library is private to its account. A user signs up with email and password and verifies the address from an emailed link, or signs in with a password or a one-time magic link (5 minutes). They can reset a forgotten password, which ends their other sessions, and sign out. Another account never sees their links, tags or lenses. Locally, email is simulated: Wrangler writes each message to a file under the run directory.

## Sub-features

- `auth-sign-in` signs in with email and password.
- `auth-sign-out` signs out from the account menu in the sidebar footer.
- `auth-sign-up` creates an account, which must be verified from the emailed link before the library opens.
- `auth-magic` signs in from an emailed `Sign in:` link.
- `auth-reset` sets a new password from an emailed `Choose a new password:` link and ends other sessions.
- `auth-isolation` keeps Demo B from seeing Demo A's links, tags or lenses.

## How to get to it (user POV)

- Signed out, the auth screen shows `Sign in` with `Email` and `Password` fields. `Create an account`, `Email me a sign-in link` and the forgot-password link switch modes.
- Signed in, the account button in the sidebar footer (the user's email) has `Sign out`.
- Email links are opened from the inbox. Here that means files under `<run>/.wrangler/tmp/email/*/email-text/`.

## Driving it with verify.ts

Preconditions:

- The baseline from `README.md`.
- To act as a signed-out visitor, run `await page.context().clearCookies(); await page.reload()`. A real sign-out also works.
- To read mail, run `const { waitForMail } = await import(process.cwd() + "/scripts/lib/local-mail.ts")` with `process.env.LINKLOG_MAIL_DIR = "<run>/.wrangler/tmp/email"`. `waitForMail(email, "verify" | "magic" | "reset", since)` returns the link.

- **Sign out.** Click the sidebar footer button named `d demo-a@linklog.test` (its initial and email), then `Sign out`. The auth screen titled `Sign in` appears, and `GET /api/library` without a session answers 401.
- **Sign in.** Fill `Email` with `demo-a@linklog.test` and `Password` with `linklog-demo-a-password`, then click the submit button `Sign in`. The library appears with Demo A's email in the footer.
- **Sign up.** Click `Create an account` and fill `Email` (a new `@linklog.test` address) and `Password`, then click `Create account`. A status asks the user to check their email. Open the `verify` link from `waitForMail` in the page. The library opens, signed in, and empty.
- **Magic link.** Click `Email me a sign-in link`, fill `Email`, and click `Send link`. Open the `magic` link. The library opens signed in.
  A magic link to an email with no account creates one. A magic link to an email with an unverified password account removes that password; the screen says so.
- **Reset.** Use the forgot-password link, fill `Email`, and click `Send password link`. Open the `reset` link, fill `New password` and `Confirm new password`, and submit. Signing in with the new password works, and a session from before the reset gets 401.
- **Isolation.** Save `fixture("article", "a-only")` as Demo A. `pageAs(1)` (Demo B) does not list it, `apiAs(1).library()` does not contain it, and `apiAs(1).get(\`/links/${idA}/content\`)` fails.
- **Proof.** Save a `shot` of the auth screen and of each signed-in library with the footer email visible, plus a `note` of the API status codes.

## Gotchas

- Better Auth rate-limits sign-in per IP: more than 5 sign-ins within 60 s return 429 (`worker/auth.ts`'s `/sign-in/email` rule; sign-up and magic-link have their own 60 s/3-attempt rules). Space repeated sign-ins out by more than 60 s, or reuse the sessions `up` already made.
- Mail files carry live tokens. They stay inside the run directory, and `down` deletes them.
- Sessions are bound to the UI origin, `http://127.0.0.1:<ui port>`. Using `localhost` loses the cookie.
- A password reset ends the other sessions of that account. Resetting Demo A invalidates the cookie in `session.json`, so later journeys on the same instance must sign in again, or you must `down` and `up`.
- `bun run demo` offers `Demo A`/`Demo B` quick-fill buttons on the sign-in screen. This harness doesn't set `BUN_PUBLIC_LINKLOG_DEV_FIXTURES`, so the buttons are absent here.
