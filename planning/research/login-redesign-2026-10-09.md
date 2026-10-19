# Login redesign — 2026-10-09

**Author:** Claude Code, model `claude-opus-5-5` (Opus 5.5). The session environment reports this model; I could not verify it independently.
**Scope:** the auth screens only (sign-in, sign-up, magic link, forgot password, reset password, password updated, invalid reset link).
**Status:** implemented and checked locally. Nothing committed, pushed or deployed.

## Result in one look

Portable captures retained for the PR: [desktop](assets/login-2026-10-09/desktop.png), [mobile](assets/login-2026-10-09/mobile.png).

| Before | After |
| --- | --- |
| `.cache/login-redesign-2026-10-09/screenshots/before/01-sign-in-desktop-light.png` | `.cache/login-redesign-2026-10-09/screenshots/after/01-sign-in-desktop-light.png` |

The new design has:

- the Linklog mark top-left;
- a top-anchored, centered 360 px column;
- a 28 px heading with a one-line subtitle;
- 44 px rounded controls and one dark primary action;
- an "OR" divider leading to the other real method (magic link or password);
- a single switch link at the bottom.

Light and dark follow the system theme. Notices are inline callouts with an icon. The pending state shows a spinner beside a label that does not change.

## Files changed (only these)

| File | Change |
| --- | --- |
| `src/components/AuthScreen.tsx` | Redesign of `AuthScreen` and `ResetPasswordScreen`. Also fixes stale results after a mode switch, plus small a11y and robustness fixes (below). |
| `src/components/auth-screen.css` (new) | Dark-mode token overrides scoped to `.auth-screen` under `prefers-color-scheme: dark`. Nothing outside the auth screens changes. |
| `planning/research/login-redesign-2026-10-09.md` | This report. |

Evidence and scripts are in `.cache/login-redesign-2026-10-09/`, which is gitignored. I did not touch any other file: backend, QA harness, global CSS, UI primitives, `index.html` or dependencies are all unchanged.

## Visual reference (ChatGPT)

I loaded the official public page `https://chatgpt.com/auth/login` in a fresh, profile-less headless Chromium (Playwright). There were no cookies and no account, and nothing was typed or submitted. So this is a real visual reference, not just a conceptual one. `chatgpt.com/` itself returned a Cloudflare challenge (403). `auth.openai.com/log-in` showed a "session ended" page.

- Screenshots: `.cache/login-redesign-2026-10-09/reference/chatgpt-auth-login-{desktop,mobile,desktop-light,desktop-dark}.png`
- Computed metrics (`chatgpt-metrics.ts`):
  - 392 px column;
  - 30/36 px heading at weight 400;
  - 52 px pill controls with a 16 px label;
  - outline border `rgba(0,0,0,.15)`;
  - page background `#fcfcfc` and primary `#0d0d0d`;
  - dark mode uses a black page, `#212121` outline buttons and a white primary.

**What I took from it:** the wordmark top-left, a lot of whitespace, a centered heading, full-width tall controls, one strong primary, the "OR" divider with outline alternatives, and a quiet text switch below.

**What I adapted to Linklog:**
- Inter at weight 600 with tight tracking, matching the app's headings.
- The app's tokens and its green mark.
- A 360 px column, 44 px controls and 12 px radii instead of pills. Linklog is a denser tool, and pills don't sit well with labels above the field.
- Visible labels above each field instead of placeholder-only fields.

**What I deliberately left out:** there are no Google/Apple/phone buttons or any other fake provider. ChatGPT's provider slot is filled by Linklog's real alternative: the magic link, or the password from the magic form. There are also no Terms/Privacy links, because the app has none.

## Contract preserved (checked in code and by the smoke)

- **Auth calls unchanged:**
  - `signIn.email`
  - `signUp.email` (`callbackURL: "/"`, same `name` derivation)
  - `signIn.magicLink` (`callbackURL`, `newUserCallbackURL` and `errorCallbackURL` all `/`)
  - `requestPasswordReset` (`redirectTo: "/reset-password"`)
  - `resetPassword({ newPassword, token })`
  - `history.replaceState` to `/` followed by `onSignedIn()` on success
