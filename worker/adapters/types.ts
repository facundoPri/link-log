export type Extraction = { markdown: string; source: string };
export type ExtractionJob = { id: string; batch_id: string; link_id: string };
export interface ContentAdapter {
  matches: (url: string) => boolean;
  extract: (env: Env, url: string, job: ExtractionJob) => Promise<Extraction>;
}
