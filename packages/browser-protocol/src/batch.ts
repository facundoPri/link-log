// Transport batching: every POST from the page stays under the Worker's body cap,
// measured in real UTF-8 bytes of the JSON that is sent (not JS string length).

const encoder = new TextEncoder();

/** UTF-8 size of `value` serialized as JSON. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * Splits items into consecutive chunks of at most `maxItems` items whose JSON array
 * (plus `overhead` bytes for the rest of the body) stays within `maxBytes`. An item
 * that alone exceeds the budget still gets its own chunk: the server reports it.
 */
export function chunkByBytes<T>(
  items: readonly T[],
  { maxItems, maxBytes, overhead = 0 }: { maxItems: number; maxBytes: number; overhead?: number },
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  // "[" + "]" around the items; each item after the first adds a comma.
  let bytes = overhead + 2;
  for (const item of items) {
    const size = jsonBytes(item);
    if (current.length && (current.length >= maxItems || bytes + 1 + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = overhead + 2;
    }
    bytes += (current.length ? 1 : 0) + size;
    current.push(item);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Consecutive slices of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
