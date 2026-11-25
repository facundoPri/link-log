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

export type DeleteReply = { deleted: string[]; running: string[] };
/**
 * Sends a selection to POST /api/links/delete in chunks of 100 (FAC-46). The first failed request stops the run.
 * Its answer may only have been lost after the server committed, so `present` reads which of its links still exist
 * before they are reported; when that read fails too, they count as not deleted. Links not deleted are `untouched`.
 */
export async function deleteInChunks<T extends DeleteReply>(
  ids: string[],
  send: (chunk: string[]) => Promise<T>,
  onChunk: (reply: T) => void = () => {},
  present: (chunk: string[]) => Promise<Set<string>> = async (chunk) => new Set(chunk),
) {
  const deleted: string[] = [],
    running: string[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100);
    try {
      const reply = await send(chunk);
      onChunk(reply);
      deleted.push(...reply.deleted);
      running.push(...reply.running);
    } catch (e) {
      const still = await present(chunk).catch(() => new Set(chunk));
      deleted.push(...chunk.filter((id) => !still.has(id)));
      return { deleted, running, untouched: [...chunk.filter((id) => still.has(id)), ...ids.slice(offset + 100)], error: e as Error };
    }
  }
  return { deleted, running, untouched: [] as string[], error: null };
}
