import type { ContentAccess } from "./browser.ts";

/**
 * The document a result belongs to. The fragment is ignored (in-page anchors and
 * hash routers that only scroll); path and query changes — including SPA
 * pushState navigations — are a new document. Reloading the same URL is not.
 */
export function documentKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

const RESTRICTED_HOSTS = new Set([
  "chromewebstore.google.com",
  "chrome.google.com",
]);

/** Access decided from the URL alone; runtime state (discarded, permission) is added by the extension. */
export function urlAccess(url: string): ContentAccess {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "restricted";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "restricted";
  if (
    RESTRICTED_HOSTS.has(u.hostname) &&
    (u.hostname !== "chrome.google.com" || u.pathname.startsWith("/webstore"))
  )
    return "restricted";
  return "available";
}

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** Content-script matches for the bridge: local development on any port (Chrome ignores ports without one). */
export const LOCAL_BRIDGE_MATCHES = ["http://localhost/*", "http://127.0.0.1/*"];

/**
 * Origins where the bridge may run: http localhost / 127.0.0.1 on any port, plus
 * explicitly configured Linklog origins (e.g. a deployed one). The page must also
 * identify itself as Linklog before the bridge activates.
 */
export function isBridgeOrigin(origin: string, configured: readonly string[]): boolean {
  if (configured.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.origin === origin;
  } catch {
    return false;
  }
}

export type TargetKeyParts = {
  tabInstanceId: string;
  documentRevision: number;
  lensId: string;
  fingerprint: string;
  generation: number;
};

/** Opaque to the backend; lets the extension reject late results for a stale context. */
export function targetKey(p: TargetKeyParts): string {
  return [p.tabInstanceId, p.documentRevision, p.lensId, p.fingerprint, p.generation].join("~");
}

export function parseTargetKey(key: string): TargetKeyParts | null {
  const parts = key.split("~");
  if (parts.length !== 5) return null;
  const [tabInstanceId, rev, lensId, fingerprint, gen] = parts as [string, string, string, string, string];
  const documentRevision = Number(rev),
    generation = Number(gen);
  if (
    !tabInstanceId ||
    !lensId ||
    !fingerprint ||
    !Number.isInteger(documentRevision) ||
    !Number.isInteger(generation)
  )
    return null;
  return { tabInstanceId, documentRevision, lensId, fingerprint, generation };
}

/** Local cache key: libraryScope / browserSessionId / tab / revision / lens / version / generation. */
export function cacheKey(
  libraryScope: string,
  browserSessionId: string,
  p: TargetKeyParts,
): string {
  return [libraryScope, browserSessionId, targetKey(p)].join("/");
}

/** Owner of a library scope. Local-only today; a future account id slots in here. */
export const LOCAL_OWNER = "local";
export function libraryScope(libraryId: string, owner = LOCAL_OWNER): string {
  return `${owner}:${libraryId}`;
}

/** Does a Chrome match pattern (host permission) cover this URL? Paths are ignored. */
export function patternCovers(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return urlAccess(url) === "available";
  const m = /^(\*|https?):\/\/([^/]+)\//.exec(pattern);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!m) return false;
  const [, scheme, hostPort] = m as unknown as [string, string, string];
  if (scheme === "*" ? !["http:", "https:"].includes(u.protocol) : u.protocol !== `${scheme}:`) return false;
  const [host, port] = hostPort.split(":") as [string, string | undefined];
  if (port && port !== "*" && port !== (u.port || (u.protocol === "https:" ? "443" : "80"))) return false;
  if (host === "*") return true;
  if (host.startsWith("*.")) return u.hostname === host.slice(2) || u.hostname.endsWith(host.slice(1));
  return u.hostname === host;
}
