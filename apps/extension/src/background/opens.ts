import { Mutex, type KV } from "./kv";

/** Long enough for the page's own retry of an unconfirmed request, short enough not to pile up. */
const TTL_MS = 10 * 60_000;

type Entry = { at: number; opened: Record<string, number> };

export type OpenRecord = {
  has(url: string): boolean;
  record(url: string, tabId: number): Promise<void>;
};

/**
 * What an Open operation already created, by URL. A retry with the same operationId (the first
 * answer was lost) replays these instead of opening them again, even if the tabs have since
 * navigated or closed. Its own mutex: opening 50 tabs must not hold up lens claims.
 */
export class OpenLedger {
  private mutex = new Mutex();
  constructor(
    private kv: KV,
    private now: () => number = Date.now,
  ) {}

  /** Runs `work` alone per ledger, so two calls with one operationId never both create a tab. */
  run<T>(scope: string, operationId: string, work: (ledger: OpenRecord) => Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const now = this.now();
      await this.prune(now);
      const key = `open:${scope}:${operationId}`;
      const entry = (await this.kv.get<Entry>(key)) ?? { at: now, opened: {} };
      return work({
        has: (url) => Object.hasOwn(entry.opened, url),
        record: async (url, tabId) => {
          entry.opened[url] = tabId;
          // The tab exists either way; a full cache must not turn it into a failure.
          await this.kv.set({ [key]: entry }).catch(() => {});
        },
      });
    });
  }

  private async prune(now: number) {
    const keys = await this.kv.keys("open:");
    const entries = await this.kv.getMany(keys);
    await this.kv.remove(keys.filter((k) => ((entries[k] as Entry | undefined)?.at ?? 0) < now - TTL_MS));
  }
}
