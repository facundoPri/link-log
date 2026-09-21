export type Tag = {
  id: string;
  name: string;
  description: string;
  threshold: number;
  version: number;
  origin?: "manual" | "auto";
};
export type Evaluation = {
  tag_id: string;
  probability: number;
  threshold: number;
  tag_version: number;
  description: string;
  content_version: number;
  model: string;
  evaluated_at: string;
  batch_id: string;
  chunks: number;
};
export type Link = {
  id: string;
  original_url: string;
  url: string;
  domain: string;
  title: string;
  description: string;
  image: string | null;
  favicon: string | null;
  status: "pending" | "ready" | "failed";
  created_at: string;
  tags: Tag[];
  evaluations: Evaluation[];
  content_key: string | null;
  content_version: number;
  content_source: string | null;
  content_state: "missing" | "queued" | "ready" | "failed";
  content_error: string | null;
  content_updated_at: string | null;
};
export type Job = {
  id: string;
  batch_id: string;
  link_id: string;
  title: string;
  status: "queued" | "running" | "done" | "failed";
  step: string;
  error: string | null;
  result: string | null;
};
export type Batch = {
  id: string;
  kind: "extract" | "autotag" | "query";
  config: string;
  created_at: string;
  total: number;
  done: number;
  failed: number;
  active: number;
};
export type Capabilities = {
  markdown: boolean;
  jev: boolean;
  provider: string;
};
export type Library = {
  links: Link[];
  tags: Tag[];
  batches: Batch[];
  capabilities: Capabilities;
};
export type QueryConfig = {
  type: "noul" | "choice";
  question: string;
  options: Record<string, string>;
  threshold: number;
};
export type UsageEvent = {
  id: string;
  batch_id: string | null;
  link_id: string | null;
  title: string | null;
  provider: string;
  service: string;
  model: string | null;
  operation: string;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  browser_ms: number | null;
  estimated_usd: number | null;
  created_at: string;
  error: string | null;
};
export type Rates = {
  cloudflare_input: number | null;
  cloudflare_output: number | null;
  typesafe_input: number | null;
  typesafe_output: number | null;
  browser_hour: number | null;
};
