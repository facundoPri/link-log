import { useCallback, useMemo } from "react";
import type { BrowserTab } from "@linklog/browser-protocol";
import type { Library, Link } from "../types";
import { normalizeUrl } from "../url";

/** Finds the library link a tab's URL was saved as (same normalization as saving). */
export function useSavedLookup(library: Library) {
  const byUrl = useMemo(() => {
    const map = new Map<string, Link>();
    for (const l of library.links) {
      map.set(l.original_url, l);
      map.set(l.url, l);
    }
    return map;
  }, [library.links]);
  return useCallback(
    (tab: BrowserTab) => {
      try {
        return byUrl.get(normalizeUrl(tab.url));
      } catch {
        return undefined;
      }
    },
    [byUrl],
  );
}
