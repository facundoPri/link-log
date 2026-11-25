// FAC-46: the client sends a selection to POST /api/links/delete 100 ids at a time and reports what happened to
// every id: deleted, or left untouched because a request failed, with the jobs cancelled on the deleted ones.
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
      return { deleted: chunk, cancelled: chunk.includes("l7") ? 2 : 0 };
    },
    (r) => replies.push(r),
  );
  expect(sent.map((c) => c.length)).toEqual([100, 100, 50]);
  expect(replies.length).toBe(3);
  expect(out.deleted.length).toBe(250);
  expect(out.cancelled).toBe(2);
  expect(out.untouched).toEqual([]);
  expect(out.error).toBeNull();
});

test("a failed request stops; its ids and the ones after it are untouched", async () => {
  let calls = 0;
  const out = await deleteInChunks(ids(250), async (chunk) => {
    if (++calls === 2) throw new Error("Network down");
    return { deleted: chunk, cancelled: 0 };
  });
  expect(calls).toBe(2);
  expect(out.deleted).toEqual(ids(100));
  expect(out.untouched).toEqual(ids(250).slice(100));
  expect(out.error?.message).toBe("Network down");
});

test("a request whose answer was lost is checked against the library before it is reported", async () => {
  let calls = 0;
  const out = await deleteInChunks(
    ids(250),
    async (chunk) => {
      if (++calls === 2) throw new Error("Network down");
      return { deleted: chunk, cancelled: 0 };
    },
    () => {},
    // The server committed the second chunk except for l150, then the response was lost.
    async () => new Set(["l150", ...ids(250).slice(200)]),
  );
  expect(out.deleted.length).toBe(199);
  expect(out.untouched).toEqual(["l150", ...ids(250).slice(200)]);
  expect(out.error?.message).toBe("Network down");
});

test("when the check fails too, the failed chunk stays unconfirmed", async () => {
  const out = await deleteInChunks(
    ids(10),
    async () => {
      throw new Error("Network down");
    },
    () => {},
    async () => {
      throw new Error("Still down");
    },
  );
  expect(out.deleted).toEqual([]);
  expect(out.untouched).toEqual(ids(10));
});
