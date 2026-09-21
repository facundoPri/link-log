import { useState } from "react";
import { ArrowUpRight, Link2, LoaderCircle, Trash2 } from "lucide-react";
import { Modal } from "./Modal";
import type { Link, Tag } from "../types";
import { tagColor } from "./LinkRow";
export function LinkForm({
  link,
  tags,
  onClose,
  onSave,
  onDelete,
}: {
  link?: Link;
  tags: Tag[];
  onClose: () => void;
  onSave: (url: string, tags: string[]) => Promise<void>;
  onDelete?: () => Promise<void>;
}) {
  const [url, setUrl] = useState(link?.original_url || "");
  const [selected, setSelected] = useState<string[]>(
    link?.tags.map((t) => t.name) || [],
  );
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const add = () => {
    const name = draft.trim().toLowerCase();
    if (name && !selected.includes(name)) setSelected([...selected, name]);
    setDraft("");
  };
  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      await onSave(url, [
        ...new Set([
          ...selected,
          ...(draft.trim() ? [draft.trim().toLowerCase()] : []),
        ]),
      ]);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={link ? "Editar link" : "Guardar un link"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="form-intro">
          {link
            ? "Un poco de orden, para encontrarlo después."
            : "Pegalo acá. Nosotros nos ocupamos del resto."}
        </p>
        <label htmlFor="url">Link</label>
        <div className="url-field">
          <Link2 size={18} />
          <input
            id="url"
            data-autofocus={!link}
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            readOnly={!!link}
          />
        </div>
        {link && link.url !== link.original_url && (
          <a
            className="resolved"
            href={link.url}
            target="_blank"
            rel="noreferrer"
          >
            Destino: {link.domain}
            <ArrowUpRight size={12} />
          </a>
        )}
        <label htmlFor="tag-input">
          Etiquetas <span>opcional</span>
        </label>
        <div className="tag-input">
          {selected.map((name) => (
            <button
              type="button"
              className={`tag ${tagColor(name)}`}
              key={name}
              onClick={() => setSelected(selected.filter((t) => t !== name))}
              aria-label={`Quitar ${name}`}
            >
              {name} ×
            </button>
          ))}
          <input
            id="tag-input"
            data-autofocus={!!link}
            maxLength={40}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Agregar etiqueta…"
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <div className="suggestions">
          {tags
            .filter((t) => !selected.includes(t.name))
            .map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelected([...selected, t.name])}
              >
                + {t.name}
                {link?.evaluations.find((e) => e.tag_id === t.id) ? (
                  <small className="tag-score">
                    {" "}
                    {Math.round(
                      link.evaluations.find((e) => e.tag_id === t.id)!
                        .probability * 100,
                    )}
                    %
                  </small>
                ) : null}
              </button>
            ))}
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer className="modal-footer">
          {onDelete ? (
            <button
              type="button"
              className="danger ghost"
              disabled={busy}
              onClick={async () => {
                if (!confirm) {
                  setConfirm(true);
                  return;
                }
                setBusy(true);
                try {
                  await onDelete();
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              <Trash2 size={15} />
              {confirm ? "Confirmar eliminación" : "Eliminar"}
            </button>
          ) : (
            <span className="form-hint">
              El preview se completa después de guardar.
            </span>
          )}
          <button className="primary" disabled={busy || !url.trim()}>
            {busy ? <LoaderCircle size={16} className="spin" /> : null}
            {link ? "Guardar cambios" : "Guardar link"}
            <kbd>↵</kbd>
          </button>
        </footer>
      </form>
    </Modal>
  );
}
