import type { WorkflowStep } from "cloudflare:workers";
import type { Lens, Link, Tag } from "../../src/types";
import type { JobRow } from "../jobs";
import { extractHandler } from "./extract";
import { classifyHandler } from "./classify";

export type Pool = "browser" | "jev";
export type JobContext = {
  env: Env;
  step: WorkflowStep;
  /** user_id is resolved from the persisted batch by loadOwnedJob. */
  job: JobRow & { kind: string; config: string; user_id: string };
  link: Link;
  config: { tags?: Tag[]; lens?: Lens; track?: string };
};
export type JobHandler = {
  pool: (ctx: JobContext) => Pool | null;
  run: (ctx: JobContext) => Promise<void>;
};
export const handlers: Record<string, JobHandler> = {
  extract: extractHandler,
  autotag: classifyHandler,
  lens: classifyHandler,
  // Legacy "query" batches may still be delivered by the queue; run them through
  // the same classify path — their config carries a QueryConfig, not a Lens.
  query: classifyHandler,
};
