// Fixed-window counters in D1. One UPSERT decides and increments atomically, so concurrent
// requests in different isolates cannot all pass a stale read.
export type Limit = { window: number; max: number };

export const LIMITS = {
  /** Auth emails per recipient address (hashed key). */
  emailPerRecipient: { window: 3600, max: 5 },
  /** Links a user may create (single add + import) per hour. */
  linksPerUser: { window: 3600, max: 500 },
  /** Links a user may queue for paid/expensive processing per hour. */
  jobsPerUser: { window: 3600, max: 300 },
  /** Writes per user per minute across the private API. */
  writesPerUser: { window: 60, max: 120 },
} satisfies Record<string, Limit>;

export async function consume(db: D1Database, key: string, limit: Limit, cost = 1, now = Date.now()) {
  if (cost > limit.max) return false;
  const windowStart = Math.floor(now / 1000 / limit.window) * limit.window;
  const row = await db
    .prepare(
      `INSERT INTO app_rate_limits(key,window_start,count) VALUES(?,?,?)
       ON CONFLICT(key) DO UPDATE SET
         count=CASE WHEN app_rate_limits.window_start=excluded.window_start THEN app_rate_limits.count+excluded.count ELSE excluded.count END,
         window_start=excluded.window_start
       WHERE app_rate_limits.window_start<>excluded.window_start OR app_rate_limits.count+excluded.count<=?
       RETURNING count`,
    )
    .bind(key, windowStart, cost, limit.max)
    .first<{ count: number }>();
  return row !== null;
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class LimitError extends Error {
  constructor(message = "Too many requests. Try again later.") {
    super(message);
  }
}
