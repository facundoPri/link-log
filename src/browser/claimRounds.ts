import type { Commands } from "@linklog/browser-protocol";

type ClaimResult = Commands["claim"]["result"];

/**
 * Claims and submits in rounds (per-request target limit and byte budget). With an
 * explicit set of tabs, each is claimed at most once per call: every round asks only
 * for the tabs no earlier round attempted, so a tab that already finished (and was
 * paid for) is never re-claimed by a later round of the same click.
 */
export async function claimRounds(
  claim: (tabInstanceIds: string[] | undefined) => Promise<ClaimResult>,
  submit: (claim: ClaimResult) => Promise<void>,
  tabInstanceIds?: string[],
  maxRounds = 50,
) {
  let remaining = tabInstanceIds;
  for (let round = 0; round < maxRounds; round++) {
    if (remaining && !remaining.length) return;
    const result = await claim(remaining);
    if (result.requestId) await submit(result);
    if (!result.skipped) return;
    if (remaining) {
      const attempted = new Set(result.attempted);
      const next = remaining.filter((id) => !attempted.has(id));
      // Nothing was taken this round: stop instead of spinning.
      if (next.length === remaining.length) return;
      remaining = next;
    } else if (!result.attempted.length) return;
  }
}
