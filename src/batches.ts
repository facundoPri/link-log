import type { Batch } from "./types";

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

/**
 * How the UI words a run of each batch kind: the sidebar reads "Auto-tagging 3/7", the toast "Auto-tagging 3 links…"
 * and then "Auto-tagged 3 links".
 */
export const BATCH_WORDS: Record<Batch["kind"], { running: string; verb: string; done: string; noun: "link" | "tab" }> = {
  extract: { running: "Extracting", verb: "Extracting context for", done: "Extracted", noun: "link" },
  preview: { running: "Fetching preview", verb: "Fetching previews for", done: "Fetched previews for", noun: "link" },
  autotag: { running: "Auto-tagging", verb: "Auto-tagging", done: "Auto-tagged", noun: "link" },
  lens: { running: "Applying lens", verb: "Applying lens to", done: "Lens applied to", noun: "link" },
  query: { running: "Applying lens", verb: "Applying lens to", done: "Lens applied to", noun: "link" },
  "browser-lens": { running: "Applying lens", verb: "Applying lens to", done: "Lens applied to", noun: "tab" },
  "browser-autogroup": { running: "Autogrouping", verb: "Autogrouping", done: "Suggested groups for", noun: "tab" },
};
