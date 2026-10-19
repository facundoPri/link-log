import type { WorkflowStep } from "cloudflare:workers";
import type { Lens, Link, Tag } from "../../src/types";
import type { JobRow } from "../jobs";
import { extractHandler, previewHandler } from "./extract";
import { classifyHandler } from "./classify";
import { browserEvaluationHandler } from "./browser";

export type Pool = "browser" | "jev";
export type JobConfig = {
  tags?: Tag[];
  lens?: Lens;
  track?: string;
  /** extract: "content" retries only the content step (the preview already ran). */
  step?: "content";
  /** browser-autogroup: Jev option key → destination key chosen by the page. */
  destinations?: Record<string, string>;
};
export type JobContext = {
  env: Env;
  step: WorkflowStep;
  /** user_id is resolved from the persisted batch by loadOwnedJob. */
  job: JobRow & { kind: string; config: string; user_id: string };
  link: Link;
  config: JobConfig;
  /** How the steps that ran ended, for the failure path to settle Needs attention. */
  progress: { preview?: "ok" | "failed" };
};
export type JobHandler = {
  pool: (ctx: JobContext) => Pool | null;
  run: (ctx: JobContext) => Promise<void>;
};
/** A browser capture target: an ephemeral snapshot, never a row in `links`. */
export type BrowserTargetRow = {
  id: string;
  request_id: string;
  target_key: string;
  url: string;
  title: string;
  capture_key: string | null;
  capture_meta: string;
};
export type BrowserJobContext = Omit<JobContext, "link" | "progress"> & {
  target: BrowserTargetRow;
};
export type BrowserJobHandler = {
  pool: (ctx: BrowserJobContext) => Pool | null;
  run: (ctx: BrowserJobContext) => Promise<void>;
};
export const handlers: Record<string, JobHandler> = {
  extract: extractHandler,
  preview: previewHandler,
  autotag: classifyHandler,
  lens: classifyHandler,
  // Legacy "query" batches may still be delivered by the queue; run them through
  // the same classify path — their config carries a QueryConfig, not a Lens.
  query: classifyHandler,
};
export const browserHandlers: Record<string, BrowserJobHandler> = {
  "browser-lens": browserEvaluationHandler,
  "browser-autogroup": browserEvaluationHandler,
};
