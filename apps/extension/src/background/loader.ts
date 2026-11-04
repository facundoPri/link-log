import {
  documentKey,
  type LoadAction,
  type LoadItemView,
  type LoadRunStatus,
  type LoadRunView,
  type LoadState,
  type SleepReason,
} from "@linklog/browser-protocol";
import type { ResultCache } from "./cache";
import { captureTab, CaptureError } from "./capture";
import { sleepReason, type Hub } from "./hub";
import type { KV, Mutex } from "./kv";
import type { TabRegistry } from "./registry";

export type LoadOptions = {
  /** Most tabs this run keeps awake at once. */
  concurrency: number;
  /** How long a woken tab gets to finish loading. */
  readyTimeoutMs: number;
  /** Time a loaded page gets to render before it is read. */
  settleMs: number;
  pollMs: number;
};
// N and the bound come from the FAC-163 probe (planning/fac-163/run.md).
export const LOAD_DEFAULTS: LoadOptions = { concurrency: 3, readyTimeoutMs: 30_000, settleMs: 1_000, pollMs: 250 };

type Item = {
  tabInstanceId: string;
  windowId: number;
  documentRevision: number;
  docKey: string;
  reason: SleepReason | null;
  state: LoadState;
  /** The run reloaded this tab and owes Chrome a put-back-to-sleep. Persisted before the reload. */
  woke: boolean;
  error?: string;
  note?: string;
};
type Run = { status: LoadRunStatus; pauseReason?: string; items: Item[] };

const KEY = "loadRun";
const IN_SLOT: LoadState[] = ["loading", "capturing", "putting-to-sleep"];
const AWAKE_NOTE = {
  active: "You opened this tab, so it stays awake.",
  audible: "It's playing audio, so it stays awake.",
  navigated: "It moved to another page, so it stays awake.",
};

/** This worker instance was replaced (suspension in Chrome, `stop()` in tests). */
class Stopped extends Error {}
class Skip extends Error {}
class Fail extends Error {
  constructor(message: string, readonly leaveAwake = false) {
    super(message);
  }
}
class CleanupFailed extends Error {}

/**
 * The single Load content run shared by every Linklog page: a sliding window of at most
 * `concurrency` tabs, each revalidated, woken in the background, captured into the result
 * cache and put back to sleep. Its state lives in storage.session so a restarted worker
 * resumes it without waking a tab twice.
 */
