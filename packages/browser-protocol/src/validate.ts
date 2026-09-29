import {
  GROUP_COLORS,
  type BridgeEnvelope,
  type CommandName,
  type DepositItem,
  type ExtensionEvent,
  type ExtensionResponse,
  type GroupColor,
  type MoveTarget,
  type PageRequest,
  type TabRef,
  BRIDGE_CHANNEL,
} from "./browser.ts";

// Minimal structural validation at trust boundaries. Anything that fails is dropped.
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 4096): v is string =>
  typeof v === "string" && v.length <= max;
const int = (v: unknown): v is number => Number.isInteger(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(v);
const color = (v: unknown): v is GroupColor =>
  typeof v === "string" && (GROUP_COLORS as string[]).includes(v);

function tabRef(v: unknown): v is TabRef {
  return isObj(v) && int(v.tabId) && id(v.tabInstanceId) && (v.documentRevision === undefined || int(v.documentRevision));
}
/** Serialized size cap for structured values relayed from the backend (answers). */
const small = (v: unknown, max = 20_000) => {
  try {
    return JSON.stringify(v).length <= max;
  } catch {
    return false;
  }
};
function tabRefs(v: unknown, max = 500): v is TabRef[] {
  return Array.isArray(v) && v.length <= max && v.every(tabRef);
}
function lensRef(v: unknown): boolean {
  return isObj(v) && id(v.id) && id(v.fingerprint);
}
function moveTarget(v: unknown): v is MoveTarget {
  if (!isObj(v)) return false;
  if (v.kind === "group") return int(v.groupId);
  if (v.kind === "new")
    return str(v.title, 80) && color(v.color) && str(v.description, 2000);
  if (v.kind === "pinned")
    return (
      id(v.pinnedId) &&
      str(v.title, 80) &&
      color(v.color) &&
      str(v.description, 2000)
    );
  return false;
}
const DEPOSIT_STATES = ["queued", "running", "done", "failed", "expired"];
function depositItem(v: unknown): v is DepositItem {
  return (
    isObj(v) &&
    str(v.targetKey, 400) &&
    typeof v.state === "string" &&
    DEPOSIT_STATES.includes(v.state) &&
    (v.answer === undefined || (isObj(v.answer) && small(v.answer))) &&
    (v.model === undefined || str(v.model, 200)) &&
    (v.evaluatedAt === undefined || str(v.evaluatedAt, 64)) &&
    (v.error === undefined || str(v.error, 2000)) &&
    (v.jobId === undefined || id(v.jobId))
  );
}

const validators: { [K in CommandName]: (a: Obj) => boolean } = {
  hello: (a) => str(a.libraryScope, 200) && a.libraryScope.length > 0,
  snapshot: () => true,
  results: (a) => Array.isArray(a.lenses) && a.lenses.length <= 50 && a.lenses.every(lensRef),
  claim: (a) =>
    lensRef(a.lens) &&
    (a.tabInstanceIds === undefined ||
      (Array.isArray(a.tabInstanceIds) && a.tabInstanceIds.length <= 500 && a.tabInstanceIds.every(id))) &&
    (a.force === undefined || typeof a.force === "boolean") &&
    (a.source === undefined || a.source === "dom" || a.source === "metadata") &&
    (a.resumeRequestId === undefined || id(a.resumeRequestId)) &&
    (a.limit === undefined || (int(a.limit) && a.limit > 0 && a.limit <= 100)),
  accepted: (a) =>
    id(a.requestId) &&
    id(a.batchId) &&
    Array.isArray(a.jobs) &&
    a.jobs.length <= 100 &&
    a.jobs.every((j) => isObj(j) && str(j.targetKey, 400) && id(j.jobId)),
  release: (a) =>
    id(a.requestId) && str(a.error, 2000) && (a.state === "failed" || a.state === "missing"),
  pending: () => true,
  deposit: (a) =>
    id(a.requestId) &&
    (a.batchId === undefined || id(a.batchId)) &&
    Array.isArray(a.items) &&
    a.items.length <= 100 &&
    a.items.every(depositItem),
  clean: (a) =>
    Array.isArray(a.lensIds) &&
    a.lensIds.length <= 50 &&
    a.lensIds.every(id) &&
    (a.tabInstanceIds === undefined ||
      (Array.isArray(a.tabInstanceIds) && a.tabInstanceIds.length <= 500 && a.tabInstanceIds.every(id))),
  capture: (a) =>
    tabRefs(a.tabs, 100) &&
    (a.source === undefined || a.source === "dom" || a.source === "metadata") &&
    (a.fresh === undefined || typeof a.fresh === "boolean"),
  previews: (a) => tabRefs(a.tabs, 200),
  closeTabs: (a) =>
    Array.isArray(a.tabs) && a.tabs.length <= 500 && a.tabs.every((t) => tabRef(t) && str((t as Obj).url)),
  moveToGroup: (a) =>
    tabRefs(a.tabs) &&
    moveTarget(a.target) &&
    (a.onlyIfUngrouped === undefined || typeof a.onlyIfUngrouped === "boolean"),
  ungroup: (a) => tabRefs(a.tabs),
  updateGroup: (a) =>
    int(a.groupId) &&
    (a.title === undefined || str(a.title, 80)) &&
    (a.color === undefined || color(a.color)) &&
    (a.description === undefined || str(a.description, 2000)) &&
    (a.pinnedId === undefined || a.pinnedId === null || id(a.pinnedId)),
  unbindPinned: (a) => id(a.pinnedId),
  focusTab: (a) => tabRef(a.tab),
  openPermissions: () => true,
};

export function parsePageRequest(raw: unknown): PageRequest | null {
  if (!isObj(raw) || !id(raw.id) || typeof raw.command !== "string") return null;
  // Own keys only: "constructor", "toString"… are not commands.
  if (!Object.hasOwn(validators, raw.command)) return null;
  const validate = validators[raw.command as CommandName];
  const args = raw.args === undefined ? {} : raw.args;
  if (!isObj(args) || !validate(args)) return null;
  return { id: raw.id, command: raw.command, args } as PageRequest;
}

export function parseEnvelope(raw: unknown): BridgeEnvelope | null {
  if (!isObj(raw) || raw.channel !== BRIDGE_CHANNEL) return null;
  if (raw.from === "page") {
    const request = parsePageRequest(raw.request);
    return request ? { channel: BRIDGE_CHANNEL, from: "page", request } : null;
  }
  if (raw.from === "extension") return raw as BridgeEnvelope;
  return null;
}

export function isExtensionResponse(v: unknown): v is ExtensionResponse {
  return isObj(v) && id(v.id) && typeof v.ok === "boolean";
}

export function isExtensionEvent(v: unknown): v is ExtensionEvent {
  return (
    isObj(v) &&
    ["snapshot", "patch", "results-changed", "access-changed", "scope-changed"].includes(
      String(v.event),
    )
  );
}
