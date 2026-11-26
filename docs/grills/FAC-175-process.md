# FAC-175 and FAC-307 arena: process log

A grilling arena ran on 2026-11-26 for FAC-175 (scoped to the Unlisted submission and a small beta) and FAC-307 (the privacy policy), together, following Orky's `grilling-arena` skill. Here, "run the CLI" meant checking each claim by running it:

- building and packaging the extension, then inspecting the manifest and the ZIP;
- `bun run build` plus `wrangler dev` with the real `assets` block, then curl;
- a local D1 database migrated with the repo's migrations;
- logged-out curl against production;
- reading primary legal and policy sources, with the access date.

`verify-linklog` and `test:browser` were not needed. No UI changed, and the only behavior claims were about static serving and data, which curl and D1 cover.

- **Moderator:** Opus.
- **Debaters:** an Opus subagent and a Sonnet subagent, each in its own scratchpad worktree.
- **Fable:** not called. Its condition was not met: the design never felt awkward, and the arena never got stuck. Every disagreement came down to one fact or one value.

## Ground truth before round 1

Before writing the brief, the moderator mapped the data flows from the code and packaged the extension:

- **ZIP:** 0.2.1, 13 files, with 0 `fetch(` calls in the extension.
- **Providers in production:** Cloudflare and TypeSafe.
- **Account deletion:** disabled in the app.
- **Tab data:** tab URLs and titles stay in `browser_targets` after the lens finishes.
- **Landing:** on `workers.dev` only.

The brief had 11 refutable claims (C1 to C11) and 4 suggested answers from the tickets (S1 to S4).

## Round 1 (in parallel, each ran their checks)

| Claim | Result | Who and how |
| --- | --- | --- |
| C10 "Disp. 10/2008 requires a notice text" | **REFUTED by both.** Res. AAIP 14/2018 art. 1 repealed it, and its art. 3 now holds the text. The moderator re-read it on argentina.gob.ar. | both |
| C5 a user delete fails on a foreign key | **CONFIRMED by running** on local D1 (`SQLITE_CONSTRAINT_FOREIGNKEY`). Opus found a second key that does not cascade, `browser_requests.batch_id`. | both |
| C3 tab data retention | **PARTIAL.** A confirmed answer is cleared from `browser_targets.answer`, but it survives in `jobs.result`. url, title and `capture_meta` (up to 2,000 characters of description) survive 3 `cleanupBrowser` runs. | Opus probe test, Sonnet reading |
| C2 and C7 recipients | **PARTIAL.** Missing from the claims: GitHub `api.github.com`, YouTube (`i.ytimg.com`, `youtube-nocookie`), the sites' own images, the D1 Time Travel backups (7 or 30 days), and TypeSafe also receiving url, title and site. | both |
| C1 the extension makes no network calls | **CONFIRMED.** Sonnet also found that the extension reloads sleeping tabs (`loader.ts:342`), which contradicts Connect. | Sonnet |
| C11 store rules | **PARTIAL.** The claims missed the prominent in-UI disclosure (Q10) and the Limited Use rule that no human reads the data. | Opus |
| C8 location of the policy | **CONFIRMED by curl.** On the app host, `/privacy` returns 200 with the SPA today, through the fallback. | both |
| S4 full matrix (Terms, cookies, billing) | **REJECTED** for this phase by both, on criterion 3 | both |
| S1 and S2 | Confirmed. S1 means the app host. | both |

Opus also found a defect the moderator had missed: Connect says page text "goes only to your own Linklog library", but it also goes to TypeSafe.

## Round 2 (cross-critique, with a fixed slot for criticising your own proposal)

**Who changed their mind, and why:**

- **Opus changed three positions.**
  - Privacy-tab boxes: it went from 2 boxes to 5. Sonnet showed the form certifies that the answers "reflect … your privacy policy", and Opus's own policy lists email, password and IP.
  - It adopted Sonnet's "reloads sleeping tabs" finding.
  - It added the backup window to retention.
- **Opus changed its GDPR approach.** It dropped invite-only, which needs sign-up code, for the Distribution-tab exclusion.
- **Sonnet changed three positions.**
  - It adopted the TypeSafe copy defect as a blocker.
  - It switched to the copy-step build. Both built the two variants: the second entrypoint adds an empty chunk and a `<script>`, while the copy step leaves the app's files byte-identical.
  - It replaced its Limited Use sentence with the four exceptions (consent, security, law, aggregated data).
- **Sonnet narrowed D4.** It found that Disp. 60/2016 treats a foreign service provider as an international transfer, which weakened its own "lawyer item" hedge. It then agreed that the sign-up consent line is needed for the beta.

**Where they swapped positions:**

1. **Privacy-tab boxes.** Opus went from 2 to 5 boxes and Sonnet from 5 to 3, dropping Authentication and Location.
2. **EU exclusion.** Opus made it a blocker, and Sonnet made it a free follow-up.

