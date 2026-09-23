import { youtubeAdapter } from "./youtube";
import { webAdapter } from "./web";
import { youtubePostAdapter, instagramAdapter, xAdapter } from "./social";
import type { ContentAdapter } from "./types";
// Specific adapters precede the web fallback.
const adapters: ContentAdapter[] = [youtubePostAdapter, youtubeAdapter, instagramAdapter, xAdapter, webAdapter];
export function adapterFor(url: string) {
  const adapter = adapters.find((a) => a.matches(url));
  if (!adapter) throw new Error("No adapter for this link.");
  return adapter;
}
