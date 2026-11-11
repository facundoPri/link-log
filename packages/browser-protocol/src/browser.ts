import type { Answer } from "./lens.ts";

// Bump whenever a message or snapshot shape changes, so a stale extension build is
// reported as outdated instead of feeding the page fields it doesn't have.
export const PROTOCOL_VERSION = 3;
/** window.postMessage channel between the Linklog page and the bridge content script. */
export const BRIDGE_CHANNEL = "linklog-bridge";
/** chrome.runtime.connect port name used only by the bridge content script. */
export const BRIDGE_PORT = "linklog-bridge";
/** `<meta name="linklog-app">` marks a page as Linklog; the bridge stays inert elsewhere. */
export const LINKLOG_APP_META = "linklog-app";

export type GroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";
export const GROUP_COLORS: GroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

/** Why a tab's content can or cannot be read right now. Never a lens answer. */
export type ContentAccess =
  | "available"
  | "loading" // a navigation in progress, for at most LOADING_BOUND_MS
  | "stalled" // still loading after LOADING_BOUND_MS
  | "restricted" // chrome://, extension pages, web store, file:, …
  | "no-permission" // host access not granted yet
  | "sleeping"; // see SleepReason

/** Loading longer than this is shown as stalled, not as a spinner. */
export const LOADING_BOUND_MS = 30_000;

/** Why a Sleeping tab's page isn't loaded: a detail, never a separate state. */
export type SleepReason =
  | "unloaded" // Chrome discarded it to save memory
  | "frozen" // Chrome froze it in the background
  | "not-loaded"; // restored at startup and never loaded

/** Where one tab stands in a Load content run. */
export type LoadState =
  | "queued"
  | "loading"
  | "capturing"
  | "putting-to-sleep"
  | "done"
  | "failed"
  | "skipped";
export type LoadItemView = {
  state: LoadState;
  /** Why it failed or was skipped. */
  error?: string;
  /** What changed for the user, e.g. a frozen tab that is now asleep or a tab left awake. */
  note?: string;
};
export type LoadRunStatus = "running" | "paused" | "cancelled" | "done";
/** One Load content run, counted for the window that sees it. */
export type LoadRunView = {
  status: LoadRunStatus;
  /** Set when the run paused itself (e.g. a tab could not be put back to sleep). */
  pauseReason?: string;
  total: number;
  queued: number;
  awake: number;
  done: number;
  failed: number;
  skipped: number;
};

export type BrowserTab = {
  tabId: number;
  /** One concrete opening of a tab. Reopening the same URL gets a new instance. */
  tabInstanceId: string;
  /** Bumps when the document (URL without fragment) changes. */
  documentRevision: number;
  windowId: number;
  index: number;
  groupId: number | null;
  title: string;
  url: string;
  favIconUrl: string | null;
  status: "loading" | "complete" | "unloaded";
  active: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  frozen: boolean;
  content: ContentAccess;
  /** Set exactly when `content` is "sleeping". */
  sleep: SleepReason | null;
  /** This document's content captured earlier (readable while the tab sleeps). */
  capturedAt: string | null;
  /** This tab's place in the current Load content run. */
  load: LoadItemView | null;
  /** When the extension first saw this opening (install, restart or reload reset it). */
  firstSeenAt: number;
};

export type BrowserGroup = {
  groupId: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
  /** Linklog metadata: Chrome groups have no description. */
  description: string;
  /** Pinned definition bound to this native group, if any. */
  pinnedId: string | null;
};

export type WindowSnapshot = {
  revision: number;
  windowId: number;
  tabs: BrowserTab[];
  groups: BrowserGroup[];
  /** Linklog pages in this window; they are never listed or closed. */
  linklogTabs: number;
  /** The shared Load content run, if it has tabs in this window. */
  loadRun: LoadRunView | null;
};

export type WindowPatch = {
  baseRevision: number;
  revision: number;
  windowId: number;
  upsertTabs: BrowserTab[];
  removeTabs: number[];
  order: number[];
  upsertGroups: BrowserGroup[];
  removeGroups: number[];
  linklogTabs: number;
  loadRun: LoadRunView | null;
};