The skill says a swap means the question is about values, so the moderator decided both with the owner's words and without round 3:

- **Boxes:** the owner asked for "consistencia con las respuestas de data-use del dashboard". The boxes therefore follow what the policy says Linklog collects, which gives 5 boxes. Under-ticking contradicts the certification; ticking more has no stated penalty.
- **EU exclusion:** this is a business choice about who the beta is for. It went to the owner as Q3, with the exclusion recommended, because it costs a checkbox and can be undone. Making it a blocker would add nothing to "primer envío Unlisted cuanto antes".

**Both agreed without a swap on:**

- FAC-305 option 1 is required by policy text (Q10 "before collecting or handling"), not an owner choice;
- an operator deletion script blocks the beta;
- Terms come later;
- the policy URL;
- naming every recipient.

## Round 3 (one debater attacks the moderator)

Sonnet attacked the moderator's departures and checked every factual sentence against the real setup:

- the packaged ZIP;
- `bun run build` plus `wrangler dev`;
- a state written by the repo's own `scripts/e2e-auth.ts` flow (102 links, 101 Browser targets, 2 sessions, and a second user);
- the real cron;
- logged-out curl against production.

**Departures:**
- **M1, five Privacy-tab boxes: broken by its own rule.** The dashboard's example for Personal communications names "social media posts", which Linklog extracts. The moderator now ticks it, so there are six boxes.
- **M5, minimum age 18: removed.** No source read requires an age, so it was an unenforced promise and an extra owner question.
- **M6, consent line on "sign-up": broken.** The `magic` mode also creates accounts. The line now shows in both modes, and recording consent became a lawyer item.
- **M2, M3 and M4 hold.** These are the EU question, retention stated as it is, and the Gmail contact.

**Promises (10 broken, all fixed in the text):**
- Sessions are rolling (7 days without use).
- Abuse counters are kept up to 24 hours or 2 days, and an email-hash counter exists.
- TypeSafe also receives the names of auto-group groups.
- Tab receipts also keep the site name and page facts.
- The extension sends up to 160,000 characters, and Linklog passes about 24,000 of them on.
- A deleted link's title lasts until the next 5-minute cleanup.
- The 9-character API key prefix is stored in clear.
- "The extension will ask again" had no mechanism, so it now reads "we will tell you".
- "Only to the Linklog page" is false while the ZIP still bridges to localhost. FAC-306 must ship with FAC-305.

**Deletion order:**
- It ran on the real state with no foreign-key error, and 0 rows were left for the user.
- The `browser_requests` step turned out to be unnecessary, and the script must also delete `app_rate_limits` `writes:<id>` and `links:<id>`. The acceptance criterion was rewritten.
- The R2 prefix delete was not executed (Miniflare options); all 86 keys were under `users/<id>/`.

**Held:**
- Pinned groups send only their name, description and color.
- The extension does not scroll and does not read cookies, form fields or history.
- Usage keeps rows without the link after it is deleted.
- Saving a tab sends only its URL.
- Sign-in sets only `linklog.session_token`.

The moderator accepted every finding; none was rejected. Round 3 was the most valuable step per token in this arena.

## Cost and value

| Step | Cost (subagent tokens, approx.) | Value |
| --- | --- | --- |
| Ground truth (moderator) | in-context | It set up the two most valuable claims (C3 and C5), so both debaters started from facts. |
| Round 1 Opus | ~190k, 103 tool uses | The TypeSafe copy defect, the second FK, the probe test on retention |
| Round 1 Sonnet | ~250k, 98 tool uses | The reload defect, D1 backups, TypeSafe's own policy, the box wording |
| Round 2 (both) | ~60k | 7 changes of mind, 2 swaps resolved, one build variant chosen with measurements |
| Round 3 Sonnet | ~100k | 3 departures broken, 10 promises corrected, the deletion order proven on a real state |

## Questions the moderator decided that the owner can change

- That the policy lives on the app host rather than the landing.
- That the policy is in English, with a Spanish version as a lawyer item.
- That every provider is named.
- That the Privacy tab gets 6 boxes.
- That the consent line goes in FAC-307's PR.
- That FAC-305 option 1 is required.

## What to change next time

- **Legal arenas need their own ground truth for each source.** Give the debaters the primary URLs up front, and have the moderator re-read the one quote each decision rests on. Here both debaters spent most of round 1 fetching the same pages.
- **Recheck any repeal on the official gazette.** C10 was written from memory, and both debaters refuted it in round 1.
- **Round 3 should count the moderator's promises in the drafted text, not only its choices.** In a policy every sentence is a promise; 10 of them were wrong after two rounds.
- **For copy that is already shipped, compare it with the code in round 1.** The two Connect defects came from comparing the in-product text with the code. Make "find every user-facing sentence that the code contradicts" a standing round-1 item for disclosure tickets.
