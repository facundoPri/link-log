import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import { Modal } from "./Modal";
import { api } from "../api";
import type { Link, Tag } from "../types";
export function ContextPanel({
  link,
  tags,
  onClose,
  onChange,
}: {
  link: Link;
  tags: Tag[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [markdown, setMarkdown] = useState(""),
    [draft, setDraft] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<{ markdown: string }>(`/links/${link.id}/content`)
      .then((r) => {
        if (active) {
          setMarkdown(r.markdown);
          setDraft(r.markdown);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [link.id, link.content_version]);
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChange();
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Contenido del link" onClose={onClose}>
      <p className="context-title">{link.title}</p>
      <p className="form-intro">
        {link.content_source === "youtube"
          ? "Transcripción de YouTube"
          : link.content_source === "manual"
            ? "Contenido manual"
            : "Página en Markdown"}{" "}
        · {link.domain}
      </p>
      <div className="panel-actions">
        <button
          className="ghost"
          disabled={busy || link.content_state === "queued"}
          onClick={() =>
            void action(() =>
              api("/batches", "POST", { kind: "extract", ids: [link.id] }),
            )
          }
        >
          {link.content_state === "queued" ? "Extrayendo…" : "Volver a extraer"}
        </button>
        <button className="ghost" onClick={() => setEditing(!editing)}>
          {editing ? "Ver contenido" : "Cargar / editar texto"}
        </button>
      </div>
      {(error || link.content_error) && (
        <p role="alert" className="error">
          {error || link.content_error}
        </p>
      )}
      {editing ? (
        <div>
          <label htmlFor="manual-content">
            Texto, Markdown o transcripción
          </label>
          <textarea
            id="manual-content"
            className="content-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={500000}
          />
          <label className="file-label">
            Abrir archivo
            <input
              type="file"
              accept=".txt,.md,.srt,.vtt"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 2000000) {
                  setError("El archivo supera 2 MB.");
                  return;
                }
                setDraft(await file.text());
              }}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !draft.trim()}
            onClick={() =>
              void action(() =>
                api(`/links/${link.id}/content`, "PUT", { markdown: draft }),
              )
            }
          >
            Guardar contenido
          </button>
        </div>
      ) : (
        <div className="markdown-content">
          {markdown ? (
            <Markdown
              components={{
                img: ({ alt }) => (
                  <span className="image-placeholder">
                    Imagen: {alt || "sin descripción"}
                  </span>
                ),
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")}
            </Markdown>
          ) : (
            <p className="form-intro">
              {link.content_state === "queued"
                ? "Estamos obteniendo el contexto…"
                : "Todavía no hay contenido. Podés reintentar o cargarlo manualmente."}
            </p>
          )}
        </div>
      )}
      {!!link.evaluations.length && (
        <details className="scores">
          <summary>Scores de etiquetas · última evaluación</summary>
          <p className="form-intro">
            El porcentaje es la probabilidad de «sí». Cada evaluación conserva
            la descripción y el umbral usados en ese momento.
          </p>
          {[...tags]
            .sort(
              (a, b) =>
                (link.evaluations.find((e) => e.tag_id === b.id)?.probability ??
                  -1) -
                (link.evaluations.find((e) => e.tag_id === a.id)?.probability ??
                  -1),
            )
            .map((tag) => {
              const score = link.evaluations.find((e) => e.tag_id === tag.id),
                assigned = link.tags.find((t) => t.id === tag.id);
              return (
                <div
                  className="score-row"
                  key={tag.id}
                  title={
                    score
                      ? `${score.description} · ${score.model} · ${score.evaluated_at}`
                      : undefined
                  }
                >
                  <div>
                    <strong>{tag.name}</strong>
                    <small>
                      {assigned
                        ? assigned.origin === "auto"
                          ? "Automática"
                          : "Manual"
                        : "Sin asignar"}
                      {score &&
                      (score.tag_version !== tag.version ||
                        score.content_version !== link.content_version)
                        ? " · definición o contenido modificado"
                        : ""}
                    </small>
                  </div>
                  <div>
                    {score ? (
                      <>
                        <span>{Math.round(score.probability * 100)}%</span>
                        <small>
                          umbral {Math.round(score.threshold * 100)}%
                          {score.threshold !== tag.threshold
                            ? ` → actual ${Math.round(tag.threshold * 100)}%`
                            : ""}
                        </small>
                        <span className="score-track">
                          <i style={{ width: `${score.probability * 100}%` }} />
                        </span>
                      </>
                    ) : (
                      <small>Sin evaluar</small>
                    )}
                  </div>
                </div>
              );
            })}
        </details>
      )}
    </Modal>
  );
}
