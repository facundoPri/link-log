// Sends a selection to POST /api/batches in chunks of 100. For auto-tag and lenses, a chunk whose links all lack
// content is refused with the links it skipped; that only leaves those links out and the other chunks still run.
// Any other error stops, as before.
export type BatchReply = { batchId?: string; skipped?: string[] };
export async function submitInChunks<T extends BatchReply>(
  ids: string[],
  send: (chunk: string[]) => Promise<T>,
  onChunk: (reply: T) => void = () => {},
) {
  const batchIds: string[] = [],
    skipped: string[] = [];
  let refused: Error | null = null;
  for (let offset = 0; offset < ids.length; offset += 100) {
    try {
      const reply = await send(ids.slice(offset, offset + 100));
      onChunk(reply);
      if (reply.batchId) batchIds.push(reply.batchId);
      skipped.push(...(reply.skipped ?? []));
    } catch (e) {
      const left = (e as { data?: BatchReply }).data?.skipped;
      if (!left) throw e;
      skipped.push(...left);
      refused = e as Error;
    }
  }
  // Nothing ran at all: the refusal itself is the answer.
  if (!batchIds.length && refused) throw refused;
  return { batchIds, skipped };
}
