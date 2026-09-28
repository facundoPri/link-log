import { expect, test } from "bun:test";
import type { Commands } from "@linklog/browser-protocol";
import { claimRounds } from "../src/browser/claimRounds";

type Result = Commands["claim"]["result"];

/** An extension that claims `limit` tabs per round and re-claims forced tabs whenever asked. */
function extension(limit: number) {
  const evaluations: string[] = [];
  const claim = async (ids: string[] | undefined): Promise<Result> => {
    const wanted = ids ?? [];
    const taken = wanted.slice(0, limit);
    evaluations.push(...taken);
    return { requestId: taken.length ? "req" : null, targets: [], skipped: wanted.length - taken.length, attempted: taken };
  };
  return { claim, evaluations };
}

test("Re-evaluate of an explicit set evaluates each tab exactly once, across rounds", async () => {
  const ext = extension(20);
  const ids = Array.from({ length: 45 }, (_, i) => `t${i}`);
  let posts = 0;
  await claimRounds(ext.claim, async () => void posts++, ids);
  expect(ext.evaluations.sort()).toEqual([...ids].sort());
  expect(new Set(ext.evaluations).size).toBe(45);
  expect(posts).toBe(3);
});

test("stops instead of spinning when a round takes nothing", async () => {
  let calls = 0;
  await claimRounds(
    async () => (calls++, { requestId: null, targets: [], skipped: 3, attempted: [] }),
    async () => {},
    ["a", "b", "c"],
  );
  expect(calls).toBe(1);
});
