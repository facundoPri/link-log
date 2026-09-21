import type { Rates } from "../src/types";
export const emptyRates: Rates = {
  cloudflare_input: null,
  cloudflare_output: null,
  typesafe_input: null,
  typesafe_output: null,
  browser_hour: null,
};
export async function getRates(env: Env): Promise<Rates> {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='rates'",
  ).first<{ value: string }>();
  return { ...emptyRates, ...(row ? JSON.parse(row.value) : {}) };
}
export type Meter = {
  input_tokens?: number;
  output_tokens?: number;
  browser_ms?: number;
  model?: string;
};
export async function measured<T>(
  env: Env,
  job: { id: string; batch_id: string; link_id: string },
  service: string,
  provider: string,
  operation: string,
  fn: (meter: Meter) => Promise<T>,
): Promise<T> {
  const id = crypto.randomUUID(),
    started = Date.now(),
    rates = await getRates(env),
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
      JSON.stringify(rates),
      new Date().toISOString(),
    )
    .run();
  let error: string | null = null;
  try {
    return await fn(meter);
  } catch (e) {
    error = e instanceof Error ? e.message : "Falló el proveedor";
    throw e;
  } finally {
    let cost: number | null = null;
    if (meter.browser_ms !== undefined && rates.browser_hour !== null)
      cost = (meter.browser_ms / 3600000) * rates.browser_hour;
    const input =
        provider === "typesafe" ? rates.typesafe_input : rates.cloudflare_input,
      output =
        provider === "typesafe"
          ? rates.typesafe_output
          : rates.cloudflare_output;
    if (
      meter.input_tokens !== undefined &&
      meter.output_tokens !== undefined &&
      input !== null &&
      output !== null
    )
      cost = (meter.input_tokens * input + meter.output_tokens * output) / 1e6;
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
