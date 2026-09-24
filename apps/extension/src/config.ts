export const LINKLOG_ORIGINS: readonly string[] =
  typeof __LINKLOG_ORIGINS__ === "undefined" ? [] : __LINKLOG_ORIGINS__;
export const EXTENSION_VERSION: string =
  typeof __EXTENSION_VERSION__ === "undefined" ? "0.0.0" : __EXTENSION_VERSION__;
/** Broad content access requested explicitly from the connect page. */
export const CONTENT_ORIGINS = ["http://*/*", "https://*/*"];