export type ResultState =
  | "missing"
  | "submitting"
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "unavailable"
  | "expired";
export const IN_FLIGHT: ResultState[] = ["submitting", "queued", "running"];

export type CaptureSummary = {
  source: "dom" | "metadata";
  capturedAt: string;
  completeness: "complete" | "partial";
  reasons: string[];
  chars: number;
  facts: PageFact[];
};

export type LensRecord = {
  state: ResultState;
  answer?: Answer;
  model?: string;
  evaluatedAt?: string;
  capture?: CaptureSummary;
  requestId?: string;
  batchId?: string;
  jobId?: string;
  error?: string;
  updatedAt: number;
};

/** Unambiguous evidence read deterministically from a page (e.g. a PR "Merged" badge). */
export type PageFact = { key: string; label: string; value: string };

export type Capture = CaptureSummary & {
  url: string;
  title: string;
  description: string;
  siteName: string;
  markdown: string;
  /** og:image / twitter:image, absolute http(s). */
  image?: string;
  byline?: string;
  lang?: string;
  /** "article": Readability picked the main content; "page": the main region was kept whole. */
  extractor?: "article" | "page";
};

/** Page metadata read locally for list rows; never sent anywhere. */
export type TabPreview = {
  tabInstanceId: string;
  documentRevision: number;
  description: string;
  siteName: string;
  image: string;
};

export type LensRef = { id: string; fingerprint: string };

export type ClaimTarget = {
  targetKey: string;
  tabId: number;
  tabInstanceId: string;
  documentRevision: number;
  generation: number;
  url: string;
  title: string;
  capture: Capture;
};

export type HelloAck = {
  protocol: number;
  extensionVersion: string;
  installationId: string;
  browserSessionId: string;
  windowId: number;
  capabilities: string[];
  contentAccess: boolean;
};

export type ItemResult = { tabId: number; ok: boolean; error?: string };

export type LoadAction = "pause" | "resume" | "cancel" | "retry";

/** How one requested URL ended up. */
export type OpenOutcome =
  | { url: string; outcome: "opened" } // a tab was created for it by this operation (now or in an earlier attempt of the same operationId)
  | { url: string; outcome: "already-open" } // a tab with the same documentKey was already in the window; nothing created
  | { url: string; outcome: "failed"; error: string };

export type MoveTarget =
  | { kind: "group"; groupId: number }
  | { kind: "new"; title: string; color: GroupColor; description: string }
  | {
      kind: "pinned";
      pinnedId: string;
      title: string;
      color: GroupColor;
      description: string;
    };

/** A tab as the page saw it. With `documentRevision`, commands refuse a tab that navigated since. */
export type TabRef = { tabId: number; tabInstanceId: string; documentRevision?: number };

export type DepositItem = {
  targetKey: string;
  state: "queued" | "running" | "done" | "failed" | "expired";
  answer?: Answer;
  model?: string;
  evaluatedAt?: string;
  error?: string;
  jobId?: string;
};

export type PendingRequest = {
  requestId: string;
  lensId: string;
  fingerprint: string;
  batchId: string | null;
  createdAt: number;
  targets: { targetKey: string; state: ResultState }[];
};

