# FAC-305, FAC-306, FAC-310: arena process log

One arena for the three tickets, run on 2026-11-26, because FAC-310's texts depend on the decisions in FAC-305 and FAC-306. [FAC-306-process.md](FAC-306-process.md) and [FAC-310-process.md](FAC-310-process.md) point here.

- Moderator: Opus.
- Debaters: A (`model: opus`) and B (`model: sonnet`), each in its own git worktree.
- Round 3: a fresh Sonnet debater.
- Fable was not called. The condition was not met: the design converged without awkward special cases, and nobody was stuck.

"Running the CLI" in this repo meant:

- building and packaging the extension, then unzipping it and reading the manifest;
- loading it in Chrome for Testing 153 through Playwright;
- measuring the install warnings with `chrome.management.getPermissionWarningsByManifest`;
- reading `chrome.storage` from the worker;
- the unit tests and typechecks;
- `bun run test:browser`.

The probes are in [FAC-305-306-tools/](FAC-305-306-tools/).

## Ground truth (moderator, before round 1)

1. The 0.2.1 ZIP rebuilt locally is byte-identical to the GitHub release (manifest and JS). `EXTENSION_ORIGINS=https://linklog.facundopri.com`.
2. Install warnings: three lines today. The bridge's localhost matches add "127.0.0.1, … localhost" to the host line. The "Allow page content" dialog says "all your data on all websites".
3. A fresh profile that never opens Linklog: `storage.session.instances` holds every tab URL, query included, from install onward. Zero network requests from the extension.
4. Data leaves the browser only from the Linklog page (lens evaluation, Save). The catalog GET carries no tab data.
5. The 128 icon is full bleed.

These facts went into the brief as findings. The moderator's own claims (C1–C7) went in as statements the debaters were asked to refute. The ticket's recommendations went in marked "suggested".

## Round 1 (in parallel)

Both debaters prototyped option 1 and the packaging change, packaged with the production origin, and ran the warnings and startup probes on their build.

| Claim | A | B |
| --- | --- | --- |
| C1 the startup read is "handling"; option 2 is weaker | holds, stronger: option 2 cannot meet "before collecting" without a gate | holds |
| C2 one flag, no new web concept | **refuted**: the "Allow access" banner needs a snapshot, and a bare error shows "install the extension" | **refuted**, same finding; also found `openPermissions` rejected before consent, by running it |
| C3 listing + in-product accept | holds | holds; the "prior to installation" gap stays open |
| C4 one ZIP without localhost | holds | holds; added the https guard |
| C5 keep all sites | holds | holds, with a stronger reason: per-site needs the same manifest patterns, so the review surface is identical |
| C6 margin only on 128 | holds | holds |
| C7 no ADR | **refuted** (`docs/agents/domain.md`) | **refuted** |

The two designs differed on the bridge signal:

- A: `hello` fails with `CONSENT_REQUIRED`, and nothing runs before consent.
- B: `hello` succeeds with `tabAccess: false`, and `init()` is split.

`test:browser`: the two runs overlapped, with load average ~700 and ~550 Chrome processes from other sessions.

- A: 66 ✓, 0 ✗, then killed by its own time limit in the last lane.
- B: 60 of 69. One failure came from its own new check (fixed). Eight were timeouts.

## Round 2 (cross-critique, fixed self-critique slot)

- **B changed its mind on the gate.** Its slot: "A's strongest argument … never starts `init()` before consent." B's split still stored ids and `linklogOrigins`, and its own test failed on that. B adopted A's gate.
- **A changed its mind on the disclosure.** Its slot: B's strongest argument was that A's text left out tab groups, the `storage.local` group look that survives a restart, and remote extraction. A also adopted B's https guard and B's short description.
- **A found new evidence by running it:** a second-window probe shows the extension reads every window, not only Linklog's. That refuted B's wording "the window where Linklog is open".
- **Swaps** (both sides moved to the other's position):
  - Flag shape: A moved to `consent: true`, B moved to `consentAt`.
  - Certifications: A moved to "conditional on FAC-175/307", B moved to "tick all three".

  The moderator decided both with the owner's criteria:
  - the boolean (simplest model; a re-consent version is future scope);
  - tick all three, as an owner-confirmed pre-submit checklist item rather than a code blocker. The truth of it is the owner's (question 6).

## Round 3 (attack on the moderator)

It ran on the adopted prototype and on the **real released 0.2.1 ZIP**, updated in place to 0.3.0.

- **Upgrade path.** Session empty; old `installationId` and group hints kept unread; Connect does not open; the popup says "Not connected"; after Accept the group binds again. M9 holds, with a qualifier: users find the change only through Browser view or the popup. So the release notes need a line → added to FAC-305's acceptance criteria.
- **M10 refuted.** The moderator's "about +100 lines" is +135/−44 in the extension (16 files, +161/−45 in total), not counting the ADR, docs and workflow edits. The docs state the measured numbers.
- **M8 partly refuted.** The web deploy and the extension release are separate workflows on the same push, with no ordering. "Together" means minutes apart, and the effect is cosmetic. The stale comment in `extension-release.yml` goes into FAC-306's criteria.
- **M3 partly refuted.** The `__LINKLOG_LOCAL_BRIDGE__` define existed only for one Connect status string. Reading the manifest drops it → FAC-306 criterion.
- **Gap.** No automated check covers the gate (the suite seeds the flag) → FAC-305 criterion: one unseeded `test:browser` check.
- **M7 partly.** The certifications rest on a fact only the owner can confirm → owner question 6.

## test:browser

<!-- filled below by the moderator's clean run -->

## Owner questions (product, UX, legal-business)

Listed in the PR body and in the report to the owner. The technical choices were decided in the arena:

- all sites vs per site: no UX difference for the user, because per-site would only add prompts;
- the bridge signal;
- the flag;
- origins;
- the icon.

## Cost and value per step

| Step | Cost (approx.) | Value |
| --- | --- | --- |
| Moderator ground truth | ~20 min | Highest. The startup-read and warnings probes turned C1 and C4 into facts before anyone argued, and both debaters reused the probes. |
| Round 1, A (Opus) | ~190k tokens, 36 min | A working gate with nothing stored before consent; refuted C2 and C7. |
| Round 1, B (Sonnet) | ~270k tokens, 35 min | The https guard, the stronger C5 reason, the `openPermissions` bug, and a real-web-UI run before and after consent. |
| Round 2 | ~50k + ~35k tokens, ~5 min | Convergence on one gate; the disclosure fixed (groups, every window, extraction). |
| Round 3 (Sonnet) | ~120k tokens, 7 min | The upgrade path on the real artifact, plus four corrections to moderator promises. |

## What to change next time

- Two debaters plus the moderator ran `test:browser` at overlapping times on a machine other sessions were also loading. The timeouts then said nothing about the code. Next time give round 1 "no test:browser", and let the moderator run one clean run after round 2. Before trusting a run, check the load average and the Chrome process count.
- For an extension, the "real workspace written by the current CLI" is the released ZIP updated in place. Put the upgrade probe in round 1, not round 3.
- `chrome.management.getPermissionWarningsByManifest`, through a small probe extension, measures install warnings for any manifest variant in seconds. Keep it in the repo; it is in `FAC-305-306-tools/`.
