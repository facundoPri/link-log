import { useEffect, useState } from "react";
import { api } from "../api";
import type { Batch, Job, QueryConfig } from "../types";
export function BatchPanel({ batches }: { batches: Batch[] }) {
  const [open, setOpen] = useState(""),
    [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState("");
  const batch = batches.find((b) => b.id === open),
    active = batches.filter((b) => b.active > 0),
    latest = active.length ? active : batches.slice(0, 1);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () =>
      api<{ jobs: Job[] }>(`/batches/${open}`)
        .then((r) => {
          if (alive) {
            setJobs(r.jobs);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(e.message);
        });
    void load();
    const timer = batch?.active ? setInterval(load, 1600) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [open, batch?.active]);
  if (!batches.length) return null;
  return (
    <div className="batch-panel" aria-label="Actividad de procesamiento">
      {latest.map((b) => (
        <button
          className="batch-summary"
          key={b.id}
          onClick={() => {
            setJobs([]);
            setOpen(open === b.id ? "" : b.id);
          }}
        >
          <span className={b.active ? "pulse" : ""} />
          <span>
            {b.kind === "extract"
              ? "Extracción de contexto"
              : b.kind === "autotag"
                ? "Autoetiquetado"
                : "Consulta"}
            <small>
              {b.done + b.failed} de {b.total} ·{" "}
              {b.failed
                ? `${b.failed} necesitan atención`
                : b.active
                  ? "en curso"
                  : "completado"}
            </small>
          </span>
          <progress max={b.total || 1} value={b.done + b.failed} />
          <span>{open === b.id ? "−" : "+"}</span>
        </button>
      ))}
      <details>
        <summary>Historial de lotes</summary>
        <select
          aria-label="Elegir lote"
          value={open}
          onChange={(e) => {
            setJobs([]);
            setOpen(e.target.value);
          }}
        >
          <option value="">Seleccionar</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {new Date(b.created_at).toLocaleString()} · {b.kind} · {b.total}{" "}
              links
            </option>
          ))}
        </select>
      </details>
      {batch && (
        <div className="batch-jobs">
          {error && <p className="error">{error}</p>}
          {jobs.map((j) => {
            const result = j.result ? JSON.parse(j.result) : null,
              answer = result?.answers?.query,
              q = (JSON.parse(batch.config) as { query?: QueryConfig }).query;
            return (
              <div className="batch-job" key={j.id}>
                <span>
                  {j.title}
                  <small>{j.error || j.step}</small>
                </span>
                {answer?.type === "noul" ? (
                  <span className="query-result">
                    {answer.noul >= (q?.threshold ?? 0.8) ? "Sí" : "No"}{" "}
                    <small>{Math.round(answer.noul * 100)}%</small>
                  </span>
                ) : answer?.type === "choice" ? (
                  <details className="query-result">
                    <summary>
                      {q?.options[answer.choice] || answer.choice}
                    </summary>
                    {Object.entries(
                      answer.probabilities as Record<string, number>,
                    ).map(([k, v]) => (
                      <small key={k}>
                        {q?.options[k] || k} · {Math.round(v * 100)}%
                      </small>
                    ))}
                  </details>
                ) : (
                  <span className="status">
                    {j.status === "done"
                      ? "✓"
                      : j.status === "failed"
                        ? "!"
                        : "…"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