- **Copy unchanged:**
  - Every anti-enumeration message is word for word, e.g. "If … can sign in, a link is on its way…", "If … has an account, a reset link is on its way…" and "Check … for a confirmation link…".
  - All error mappings are unchanged (`message()`, `linkErrorNotice()`).
  - The magic-link warning about unconfirmed password accounts is unchanged.
- **QA locators unchanged:**
  - Field ids: `#auth-email`, `#auth-password`, `#reset-password`, `#reset-confirm`.
  - Field labels "Email" and "Password", unique on the sign-in screen.
  - Headings: "Sign in", "Create your account", "Choose a new password", "Password updated".
  - Buttons: "Create an account", "Create account", "Sign in" (still unique with exact match), "Sign in with a password", "Email me a sign-in link", "Send link", "Forgot password?", "Send reset link", "Save password", "Go to sign in".
  - Notices still use `role="status"` and `role="alert"`.
- **Password limits unchanged:** `minLength` 10 for sign-up and reset, `maxLength` 128, and the same `autoComplete` values.
- **Dev fixtures:** the guard is unchanged. They render only when `devFixtures()` is non-empty and the form is in sign-in mode. The production bundle contains no demo credentials (checked).

## Intentional behaviour changes

1. **Stale results fixed.** Before, a slow sign-in that failed after the user switched to "Create an account" showed "Wrong email or password." on the sign-up form. The baseline run reproduced this (`before/21-stale-after-switch-desktop-light.png`).
   - Now every submit and every mode switch bumps an attempt counter. A late answer is dropped and doesn't re-enable or disable the new form.
   - A late *successful* sign-in still calls `onSignedIn()`, because the session already exists on the server and the gate should pick it up.
2. **Reset screen with a missing token or `?error=`:** it now shows "Reset link expired" with the same explanation and a "Back to sign in" button. Before, it showed a password form whose submit button could never be enabled. A rejected token after submit still shows the original error callout.
3. **Reset confirm label:** "Repeat it" is now "Confirm new password". I checked every consumer: the only one is `#reset-confirm` in `scripts/qa/auth-video.ts`, which selects by id, and nothing anywhere refers to "Repeat it". The coordinator agreed to keep the clearer label if this check came back clean.
4. **Reset submit:** wrapped in try/catch/finally. A network error used to leave the button disabled forever; now it shows "Something went wrong. Try again."
5. **Live regions:** the `alert` and `status` regions stay mounted (empty when idle), so screen readers announce what lands in them.
6. **Focus on mode switch:** switching modes moves focus to the email field. Before, focus fell back to `<body>` because the clicked button disappeared.
7. **New copy:** subtitles under each heading, a hint under the new password ("At least 10 characters."), and "New to Linklog?" / "Already have an account?" before the switch links. No copy that carries security or QA meaning was changed.
8. **Dark mode on the auth screens only.** The app itself is still light-only.

## Checks run

| Check | Result |
| --- | --- |
| `bun run typecheck` (3 tsc projects) | exit 0 |
| Production build: same `Bun.build` options as `scripts/build.ts`, written to `.cache/…/dist` so the shared `dist/` was not touched | ok; scoped dark CSS present; no `demo-a@linklog.test`, `linklog-demo-a-password` or `testUtils` in the JS |
| Smoke after (`shots.ts after`) | **22/22 ok** (`screenshots/after/results.json`) |
| Same smoke on the old UI (`shots.ts before`) | 13/14. The only failure is the stale-result bug described above. |

The smoke ran on an isolated local stack: `scripts/qa/lib/stack.ts` with a temp D1 and mail adapter, random loopback ports, and `APP_ENV=test`. It used synthetic `@linklog-redesign.test` addresses and random passwords kept only in memory, which are redacted from the results. The stack shut down with no lingering ports and its temp state was removed.

**Real Worker flows checked:**
- sign-up shows the confirmation notice;
- sign-in before verifying shows "Confirm your email first";
- the verification link signs the user in;
- a magic link requested and opened on a mobile viewport signs the user in;
- forgot password → mail → reset → "Password updated" → "Go to sign in" → sign in with the new password works.

