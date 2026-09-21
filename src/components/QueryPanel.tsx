import { useState } from "react";
import { Modal } from "./Modal";
import type { QueryConfig } from "../types";
export function QueryPanel({
  count,
  onClose,
  onRun,
}: {
  count: number;
  onClose: () => void;
  onRun: (q: QueryConfig) => Promise<void>;
}) {
  const [type, setType] = useState<"noul" | "choice">("noul"),
    [question, setQuestion] = useState(""),
    [options, setOptions] = useState(""),
    [threshold, setThreshold] = useState(80),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal title="Preguntale a tus links" onClose={onClose}>
      <p className="form-intro">
        Una clasificación para {count} links seleccionados. Los resultados no
        cambian sus etiquetas.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const values = options
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            if (type === "choice" && (values.length < 2 || values.length > 11))
              throw new Error("Escribí entre 2 y 11 opciones.");
            await onRun({
              type,
              question,
              threshold: threshold / 100,
              options:
                type === "choice"
                  ? {
                      ...Object.fromEntries(
                        values.map((v, i) => [`option_${i}`, v]),
                      ),
                      other: "Otro / ninguna de las anteriores",
                    }
                  : {},
            });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="query-mode">Tipo de respuesta</label>
        <select
          id="query-mode"
          value={type}
          onChange={(e) => setType(e.target.value as "noul" | "choice")}
        >
          <option value="noul">Sí / No · Noul</option>
          <option value="choice">Una de varias opciones · Choice</option>
        </select>
        <label htmlFor="semantic-question">Pregunta</label>
        <textarea
          id="semantic-question"
          data-autofocus="true"
          value={question}
          required
          maxLength={2000}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="¿Habla de usar AI para crear soluciones IoT?"
        />
        {type === "choice" ? (
          <>
            <label htmlFor="query-options">Opciones · una por línea</label>
            <textarea
              id="query-options"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              placeholder={"AI\nSoluciones Cloud\nArquitecturas IoT"}
            />
            <p className="form-hint">
              Incluimos «Otro» para los links que no encajen.
            </p>
          </>
        ) : (
          <>
            <label htmlFor="query-threshold">Umbral para «Sí»</label>
            <input
              id="query-threshold"
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />{" "}
            %
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-footer">
          <span className="form-hint">
            Sólo se analiza el contexto guardado.
          </span>
          <button className="primary" disabled={busy || !question.trim()}>
            Clasificar {count} links
          </button>
        </footer>
      </form>
    </Modal>
  );
}
