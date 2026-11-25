// Shared by the tests that drive quotas through HTTP: seed a quota window (setup only), check the
// 429 a client sees, and keep a test clear of a fixed-window boundary so it cannot straddle a reset.
import { beforeEach, expect } from "bun:test";
import type { TestD1 } from "./d1";

/** Puts a counter into the current fixed window with `count` already taken. */
export const setUsed = (db: TestD1, key: string, count: number, window: number) =>
  db.sqlite.query("INSERT OR REPLACE INTO app_rate_limits(key,window_start,count) VALUES(?,?,?)").run(key, Math.floor(Date.now() / 1000 / window) * window, count);

/** Seconds to the next fixed window boundary, as seen at `ms`. */
export const untilReset = (window: number, ms: number) => Math.ceil((Math.floor(ms / 1000 / window) + 1) * window - ms / 1000);

/** Sends the request and checks the 429 body and that Retry-After matches the window reset. */
export async function expect429(request: () => Promise<Response>, code: string, window: number) {
  const before = Date.now();
  const res = await request();
  const after = Date.now();
  expect(res.status).toBe(429);
  expect(((await res.json()) as { code?: string }).code).toBe(code);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThanOrEqual(untilReset(window, after));
  expect(retryAfter).toBeLessThanOrEqual(untilReset(window, before));
}

const MARGIN = 5000;

/**
 * Waits out the end of the current boundary (a fixed window of `window` seconds, or the UTC month)
 * when less than MARGIN ms remain, so the test body runs well inside one window. Costs nothing
 * unless the test starts right before a reset.
 */
async function stayInsideWindow(window: number | "month") {
  const now = Date.now(), d = new Date(now);
  const end = window === "month" ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : (Math.floor(now / 1000 / window) + 1) * window * 1000;
  if (end - now < MARGIN) await new Promise((resolve) => setTimeout(resolve, end - now + 50));
}

/**
 * Registers a beforeEach that keeps every test of the file (or describe) inside the given windows. The wait can
 * take up to MARGIN per window, as long as bun's default 5 s hook timeout, so the hook gets its own budget:
 * waiting inside a hook that also does setup timed out whenever a test started in a window's last seconds
 * (FAC-265). Hooks run in registration order: register it before any setup that writes into a window.
 */
export function stayInsideWindows(...windows: (number | "month")[]) {
  beforeEach(async () => {
    for (const window of windows) await stayInsideWindow(window);
  }, windows.length * (MARGIN + 100) + 5000);
}