export class LoadQueue {
  private run: Run | null = null;
  private slots = new Set<string>();
  private stopped = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private kv: KV,
    private mutex: Mutex,
    private registry: TabRegistry,
    private cache: ResultCache,
    private hub: Hub,
    private opts: LoadOptions = LOAD_DEFAULTS,
  ) {}

  /** Picks up a run a previous worker left, including tabs it had woken. */
  async resume() {
    this.run = (await this.kv.get<Run>(KEY)) ?? null;
    this.pump();
  }

  /** Ends this instance's work without touching state: the next worker owns the run. */
  stop() {
    this.stopped = true;
  }

  itemView(tabInstanceId: string): LoadItemView | null {
    const item = this.run?.items.find((i) => i.tabInstanceId === tabInstanceId);
    if (!item) return null;
    return { state: item.state, ...(item.error ? { error: item.error } : {}), ...(item.note ? { note: item.note } : {}) };
  }

  runView(windowId: number): LoadRunView | null {
    const items = this.run?.items.filter((i) => i.windowId === windowId) ?? [];
    if (!this.run || !items.length) return null;
    const count = (...states: LoadState[]) => items.filter((i) => states.includes(i.state)).length;
    return {
      status: this.run.status,
      ...(this.run.pauseReason ? { pauseReason: this.run.pauseReason } : {}),
      total: items.length,
      queued: count("queued"),
      awake: items.filter((i) => i.woke && IN_SLOT.includes(i.state)).length,
      done: count("done"),
      failed: count("failed"),
      skipped: count("skipped"),
    };
  }

  /** Adds tabs to the running run, or starts one. A tab already in it is not added twice. */
  add(tabs: { tabInstanceId: string; windowId: number; documentRevision: number; url: string; reason: SleepReason | null }[]) {
    return this.mutex.run(async () => {
      if (!this.run || this.run.status === "done" || this.run.status === "cancelled") this.run = { status: "running", items: [] };
      this.run.status = "running";
      delete this.run.pauseReason;
      for (const t of tabs) {
        const existing = this.run.items.find((i) => i.tabInstanceId === t.tabInstanceId);
        if (existing && existing.state !== "failed" && existing.state !== "skipped") continue;
        const item: Item = { ...t, docKey: documentKey(t.url), state: "queued", woke: false };
        if (existing) Object.assign(existing, item, { error: undefined, note: undefined });
        else this.run.items.push(item);
      }
      await this.save();
      this.pump();
      return this.run.items.length;
    });
  }

  control(action: LoadAction) {
    return this.mutex.run(async () => {
      const run = this.run;
      if (!run) return;
      if (action === "pause" && run.status === "running") run.status = "paused";
      if (action === "resume" && run.status === "paused") {
        run.status = "running";
        delete run.pauseReason;
      }
      if (action === "cancel" && (run.status === "running" || run.status === "paused")) {
        run.status = "cancelled";
        for (const item of run.items) if (item.state === "queued") Object.assign(item, { state: "skipped", error: "Cancelled." });
      }
      if (action === "retry") {
        const failed = run.items.filter((i) => i.state === "failed");
        if (failed.length) {
          for (const item of failed) Object.assign(item, { state: "queued", error: undefined, note: undefined, woke: false });
          run.status = "running";
          delete run.pauseReason;
        }
      }
      await this.save();
      this.pump();
    });
  }

  private save() {
    if (this.stopped) return Promise.resolve();
    const snapshot = this.run;
    this.saving = this.saving.then(() => this.kv.set({ [KEY]: snapshot })).catch((e) => console.warn("Linklog: could not save the load run", e));
    this.hub.schedule(0);
    return this.saving;
  }

  private alive() {
    if (this.stopped) throw new Stopped();
  }

  /** Fills free slots: tabs a previous worker left mid-way first (they may be awake), then queued ones. */
  private pump() {
    const run = this.run;
    if (!run || this.stopped) return;
    const free = (i: Item) => !this.slots.has(i.tabInstanceId);
    const next = () =>
      run.items.find((i) => IN_SLOT.includes(i.state) && free(i)) ??
      (run.status === "running" ? run.items.find((i) => i.state === "queued" && free(i)) : undefined);
    while (this.slots.size < this.opts.concurrency) {
      const item = next();
      if (!item) break;
      this.slots.add(item.tabInstanceId);
      void this.slot(item);
    }
    if (run.status === "running" && !this.slots.size && !run.items.some((i) => i.state === "queued" || IN_SLOT.includes(i.state))) {
      run.status = "done";
      void this.save();
    }
  }

  private async slot(item: Item) {
    try {
      await this.process(item);
    } catch (error) {
      if (error instanceof Stopped) return;
      if (error instanceof CleanupFailed) {
        Object.assign(item, { state: "failed", error: error.message });
        if (this.run && this.run.status === "running") {
          this.run.status = "paused";
          this.run.pauseReason = "Linklog couldn't put a tab back to sleep, so loading paused. Put it to sleep or close it, then resume.";
        }
      } else if (error instanceof Skip) Object.assign(item, { state: "skipped", error: error.message, woke: false });
      else {
        Object.assign(item, { state: "failed", error: error instanceof Fail ? error.message : "The page could not be read." });
        // Left awake on another page: no longer the run's to put to sleep.
        if (error instanceof Fail && error.leaveAwake) item.woke = false;
      }
    } finally {
      this.slots.delete(item.tabInstanceId);
      if (!this.stopped) {
        await this.save();
        this.pump();
      }
    }
  }

  /** Revalidates the tab against the instance and document the run was given. */
  private async current(item: Item): Promise<chrome.tabs.Tab> {
    this.alive();
    const tabId = this.registry.tabIdOf(item.tabInstanceId);
    const tab = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
    this.alive();
    if (!tab) throw new Skip("The tab was closed.");
    if (tab.windowId !== item.windowId) throw new Skip("The tab moved to another window.");
    return tab;
  }

  private sameDocument(item: Item, tab: chrome.tabs.Tab) {
    const instance = this.registry.get(tab.id!);
    return instance?.documentRevision === item.documentRevision && documentKey(tab.url || tab.pendingUrl || "") === item.docKey;
  }

  private cancelled() {
    return this.run?.status === "cancelled";
  }

  private async process(item: Item) {
    let tab = await this.current(item);
    if (!this.sameDocument(item, tab)) {
      if (!item.woke) throw new Skip("The tab navigated to another page.");
      throw new Fail("The page went to another address (maybe a sign-in page), so it wasn't captured. It stays awake.", true);
    }
    if (this.cancelled()) return this.abandon(item, tab);
    const asleep = !!sleepReason(tab);
    if (!item.woke && !asleep && tab.status === "complete") {
      // Already awake (the user opened it): read it, and leave it as it is.
      item.state = "capturing";
      await this.save();
      await this.capture(item, tab);
      Object.assign(item, { state: "done", note: "It was already awake, so it stays awake." });
      return;
    }
    if (item.state === "putting-to-sleep" && asleep) {
      // A previous worker put it back to sleep but didn't record it.
      Object.assign(item, { state: "done", woke: false });
      return;
    }
    if (!item.woke || asleep) {
      if ((tab as { frozen?: boolean }).frozen) {
        // A frozen page runs no script; Chrome can't freeze it again, so it ends up asleep.
        await chrome.tabs.discard(tab.id!);
        item.note = "It was frozen; Linklog put it to sleep instead.";
        tab = await this.current(item);
      }
      Object.assign(item, { state: "loading", woke: true });
      await this.save();
      this.alive();
      await chrome.tabs.reload(tab.id!);
    } else if (item.state === "queued") {
      item.state = "loading";
      await this.save();
    }
    if (item.state === "loading") {
      const loaded = await this.ready(item);
      if (!loaded) return;
      tab = loaded;
      item.state = "capturing";
      await this.save();
    }
    if (item.state === "capturing") {
      try {
        await this.capture(item, tab);
      } catch (error) {
        await this.putBack(item);
        throw error;
      }
      item.state = "putting-to-sleep";
      await this.save();
    }
    await this.putBack(item);
    item.state = "done";
  }

  /** Waits for the woken tab to load, bounded; null if the run was cancelled meanwhile. */
  private async ready(item: Item): Promise<chrome.tabs.Tab | null> {
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    while (true) {
      const tab = await this.current(item);
      if (!this.sameDocument(item, tab)) {
        item.woke = false;
        throw new Fail("The page went to another address (maybe a sign-in page), so it wasn't captured. It stays awake.", true);
      }
      if (this.cancelled()) {
        await this.abandon(item, tab);
        return null;
      }
      if (tab.status === "complete" && !sleepReason(tab)) {
        if (this.opts.settleMs) await wait(this.opts.settleMs);
        const settled = await this.current(item);
        if (!this.sameDocument(item, settled)) continue;
        return settled;
      }
      if (Date.now() > deadline) {
        await this.putBack(item);
        throw new Fail(`The page didn't finish loading within ${Math.round(this.opts.readyTimeoutMs / 1000)} seconds.`);
      }
      await wait(this.opts.pollMs);
    }
  }

  private async capture(item: Item, tab: chrome.tabs.Tab) {
    let capture;
    try {
      capture = await captureTab(tab.id!);
    } catch (error) {
      throw new Fail(error instanceof CaptureError ? error.message : "The page could not be read.");
    }
    this.alive();
    const now = await this.current(item);
    if (!this.sameDocument(item, now) || (capture.url && documentKey(capture.url) !== item.docKey))
      throw new Fail("The page went to another address (maybe a sign-in page), so it wasn't captured. It stays awake.", true);
    await this.cache.putCapture(item.tabInstanceId, item.documentRevision, "dom", capture);
  }

  /** Cancelled mid-way: whatever the run woke goes back to sleep; the tab is skipped. */
  private async abandon(item: Item, _tab: chrome.tabs.Tab) {
    await this.putBack(item);
    Object.assign(item, { state: "skipped", error: "Cancelled.", woke: false });
  }

  /** Puts back to sleep a tab this run woke, unless the user is using it now. */
  private async putBack(item: Item) {
    if (!item.woke) return;
    const tab = await this.current(item).catch((e) => {
      if (e instanceof Skip) return null;
      throw e;
    });
    if (!tab) return void (item.woke = false);
    const keep = tab.active ? AWAKE_NOTE.active : tab.audible ? AWAKE_NOTE.audible : !this.sameDocument(item, tab) ? AWAKE_NOTE.navigated : null;
    if (keep) {
      Object.assign(item, { woke: false, note: keep });
      return;
    }
    if (!sleepReason(tab)) {
      this.alive();
      const slept = await chrome.tabs.discard(tab.id!).catch((e: Error) => {
        throw new CleanupFailed(`Linklog couldn't put this tab back to sleep: ${e.message || "Chrome refused."}`);
      });
      if (!slept) throw new CleanupFailed("Linklog couldn't put this tab back to sleep: Chrome refused.");
    }
    item.woke = false;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
