/** Linklog origins besides local http (any port); configured at build time. */
export const LINKLOG_ORIGINS: readonly string[] =
  typeof __LINKLOG_ORIGINS__ === "undefined" ? [] : __LINKLOG_ORIGINS__;
/** Where "Open Linklog" goes when no Linklog tab is open. */
export const LINKLOG_URL: string =
  typeof __LINKLOG_URL__ === "undefined" ? "http://127.0.0.1:3000" : __LINKLOG_URL__;
export const EXTENSION_VERSION: string =
  typeof __EXTENSION_VERSION__ === "undefined" ? "0.0.0" : __EXTENSION_VERSION__;
/** Broad content access requested explicitly from the connect page. */
export const CONTENT_ORIGINS = ["http://*/*", "https://*/*"];
