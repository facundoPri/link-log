import { Mutex, type KV } from "./kv";

const REPLAY_WINDOW_MS = 10 * 60_000;

const keepOpenedTab = () => {};

type Entry = { at: number; opened: Record<string, number> };

export type OpenRecord = {
  has(url: string): boolean;
  record(url: string, tabId: number): Promise<void>;
};

export class OpenLedger {
  private opensOnly = new Mutex();
  constructor(
    private kv: KV,
    private now: () => number = Date.now,
  ) {}

  run<T>(scope: string, operationId: string, work: (ledger: OpenRecord) => Promise<T>): Promise<T> {
    return this.opensOnly.run(async () => {
      const now = this.now();
      await this.prune(now);
      const key = `open:${scope}:${operationId}`;
      const entry = (await this.kv.get<Entry>(key)) ?? { at: now, opened: {} };
      return work({
        has: (url) => Object.hasOwn(entry.opened, url),
        record: async (url, tabId) => {
          entry.opened[url] = tabId;
          await this.kv.set({ [key]: entry }).catch(keepOpenedTab);
        },
      });
    });
  }

  private async prune(now: number) {
    const keys = await this.kv.keys("open:");
    const entries = await this.kv.getMany(keys);
    await this.kv.remove(keys.filter((k) => ((entries[k] as Entry | undefined)?.at ?? 0) < now - REPLAY_WINDOW_MS));
  }
}
