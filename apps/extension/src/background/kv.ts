// Storage seam: chrome.storage areas in the extension, an in-memory map in unit tests.
export interface KV {
  get<T = unknown>(key: string): Promise<T | undefined>;
  getMany(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  keys(prefix: string): Promise<string[]>;
  bytesInUse(): Promise<number>;
  quota: number;
}

export class QuotaError extends Error {
  constructor(message = "The browser's session cache is full. Clean lens results or close tabs.") {
    super(message);
    this.name = "QuotaError";
  }
}

export function chromeKV(area: chrome.storage.StorageArea, quota: number): KV {
  return {
    quota,
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    async getMany(keys) {
      return keys.length ? area.get(keys) : {};
    },
    async set(items) {
      try {
        await area.set(items);
      } catch (error) {
        if (/quota/i.test(String(error))) throw new QuotaError();
        throw error;
      }
    },
    async remove(keys) {
      if (keys.length) await area.remove(keys);
    },
    async keys(prefix) {
      return Object.keys(await area.get(null)).filter((k) => k.startsWith(prefix));
    },
    async bytesInUse() {
      return area.getBytesInUse(null);
    },
  };
}

export function memoryKV(quota = 10 * 1024 * 1024): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const size = () =>
    [...data].reduce((n, [k, v]) => n + k.length + JSON.stringify(v).length, 0);
  return {
    data,
    quota,
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : (structuredClone(v) as T);
    },
    async getMany(keys) {
      return Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]));
    },
    async set(items) {
      const before = new Map(data);
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
      if (size() > quota) {
        data.clear();
        for (const [k, v] of before) data.set(k, v);
        throw new QuotaError();
      }
    },
    async remove(keys) {
      for (const k of keys) data.delete(k);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    async bytesInUse() {
      return size();
    },
  };
}

/**
 * chrome.storage is not transactional: serialize every read-modify-write in this
 * service worker so two Linklog pages cannot both claim the same tab.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
