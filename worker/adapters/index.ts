import { youtubeAdapter } from "./youtube";
import { webAdapter } from "./web";
import type { ContentAdapter, ExtractionJob } from "./types";
// Specific adapters precede the web fallback. Each produces the same durable Markdown contract.
const adapters: ContentAdapter[] = [youtubeAdapter, webAdapter];
export async function extract(env: Env, url: string, job: ExtractionJob) {
  const adapter = adapters.find((a) => a.matches(url));
  if (!adapter) throw new Error("No hay adaptador para este link.");
  return adapter.extract(env, url, job);
}
