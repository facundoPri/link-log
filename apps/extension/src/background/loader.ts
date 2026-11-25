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
const CLEANUP_PAUSE = "Linklog couldn't put a tab back to sleep, so loading paused. Put it to sleep or close it, then resume.";
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
      // A failed tab the run couldn't put back to sleep is still awake.
      awake: items.filter((i) => i.woke && (IN_SLOT.includes(i.state) || i.state === "failed")).length,
      done: count("done"),
      failed: count("failed"),
      skipped: count("skipped"),
    };
  }

  /** Adds tabs to the running run, or starts one. A tab already in it is not added twice. */
  add(tabs: { tabInstanceId: string; windowId: number; documentRevision: number; url: string; reason: SleepReason | null }[]) {
    return this.mutex.run(async () => {
      await this.releaseSettled();
      // A new run keeps the tabs a cancelled run's slots still hold: they finish (and go
      // back to sleep) in it, stay persisted, and are not woken a second time.
      // A tab an earlier run woke and couldn't put back (`woke`, e.g. failed) stays too: this run owes it only
      // the put-back-to-sleep (slots take it first), keeps its outcome, and never drops it from storage.
      if (!this.run || this.run.status === "done" || this.run.status === "cancelled") {
        const held = this.run?.items.filter((i) => this.slots.has(i.tabInstanceId)) ?? [];
        const owed = (this.run?.items ?? [])
          .filter((i) => i.woke && !this.slots.has(i.tabInstanceId))
          .map((i): Item => ({ ...i, state: "putting-to-sleep" }));
        this.run = { status: "running", items: [...held, ...owed] };
      }
      this.run.status = "running";
      delete this.run.pauseReason;
      for (const t of tabs) {
        const existing = this.run.items.find((i) => i.tabInstanceId === t.tabInstanceId);
        if (existing && ((existing.state !== "failed" && existing.state !== "skipped") || this.slots.has(existing.tabInstanceId))) continue;
        // `woke` survives a requeue: a tab the run woke and couldn't put back is still the run's to put to sleep.
        const item: Item = { ...t, docKey: documentKey(t.url), state: "queued", woke: existing?.woke ?? false };
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
      await this.releaseSettled();
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
          // Keep `woke`: a tab the run woke and couldn't put back to sleep must still go back to sleep.
          for (const item of failed) Object.assign(item, { state: "queued", error: undefined, note: undefined });
          run.status = "running";
          delete run.pauseReason;
        }
      }
      await this.save();
      this.pump();
    });
  }

  /** Persists the run; failures are logged, or thrown with `strict` (a step that must not run unsaved). */
  /**
   * A failed tab the run couldn't put back stays the run's (`woke`) and takes a slot until it is asleep or
   * closed: the user does that, then resumes. Re-check those tabs so the slots come back.
   */
  private async releaseSettled() {
    for (const item of this.run?.items ?? []) {
      if (!item.woke || item.state !== "failed" || this.slots.has(item.tabInstanceId)) continue;
      const tabId = this.registry.tabIdOf(item.tabInstanceId);
      const tab = tabId === undefined ? null : await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.windowId !== item.windowId || sleepReason(tab)) item.woke = false;
    }
  }

  private save(strict = false) {
    if (this.stopped) return Promise.resolve();
    const snapshot = this.run;
    const attempt = this.saving.then(() => this.kv.set({ [KEY]: snapshot }));
    this.saving = attempt.catch((e) => console.warn("Linklog: could not save the load run", e));
    this.hub.schedule(0);
    return strict ? attempt : this.saving;
  }

  private alive() {
    if (this.stopped) throw new Stopped();
  }

  /** Fills free slots: tabs a previous worker left mid-way first (they may be awake), then queued ones. */
  private pump() {
    const run = this.run;
    if (!run || this.stopped) return;
    const free = (i: Item) => !this.slots.has(i.tabInstanceId);
    // Awake because of this run without a slot: failed tabs it couldn't put back, and woken tabs requeued
    // by Retry. Slots plus these never pass the limit; recounted each pick, so a picked one counts once.
    const owed = () => run.items.filter((i) => free(i) && i.woke && (i.state === "failed" || i.state === "queued")).length;
    const next = () =>
      // Mid-way tabs (a previous worker's) and already-woken queued ones first: picking them wakes nothing new.
      run.items.find((i) => IN_SLOT.includes(i.state) && free(i)) ??
      (run.status === "running" ? run.items.find((i) => i.state === "queued" && i.woke && free(i)) : undefined) ??
      (run.status === "running" && this.slots.size + owed() < this.opts.concurrency
        ? run.items.find((i) => i.state === "queued" && !i.woke && free(i))
        : undefined);
    while (this.slots.size < this.opts.concurrency) {
      const item = next();
      if (!item) break;
      this.slots.add(item.tabInstanceId);
      void this.slot(item);
    }
    if (run.status === "running" && !this.slots.size && owed() >= this.opts.concurrency && run.items.some((i) => i.state === "queued")) {
      // Every slot is a tab Chrome kept awake: waking more would pass the limit.
      run.status = "paused";
      run.pauseReason = CLEANUP_PAUSE;
      void this.save();
      return;
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
          this.run.pauseReason = CLEANUP_PAUSE;
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
      Object.assign(item, { state: item.error ? "failed" : "done", woke: false });
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
      // `woke` must be on disk before the reload: a restarted worker would otherwise leave the tab awake.
      await this.save(true).catch((error) => {
        if (error instanceof Stopped) throw error;
        item.woke = false;
        throw new Fail("Linklog couldn't save its progress, so it didn't wake this tab.");
      });
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
    // An earlier run's failure that this run only put back to sleep stays a failure.
    item.state = item.error ? "failed" : "done";
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
    // Chrome may never answer a page that froze after loading: bound the wait (same bound as loading) and
    // let a cancel end it. A late answer is dropped: nothing below runs for it.
    const read = captureTab(tab.id!).then(
      (capture) => ({ capture }),
      (error: unknown) => ({ error }),
    );
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    let outcome: Awaited<typeof read> | "timeout" | "cancelled" | null = null;
    while (!outcome) {
      outcome = await Promise.race([read, wait(this.opts.pollMs).then(() => null)]);
      this.alive();
      if (!outcome && this.cancelled()) outcome = "cancelled";
      else if (!outcome && Date.now() > deadline) outcome = "timeout";
    }
    if (outcome === "cancelled") throw new Skip("Cancelled.");
    if (outcome === "timeout")
      throw new Fail(`The page didn't answer within ${Math.round(this.opts.readyTimeoutMs / 1000)} seconds, so it wasn't captured.`);
    if ("error" in outcome) throw new Fail(outcome.error instanceof CaptureError ? outcome.error.message : "The page could not be read.");
    const capture = outcome.capture;
    const now = await this.current(item);
    if (!this.sameDocument(item, now) || (capture.url && documentKey(capture.url) !== item.docKey))
      throw new Fail("The page went to another address (maybe a sign-in page), so it wasn't captured. It stays awake.", true);
    if (!(await this.cache.putCapture(item.tabInstanceId, item.documentRevision, "dom", capture)))
      throw new Fail("There is no room to keep this page, so nothing was captured.");
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