**UI checks:**
- no horizontal scroll on desktop or mobile, in light or dark;
- focus starts in the email field;
- tab order is email → password → "Forgot password?" → submit → alternative → switch link;
- a keyboard mode switch moves focus back to the email field;
- the `getByLabel` and exact-name locators the QA harness relies on are unique;
- both live regions are mounted before any notice;
- while pending, submit is disabled with an unchanged label, and pressing Enter does not send a second request;
- submit is enabled again after an error;
- the stale result is dropped after a mode switch;
- with reduced motion, the spinner does not animate. The global reduced-motion rule handles the entrance fades.

## Screenshots (absolute paths)

All screenshots are 2× PNGs in:
- `/Users/facundopri/orca/workspaces/link-log/research-auth-cloudflare/.cache/login-redesign-2026-10-09/screenshots/after/`
- `/Users/facundopri/orca/workspaces/link-log/research-auth-cloudflare/.cache/login-redesign-2026-10-09/screenshots/before/` (same names, old UI)

States `01`–`14` exist for each `desktop|mobile` × `light|dark` combination:

`01-sign-in`, `02-sign-in-error`, `03-sign-in-pending`, `04-sign-up`, `05-sign-up-sent`, `06-magic`, `07-magic-sent`, `08-forgot`, `09-forgot-sent`, `10-link-error`, `11-reset`, `12-reset-mismatch`, `13-reset-done`, `14-reset-invalid`

Plus `20-app-signed-in-desktop-light` (the app is unchanged), `21-stale-after-switch-desktop-light` and `22-focus-ring-password-desktop-light`.

Good ones to start with:
- `…/after/01-sign-in-desktop-light.png`
- `…/after/01-sign-in-mobile-light.png`
- `…/after/01-sign-in-desktop-dark.png`
- `…/after/02-sign-in-error-mobile-light.png`
- `…/after/03-sign-in-pending-desktop-light.png`
- `…/after/05-sign-up-sent-mobile-light.png`
- `…/after/07-magic-sent-desktop-dark.png`
- `…/after/12-reset-mismatch-mobile-dark.png`
- `…/after/13-reset-done-desktop-light.png`
- `…/after/14-reset-invalid-mobile-light.png`

## Limitations / not verified

- **Visual-state screenshots used fulfilled responses.** The error, notice, pending and reset-done shots in the 4-way matrix were rendered by answering the auth request inside the page with Better Auth's response shapes. This kept them deterministic and clear of the 3–5/min rate limits. The real Worker was exercised only by the smoke flows listed above, on desktop light plus the magic link on mobile.
- **Fixtures panel not rendered.** The QA stack strips `BUN_PUBLIC_LINKLOG_DEV_FIXTURES`, so the restyled demo-accounts panel was checked by reading the code, not visually. Its guard and behaviour are unchanged.
- **Browsers and a11y tooling:** tested in Chromium only, not Safari or Firefox. I did not run a real screen reader or axe; the a11y checks above are DOM- and Playwright-level only.
- **Dark mode stops at the auth screens.** Signing in lands on the light-only app. The page `<body>` and `theme-color` meta stay global, so iOS overscroll and the browser chrome may still show the light colours.
- **No show-password toggle.** Any `aria-label` containing "password" would make the existing `getByLabel("Password")` locator ambiguous.
- **Not run:** the full QA video run (waived by the user), `scripts/build.ts` itself (it deletes and recreates the shared `dist/`), and the `bun test` suite (no UI tests; the backend is owned by another worker).
- **Reference is a snapshot.** The ChatGPT reference is how the page looked on 2026-10-09.

## Reproduce

```sh
bun .cache/login-redesign-2026-10-09/shots.ts after    # or: before (on the old AuthScreen)
bun .cache/login-redesign-2026-10-09/build.ts          # isolated production build
bun .cache/login-redesign-2026-10-09/chatgpt-ref.ts    # public reference screenshots (no account)
```
