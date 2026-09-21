import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "../api";
import type { UsageEvent, Rates } from "../types";
export function UsagePanel({ onClose }: { onClose: () => void }) {
  const [events, setEvents] = useState<UsageEvent[]>([]),
    [rates, setRates] = useState<Rates | null>(null),
    [service, setService] = useState(""),
    [filter, setFilter] = useState(""),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    api<{ events: UsageEvent[]; rates: Rates }>("/usage")
      .then((r) => {
        setEvents(r.events);
        setRates(r.rates);
      })
      .catch((e) => setError(e.message));
  }, []);
  const filtered = events.filter(
    (e) =>
      (!service || e.service === service) &&
      (!filter ||
        [e.batch_id, e.link_id, e.title].some((v) =>
          v?.toLowerCase().includes(filter.toLowerCase()),
        )),
  );
  const total = filtered.reduce((s, e) => s + (e.estimated_usd ?? 0), 0),
    unknown = filtered.filter((e) => e.estimated_usd === null).length;
  const labels: Record<keyof Rates, string> = {
    cloudflare_input: "Jev en Cloudflare · entrada / millón de tokens",
    cloudflare_output: "Jev en Cloudflare · salida / millón de tokens",
    typesafe_input: "TypeSafe · entrada / millón de tokens",
    typesafe_output: "TypeSafe · salida / millón de tokens",
    browser_hour: "Browser Rendering · hora de navegador",
  };
  return (
    <Modal title="Uso y costos" onClose={onClose}>
      <p className="form-intro">
        Estimaciones en USD, no una factura. Cada llamada conserva la tarifa
        vigente. Los consumos desconocidos nunca se cuentan como cero.
      </p>
      <div className="usage-total">
        ${total.toFixed(6)}{" "}
        <small>
          con tarifa conocida · {unknown} llamadas sin costo calculable
        </small>
      </div>
      <div className="panel-actions">
        <select
          aria-label="Servicio"
          value={service}
          onChange={(e) => setService(e.target.value)}
        >
          <option value="">Todos los servicios</option>
          <option value="jev">Jev</option>
          <option value="browser-markdown">Markdown</option>
        </select>
        <input
          placeholder="Link, ID de link o lote…"
          aria-label="Filtrar uso"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="usage-events">
        {filtered.map((e) => (
          <details key={e.id}>
            <summary>
              <span>
                {e.title || e.link_id || "Link eliminado"}
                <small>
                  {e.provider} · {e.service} · {e.status}
                </small>
              </span>
              <span>
                {e.estimated_usd === null
                  ? "Sin tarifa / consumo"
                  : `$${e.estimated_usd.toFixed(6)}`}
              </span>
            </summary>
            <p className="form-hint">
              {e.model || e.service} · {e.input_tokens ?? "—"} tokens de entrada
              · {e.output_tokens ?? "—"} de salida · {e.browser_ms ?? "—"} ms de
              navegador
            </p>
            <p className="form-hint">
              Lote: {e.batch_id} · Link: {e.link_id}
            </p>
            {e.error && <p className="error">{e.error}</p>}
          </details>
        ))}
        {!filtered.length && (
          <p className="form-intro">Todavía no hay llamadas registradas.</p>
        )}
      </div>
      <details className="rates">
        <summary>Configurar tarifas para próximas llamadas</summary>
        <p className="form-hint">
          Copiá las tarifas de tu proveedor. Dejar vacío significa desconocida.
          El costo de navegador no incluye concurrencia, mínimos ni descuentos.
        </p>
        {rates && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/rates", "PUT", rates);
                setSaved(true);
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {Object.entries(labels).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={rates[key as keyof Rates] ?? ""}
                  onChange={(e) => {
                    setSaved(false);
                    setRates({
                      ...rates,
                      [key]:
                        e.target.value === "" ? null : Number(e.target.value),
                    });
                  }}
                />
              </label>
            ))}
            <button className="primary">Guardar tarifas</button>
            {saved && <p role="status">Tarifas guardadas.</p>}
          </form>
        )}
      </details>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="form-hint">
        Se muestran las últimas 1.000 llamadas. OCR aún no está habilitado.
      </p>
    </Modal>
  );
}
