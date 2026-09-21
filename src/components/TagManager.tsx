import { useState } from "react";
import { Check, Trash2 } from "lucide-react";
import type { Tag } from "../types";
import { Modal } from "./Modal";
export function TagManager({
  tags,
  onClose,
  onChange,
}: {
  tags: Tag[];
  onClose: () => void;
  onChange: (path: string, method: string, body?: unknown) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  async function change(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    try {
      await onChange(path, method, body);
      setName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Tus etiquetas" onClose={onClose}>
      <p className="form-intro">
        La descripción orienta a Jev. El umbral y la descripción nuevos se usan
        en los próximos autotags; no modifican resultados anteriores.
      </p>
      <div className="manage-tags">
        {tags.map((t) => (
          <form
            className="manage-tag"
            key={`${t.id}-${t.version}`}
            onSubmit={(e) => {
              e.preventDefault();
              void change(`/tags/${t.id}`, "PATCH", {
                name: new FormData(e.currentTarget).get("name"),
                description: new FormData(e.currentTarget).get("description"),
                threshold:
                  Number(new FormData(e.currentTarget).get("threshold")) / 100,
              });
            }}
          >
            <input
              aria-label={`Nombre de ${t.name}`}
              name="name"
              defaultValue={t.name}
              maxLength={40}
              required
            />
            <button
              className="icon-button"
              disabled={busy}
              aria-label={`Guardar nombre de ${t.name}`}
            >
              <Check size={17} />
            </button>
            <button
              type="button"
              className={`icon-button ${confirm === t.id ? "danger" : ""}`}
              disabled={busy}
              aria-label={
                confirm === t.id
                  ? `Confirmar eliminar ${t.name}`
                  : `Eliminar ${t.name}`
              }
              onClick={() => {
                if (confirm !== t.id) {
                  setConfirm(t.id);
                  return;
                }
                void change(`/tags/${t.id}`, "DELETE", {});
              }}
            >
              {confirm === t.id ? <Check size={17} /> : <Trash2 size={16} />}
            </button>
            <label className="tag-description">
              Descripción para Jev
              <textarea
                name="description"
                defaultValue={t.description}
                maxLength={2000}
                placeholder="Qué contenido pertenece a esta etiqueta; ejemplos y exclusiones…"
              />
            </label>
            <label className="tag-threshold">
              Umbral para asignar{" "}
              <input
                name="threshold"
                type="number"
                min="0"
                max="100"
                step="1"
                defaultValue={Math.round(t.threshold * 100)}
                required
              />{" "}
              %
            </label>
          </form>
        ))}
      </div>
      <form
        className="new-tag"
        onSubmit={(e) => {
          e.preventDefault();
          void change("/tags", "POST", { name });
        }}
      >
        <input
          data-autofocus="true"
          placeholder="Nueva etiqueta"
          aria-label="Nueva etiqueta"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" disabled={busy || !name.trim()}>
          Crear
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
