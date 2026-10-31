// Fixed-window counters in D1. One UPSERT decides and increments atomically, so concurrent
// requests in different isolates cannot all pass a stale read.
export type Limit = { window: number; max: number };

/** Which quota ran out; clients back off per quota. */
export type QuotaCode = "links" | "jobs" | "writes";

/** Seconds until the fixed window containing `now` resets (at least 1, for a Retry-After header). */
export const retryAfter = (limit: Limit, now = Date.now()) =>
  Math.max(1, Math.ceil((Math.floor(now / 1000 / limit.window) + 1) * limit.window - now / 1000));

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

/** Quota taken up front for an operation; `release` gives back what it did not use. */
export type Charge = {
  /** Gives back `cost` from every quota, or per key with a map (default: everything taken). */
  release(cost?: number | Record<string, number>): Promise<void>;
};

/**
 * Takes every quota or none (earlier ones are given back if a later one is exhausted). The
 * refund targets the same fixed window, so a rollover never inflates the next window.
 */
export async function tryCharge(db: D1Database, items: { key: string; limit: Limit; cost: number; code?: QuotaCode }[], now = Date.now()): Promise<{ charge: Charge } | { exhausted: { code?: QuotaCode; retryAfter: number } }> {
  const taken: typeof items = [];
  const release = async (cost?: number | Record<string, number>) => {
    for (const item of taken) {
      const wanted = cost === undefined ? item.cost : typeof cost === "number" ? cost : (cost[item.key] ?? 0);
      const amount = Math.min(wanted, item.cost);
      if (amount <= 0) continue;
      const windowStart = Math.floor(now / 1000 / item.limit.window) * item.limit.window;
      await db
        .prepare("UPDATE app_rate_limits SET count=max(count-?,0) WHERE key=? AND window_start=?")
        .bind(amount, item.key, windowStart)
        .run();
    }
  };
  for (const item of items) {
    if (item.cost <= 0) continue;
    if (!(await consume(db, item.key, item.limit, item.cost, now))) {
      await release();
      return { exhausted: { code: item.code, retryAfter: retryAfter(item.limit, now) } };
    }
    taken.push(item);
  }
  return { charge: { release } };
}

/** Like `tryCharge`, for callers that only need to know whether the quotas were taken. */
export async function charge(db: D1Database, items: { key: string; limit: Limit; cost: number }[], now = Date.now()) {
  const result = await tryCharge(db, items, now);
  return "charge" in result ? result.charge : null;
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A quota refused the request: answers 429 with the quota's `code` and a `Retry-After` header. */
export class LimitError extends Error {
  constructor(
    message = "Too many requests. Try again later.",
    readonly code?: QuotaCode,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** The 429 for a refused `tryCharge`. */
export const limitError = (exhausted: { code?: QuotaCode; retryAfter: number }, message?: string) =>
  new LimitError(message, exhausted.code, exhausted.retryAfter);
