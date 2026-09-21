import { useState } from "react";
import {
  ArrowUpRight,
  Link2,
  MoreHorizontal,
  RefreshCw,
  Tag as TagIcon,
} from "lucide-react";
import type { Link } from "../types";
export function tagColor(name: string) {
  return ["sage", "rose", "blue", "amber"][
    [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 4
  ];
}
export function LinkRow({
  link,
  onEdit,
  onTag,
  onRetry,
  checked,
  onSelect,
  onContent,
}: {
  link: Link;
  onEdit: () => void;
  onTag: (id: string) => void;
  onRetry: () => void;
  checked: boolean;
  onSelect: () => void;
  onContent: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [faviconFailed, setFaviconFailed] = useState(false);
  return (
    <article className={`link-row ${checked ? "is-selected" : ""}`}>
      <input
        className="link-checkbox"
        type="checkbox"
        aria-label={`Seleccionar ${link.title}`}
        checked={checked}
        onChange={onSelect}
      />
      <a
        className="thumbnail"
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        tabIndex={-1}
        aria-hidden="true"
      >
        {link.image && !failed ? (
          <img
            src={link.image}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className={`thumbnail-fallback ${tagColor(link.domain)}`}>
            <Link2 size={25} />
            <span>{link.domain.split(".")[0]}</span>
          </div>
        )}
      </a>
      <div className="link-body">
        <a
          className="link-title"
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {link.title}
          <ArrowUpRight size={15} />
        </a>
        <p className="description">
          {link.description ||
            (link.status === "pending"
              ? "Obteniendo el título y la vista previa…"
              : new URL(link.url).pathname === "/"
                ? "Guardado para volver cuando quieras."
                : new URL(link.url).pathname)}
        </p>
        <div className="metadata">
          <span className="domain">
            {link.favicon && !faviconFailed ? (
              <img
                alt=""
                src={link.favicon}
                referrerPolicy="no-referrer"
                onError={() => setFaviconFailed(true)}
              />
            ) : (
              <Link2 size={13} />
            )}{" "}
            {link.domain}
          </span>
          {link.tags.map((tag) => (
            <button
              key={tag.id}
              className={`tag ${tagColor(tag.name)}`}
              title={`${tag.origin === "auto" ? "Automática" : "Manual"}${link.evaluations.find((e) => e.tag_id === tag.id) ? ` · ${Math.round(link.evaluations.find((e) => e.tag_id === tag.id)!.probability * 100)}%` : ""}`}
              onClick={() => onTag(tag.id)}
            >
              {tag.name}
            </button>
          ))}
          {!link.tags.length && (
            <button className="add-tag" onClick={onEdit}>
              <TagIcon size={12} /> Etiquetar
            </button>
          )}
          <button className="content-button" onClick={onContent}>
            {link.content_state === "queued"
              ? "Obteniendo contexto…"
              : link.content_key
                ? "Ver contexto"
                : link.content_state === "failed"
                  ? "Revisar contexto"
                  : "Agregar contexto"}
          </button>
          {link.status === "pending" && (
            <span className="status">
              <span className="pulse" /> Completando
            </span>
          )}
          {link.status === "failed" && (
            <button
              className="retry"
              onClick={onRetry}
              title="El link está guardado. Reintentar vista previa"
            >
              <RefreshCw size={12} /> Sin vista previa
            </button>
          )}
        </div>
      </div>
      <button
        className="icon-button row-menu"
        aria-label={`Editar ${link.title}`}
        onClick={onEdit}
      >
        <MoreHorizontal size={20} />
      </button>
    </article>
  );
}