/** Page → extension commands and their results. */
export type Commands = {
  hello: { args: { libraryScope: string }; result: HelloAck };
  snapshot: { args: {}; result: WindowSnapshot };
  results: {
    args: { lenses: LensRef[] };
    result: { results: Record<string, Record<string, LensRecord>> };
  };
  claim: {
    args: {
      lens: LensRef;
      /** Explicit retry/re-evaluation of these instances; otherwise only missing ones. */
      tabInstanceIds?: string[];
      force?: boolean;
      /** Title and URL only, chosen explicitly by the user. */
      source?: "dom" | "metadata";
      /** Re-capture the targets of a request whose POST may never have arrived. */
      resumeRequestId?: string;
      limit?: number;
    };
    result: {
      requestId: string | null;
      targets: ClaimTarget[];
      /** Wanted but left for a later claim (limit or request size). */
      skipped: number;
      /** Instances claimed this round, including ones whose capture failed. */
      attempted: string[];
    };
  };
  accepted: {
    args: {
      requestId: string;
      batchId: string;
      jobs: { targetKey: string; jobId: string }[];
    };
    result: {};
  };
  release: {
    args: { requestId: string; error: string; state: "failed" | "missing" };
    result: {};
  };
  pending: { args: {}; result: { requests: PendingRequest[] } };
  deposit: {
    args: { requestId: string; batchId?: string; items: DepositItem[] };
    result: { stored: string[]; dropped: string[] };
  };
  clean: {
    args: { lensIds: string[]; tabInstanceIds?: string[] };
    /** Requests with queued work to cancel, and exactly which of their targets. */
    result: { removed: number; requests: { requestId: string; targetKeys: string[] }[] };
  };
  capture: {
    /** `fresh` re-reads the page instead of reusing this revision's cached capture. */
    args: { tabs: TabRef[]; source?: "dom" | "metadata"; fresh?: boolean };
    result: {
      captures: { tabId: number; capture?: Capture; error?: string }[];
    };
  };
  previews: {
    args: { tabs: TabRef[] };
    result: { previews: TabPreview[] };
  };
  closeTabs: { args: { tabs: (TabRef & { url: string })[] }; result: { items: ItemResult[] } };
  moveToGroup: {
    args: { tabs: TabRef[]; target: MoveTarget; onlyIfUngrouped?: boolean };
    result: { items: ItemResult[]; groupId: number | null };
  };
  ungroup: { args: { tabs: TabRef[] }; result: { items: ItemResult[] } };
  updateGroup: {
    args: {
      groupId: number;
      title?: string;
      color?: GroupColor;
      description?: string;
      pinnedId?: string | null;
    };
    result: {};
  };
  unbindPinned: { args: { pinnedId: string }; result: { groups: number } };
  focusTab: { args: { tab: TabRef }; result: {} };
  openTabs: {
    /** `operationId` makes a retry of an unconfirmed request replay instead of opening duplicates. */
    args: { operationId: string; urls: string[] };
    /** One outcome per requested URL, same order. */
    result: { items: OpenOutcome[] };
  };
  openPermissions: { args: {}; result: {} };
  /**
   * Wake these Sleeping tabs in the background, capture them and put them back to sleep.
   * Joins the running run; `items` says which tabs were added or why not.
   */
  loadContent: { args: { tabs: TabRef[] }; result: { items: ItemResult[]; loadRun: LoadRunView | null } };
  loadControl: { args: { action: LoadAction }; result: { loadRun: LoadRunView | null } };
  /** Put to sleep: one outcome per tab, skipped ones with the reason. */
  sleepTabs: { args: { tabs: TabRef[] }; result: { items: ItemResult[] } };
  /**
   * Sign-out: drop this connection's library-scope results and pending requests, then end the
   * handshake. Only offered when hello lists the "forget" capability.
   */
  forget: { args: {}; result: { removed: number } };
};
export type CommandName = keyof Commands;

export type PageRequest = {
  [K in CommandName]: { id: string; command: K; args: Commands[K]["args"] };
}[CommandName];

export type ExtensionEvent =
  | { event: "snapshot"; snapshot: WindowSnapshot }
  | { event: "patch"; patch: WindowPatch }
  | { event: "results-changed"; windowId: number }
  | { event: "access-changed"; contentAccess: boolean }
  | { event: "scope-changed"; windowId: number };

export type ExtensionResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: string };

/** Envelope on window.postMessage. `from` makes page and bridge ignore their own posts. */
export type BridgeEnvelope =
  | { channel: typeof BRIDGE_CHANNEL; from: "page"; request: PageRequest }
  | {
      channel: typeof BRIDGE_CHANNEL;
      from: "extension";
      response?: ExtensionResponse;
      event?: ExtensionEvent;
      ready?: { version: string; protocol: number };
      disconnected?: true;
    };
