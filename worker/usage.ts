export const TYPESAFE_USD_PER_M_INPUT = 0.042;
export const GEMMA_USD_PER_M_INPUT = 0.10;
export const GEMMA_USD_PER_M_OUTPUT = 0.30;
export const OCR_USAGE_COLUMNS = "sum(service='image-ocr') ocr_images,sum(CASE WHEN service='image-ocr' THEN input_tokens ELSE 0 END) ocr_input_tokens,sum(CASE WHEN service='image-ocr' THEN output_tokens ELSE 0 END) ocr_output_tokens,max(CASE WHEN service='image-ocr' THEN model END) ocr_model,sum(CASE WHEN service='image-ocr' THEN estimated_usd END) ocr_usd,sum(service='image-ocr' AND estimated_usd IS NULL) ocr_unknown_cost_calls";
export function priceUsage(u: {
  provider: string;
  input_tokens: number | null;
  output_tokens?: number | null;
  model?: string | null;
}): number | null {
  if (u.provider === "cloudflare" && u.model === "@cf/google/gemma-4-26b-a4b-it")
    return u.input_tokens !== null && u.output_tokens != null
      ? (u.input_tokens * GEMMA_USD_PER_M_INPUT + u.output_tokens * GEMMA_USD_PER_M_OUTPUT) / 1e6
      : null;
  return u.provider === "typesafe" && u.input_tokens !== null
    ? (u.input_tokens * TYPESAFE_USD_PER_M_INPUT) / 1e6
    : null;
}
export type Meter = {
  input_tokens?: number;
  output_tokens?: number;
  browser_ms?: number;
  model?: string;
};
type UsageJob = { id: string; batch_id: string; link_id: string | null };
const USAGE_COLUMNS = "id,batch_id,job_id,link_id,provider,service,operation,status,rate_snapshot,created_at";
const usageValues = (id: string, job: UsageJob, provider: string, service: string, operation: string) => [
  id, job.batch_id, job.id, job.link_id, provider, service, operation, "started",
  service === "image-ocr" ? JSON.stringify({ input_usd_per_million: GEMMA_USD_PER_M_INPUT, output_usd_per_million: GEMMA_USD_PER_M_OUTPUT }) : "{}",
  new Date().toISOString(),
];
/** The usage row of a call, inserted only when `guard` (SQL with its own params) holds. */
export const guardedUsageInsert = (env: Env, id: string, job: UsageJob, provider: string, service: string, operation: string, guard: string, params: unknown[]) =>
  env.DB.prepare(`INSERT INTO usage_events(${USAGE_COLUMNS}) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}`)
    .bind(...usageValues(id, job, provider, service, operation), ...params);
/**
 * Settles a usage row. It never throws: the call's own outcome matters more than its metering, and a failed
 * write is logged (recovery marks a row left 'started' as interrupted).
 */
export async function finishUsage(env: Env, id: string, started: number, provider: string, meter: Meter, error: string | null) {
  const cost = priceUsage({
    provider,
    input_tokens: meter.input_tokens ?? null,
    output_tokens: meter.output_tokens ?? null,
    model: meter.model ?? null,
  });
  try {
    await env.DB.prepare(
      "UPDATE usage_events SET status=?,model=?,input_tokens=?,output_tokens=?,browser_ms=?,estimated_usd=?,duration_ms=?,error=? WHERE id=?",
    )
      .bind(
        error ? "failed" : "done",
        meter.model ?? null,
        meter.input_tokens ?? null,
        meter.output_tokens ?? null,
        meter.browser_ms ?? null,
        cost,
        Date.now() - started,
        error,
        id,
      )
      .run();
  } catch (e) {
    console.error(JSON.stringify({ event: "usage_finalize_failed", usage_id: id, provider, status: error ? "failed" : "done", input_tokens: meter.input_tokens ?? null, output_tokens: meter.output_tokens ?? null, detail: e instanceof Error ? e.message.slice(0, 300) : String(e) }));
  }
}
export async function measured<T>(
  env: Env,
  job: UsageJob,
  service: string,
  provider: string,
  operation: string,
  fn: (meter: Meter) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const id = crypto.randomUUID(),
    started = Date.now(),
    meter: Meter = {};
  await env.DB.prepare(`INSERT INTO usage_events(${USAGE_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(...usageValues(id, job, provider, service, operation))
    .run();
  let error: string | null = null;
  try {
    const result = await fn(meter);
    // An attempt abandoned at its time budget stays failed even if the provider answers later.
    if (signal?.aborted) throw new Error("The attempt timed out before the provider answered.");
    return result;
  } catch (e) {
    error = e instanceof Error ? e.message : "Provider failed";
    throw e;
  } finally {
    await finishUsage(env, id, started, provider, meter, error);
  }
}
