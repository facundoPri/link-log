---
status: accepted
---

# The extension reads no tab before the user accepts, and packaged builds bridge only to configured https origins

The Linklog extension reads no tab, URL, title or tab group until the user clicks **Accept and connect** on its Connect page. That click stores `consent: true` in `chrome.storage.local`. Until then the background runs nothing that touches tabs. The bridge answers every Linklog request with `CONSENT_REQUIRED`, except `openPermissions`, which opens the Connect page. Linklog's Browser view shows a `consent` connection state. The Chrome Web Store requires a prominent disclosure in the product UI and a specific agreeing action "before collecting or handling user data", including data stored only locally (User Data FAQ). The worker used to store every tab URL from install onward, before any UI. Decided in the FAC-305 arena and accepted by the owner (2026-11-26).

Packaged builds (`--package`, the same ZIP for the store and GitHub) bridge only to `LINKLOG_ORIGINS`, which must be non-empty and https. Only dev builds keep the localhost bridge. This removes a warning line and an http origin from what reviewers and users see. It also removes the localhost bridge without pairing, an accepted risk, from every shipped build (FAC-306).

## Considered Options

- **The Connect page as implied consent (option 2).** The read starts at install, before any action, and opening Browser view happens in the web app, not in the extension.
- **`hello` succeeds with `tabAccess: false`.** This needs `init()` before consent, and it spreads consent over three modules.
- **A consent timestamp or version.** No current need. Asking again when the disclosure changes is future work.
- **Keeping localhost in the GitHub ZIP.** Its users are production users, and keeping it would mean two artifacts.

## Consequences

- Users who update from 0.2.x go idle until they accept. Connect does not open on update, so they find out from Browser view or the popup. Their old `storage.local` data stays untouched and unread.
- Any new feature that reads tabs must run after the consent gate. If it reads something new, the disclosure and the store's Privacy tab must change with it.
- `test:browser` seeds the flag, except for one check that proves the gate.
- `bun run extension:package` fails without an https `EXTENSION_ORIGINS`.
