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
export async function measured<T>(
  env: Env,
  job: { id: string; batch_id: string; link_id: string | null },
  service: string,
  provider: string,
  operation: string,
  fn: (meter: Meter) => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID(),
    started = Date.now(),
    meter: Meter = {};
  await env.DB.prepare(
    "INSERT INTO usage_events(id,batch_id,job_id,link_id,provider,service,operation,status,rate_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      job.batch_id,
      job.id,
      job.link_id,
      provider,
      service,
      operation,
      "started",
      service === "image-ocr" ? JSON.stringify({ input_usd_per_million: GEMMA_USD_PER_M_INPUT, output_usd_per_million: GEMMA_USD_PER_M_OUTPUT }) : "{}",
      new Date().toISOString(),
    )
    .run();
  let error: string | null = null;
  try {
    return await fn(meter);
  } catch (e) {
    error = e instanceof Error ? e.message : "Provider failed";
    throw e;
  } finally {
    const cost = priceUsage({
      provider,
      input_tokens: meter.input_tokens ?? null,
      output_tokens: meter.output_tokens ?? null,
      model: meter.model ?? null,
    });
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
  }
}
