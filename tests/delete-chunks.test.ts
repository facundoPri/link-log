// FAC-46: the client sends a selection to POST /api/links/delete 100 ids at a time and reports what happened to
// every id: deleted, skipped because a job is running, or left untouched because a request failed.
import { expect, test } from "bun:test";
import { deleteInChunks, type DeleteReply } from "../src/batches";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);

test("sends 100 ids per request and sums the replies", async () => {
  const sent: string[][] = [];
  const replies: DeleteReply[] = [];
  const out = await deleteInChunks(
    ids(250),
    async (chunk) => {
      sent.push(chunk);
      return { deleted: chunk.filter((id) => id !== "l7"), running: chunk.filter((id) => id === "l7") };
    },
    (r) => replies.push(r),
  );
  expect(sent.map((c) => c.length)).toEqual([100, 100, 50]);
  expect(replies.length).toBe(3);
  expect(out.deleted.length).toBe(249);
  expect(out.running).toEqual(["l7"]);
  expect(out.untouched).toEqual([]);
  expect(out.error).toBeNull();
});

test("a failed request stops; its ids and the ones after it are untouched", async () => {
  let calls = 0;
  const out = await deleteInChunks(ids(250), async (chunk) => {
    if (++calls === 2) throw new Error("Network down");
    return { deleted: chunk, running: [] };
  });
  expect(calls).toBe(2);
  expect(out.deleted).toEqual(ids(100));
  expect(out.untouched).toEqual(ids(250).slice(100));
  expect(out.error?.message).toBe("Network down");
});
