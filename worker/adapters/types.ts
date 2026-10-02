import type { ContentDetails, MediaItem } from "../../src/types";
export type Discovered = {
  source: string;
  text: string;
  title: string;
  media: Omit<MediaItem, "ocr_state" | "ocr_text" | "ocr_error" | "ocr_model">[];
  details: ContentDetails;
};
export type Extraction = { markdown: string; source: string };
export type ExtractionJob = { id: string; batch_id: string; link_id: string };
/** `name` identifies the adapter in telemetry. */
export type ContentAdapter = { name: string; matches: (url: string) => boolean } & (
  | { extract: (env: Env, url: string, job: ExtractionJob, signal?: AbortSignal) => Promise<Extraction>; discover?: never }
  | { discover: (env: Env, url: string, job: ExtractionJob, track?: string) => Promise<Discovered>; extract?: never }
);
