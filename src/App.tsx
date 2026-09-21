import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  BookOpen,
  Check,
  Command,
  Inbox,
  Link2,
  LoaderCircle,
  Plus,
  Search,
  SlidersHorizontal,
  Tag,
  Upload,
  X,
} from "lucide-react";
import { api } from "./api";
import type { Library, Link } from "./types";
import { pastedUrls } from "./url";
import { LinkRow, tagColor } from "./components/LinkRow";
import { LinkForm } from "./components/LinkForm";
import { TagManager } from "./components/TagManager";
import { ContextPanel } from "./components/ContextPanel";
import { QueryPanel } from "./components/QueryPanel";
import { BatchPanel } from "./components/BatchPanel";
import { UsagePanel } from "./components/UsagePanel";
import type { QueryConfig } from "./types";
import "./index.css";
export function App() {
  const [library, setLibrary] = useState<Library>({
    links: [],
    tags: [],
    batches: [],
    capabilities: { markdown: false, jev: false, provider: "typesafe" },
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [contextId, setContextId] = useState("");
  const [showQuery, setShowQuery] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [onlyContext, setOnlyContext] = useState(false);
  const [running, setRunning] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [untagged, setUntagged] = useState(false);
  const [ascending, setAscending] = useState(false);
  const [modal, setModal] = useState<"add" | "tags" | Link | null>(null);
  const [toast, setToast] = useState("");
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(0);
  const dragDepth = useRef(0);
  const search = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    try {
      setLibrary(await api());
      setLoaded(true);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (
      !library.links.some((l) => l.status === "pending") &&
      !library.batches.some((b) => b.active)
    )
      return;
    const id = setInterval(() => void refresh(), 1800);
    return () => clearInterval(id);
  }, [library.links, library.batches, refresh]);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(id);
  }, [toast]);
  const save = useCallback(async (url: string, tags: string[] = []) => {
    setSaving((n) => n + 1);
    try {
      const data = await api("/links", "POST", { url, tags });
      setLibrary(data);
      setLoaded(true);
      setToast(
        data.duplicate
          ? "Ese link ya estaba guardado."
          : "Link guardado. Ya podés seguir.",
      );
    } finally {
      setSaving((n) => n - 1);
    }
  }, []);
  const capture = useCallback(
    (text: string) => {
      const urls = pastedUrls(text);
      if (!urls.length) {
        setError(
          "Pegá links http o https, separados por espacios o saltos de línea.",
        );
        return;
      }
      void (async () => {
        setSaving((n) => n + 1);
        let done = 0;
        try {
          for (let offset = 0; offset < urls.length; offset += 100) {
            const data = await api<
              Library & { imported: number; duplicates: number }
            >("/import", "POST", { urls: urls.slice(offset, offset + 100) });
            setLibrary(data);
            done += data.imported;
          }
          setToast(
            `${done} links nuevos guardados. El contexto se obtiene en segundo plano.`,
          );
        } catch (e) {
          setError(`${done} links guardados. ${(e as Error).message}`);
        } finally {
          setSaving((n) => n - 1);
        }
      })();
    },
    [save],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setModal("add");
      }
      if (e.key === "/" && !isInput(e.target) && !modal) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    const paste = (e: ClipboardEvent) => {
      if (isInput(e.target) || modal || contextId || showQuery || showUsage)
        return;
      const text = e.clipboardData?.getData("text/plain") || "";
      if (pastedUrls(text).length) {
        e.preventDefault();
        capture(text);
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("paste", paste);
    };
  }, [modal, contextId, showQuery, showUsage, capture]);
  useEffect(() => {
    setSelected((current) =>
      current.filter((id) => library.tags.some((tag) => tag.id === id)),
    );
  }, [library.tags]);
  const filtered = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return library.links
      .filter(
        (l) =>
          (!domain || l.domain === domain) &&
          (!onlyContext || !!l.content_key) &&
          (!untagged || !l.tags.length) &&
          selected.every((id) => l.tags.some((t) => t.id === id)) &&
          words.every((word) =>
            [
              l.title,
              l.description,
              l.domain,
              l.url,
              l.original_url,
              ...l.tags.map((t) => t.name),
            ]
              .join(" ")
              .toLocaleLowerCase()
              .includes(word),
          ),
      )
      .sort((a, b) =>
        ascending
          ? a.created_at.localeCompare(b.created_at)
          : b.created_at.localeCompare(a.created_at),
      );
  }, [
    library.links,
    query,
    domain,
    untagged,
    selected,
    ascending,
    onlyContext,
  ]);
  const domains = [...new Set(library.links.map((l) => l.domain))].sort(
    (a, b) =>
      library.links.filter((l) => l.domain === b).length -
      library.links.filter((l) => l.domain === a).length,
  );
  const toggleTag = (id: string) => {
    setUntagged(false);
    setSelected((current) =>
      current.includes(id) ? current.filter((t) => t !== id) : [...current, id],
    );
  };
  const clear = () => {
    setOnlyContext(false);
    setQuery("");
    setDomain("");
    setSelected([]);
    setUntagged(false);
  };
  async function mutate(path: string, method: string, body: unknown = {}) {
    setLibrary(await api(path, method, body));
  }
  async function runBatch(
    kind: "autotag" | "extract" | "query",
    query?: QueryConfig,
  ) {
    setRunning(true);
    setError("");
    try {
      for (let offset = 0; offset < picked.length; offset += 100)
        await api("/batches", "POST", {
          kind,
          ids: picked.slice(offset, offset + 100),
          query,
        });
      await refresh();
      setPicked([]);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setRunning(false);
    }
  }
  const selectedLinks = library.links.filter((l) => picked.includes(l.id));
  const hasContext =
    selectedLinks.length > 0 &&
    selectedLinks.every((l) => !!l.content_key && l.content_state !== "queued");
  const contextLink = library.links.find((l) => l.id === contextId);
  const isFiltered = !!(
    query ||
    domain ||
    selected.length ||
    untagged ||
    onlyContext
  );
  return (
    <div
      className="app"
      onDragEnter={(e) => {
        if (
          e.dataTransfer.types.some((t) =>
            ["text/uri-list", "text/plain"].includes(t),
          )
        ) {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.some((t) =>
            ["text/uri-list", "text/plain"].includes(t),
          )
        ) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        const text =
          e.dataTransfer
            .getData("text/uri-list")
            .split("\n")
            .find((l) => l && !l.startsWith("#")) ||
          e.dataTransfer.getData("text/plain");
        if (text) capture(text);
      }}
    >
      <aside className="sidebar">
        <a href="/" className="brand">
          <Link2 size={27} strokeWidth={2.4} />
          <span>
            Linklog<span className="brand-dot">.</span>
          </span>
        </a>
        <nav aria-label="Biblioteca">
          <button
            className={`nav-item ${!untagged && !selected.length ? "active" : ""}`}
            onClick={clear}
          >
            <Inbox size={18} />
            <span>Todos los links</span>
            <span className="count">{library.links.length}</span>
          </button>
          <button
            className={`nav-item ${untagged ? "active" : ""}`}
            onClick={() => {
              setSelected([]);
              setUntagged(true);
            }}
          >
            <Tag size={18} />
            <span>Sin etiquetas</span>
            <span className="count">
              {library.links.filter((l) => !l.tags.length).length}
            </span>
          </button>
        </nav>
        <div className="sidebar-divider" />
        <div className="tag-heading">
          <span>ETIQUETAS</span>
          <button
            className="icon-button"
            aria-label="Administrar etiquetas"
            onClick={() => setModal("tags")}
          >
            <Plus size={17} />
          </button>
        </div>
        <div className="tag-nav">
          {library.tags.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${selected.includes(t.id) ? "active" : ""}`}
              onClick={() => toggleTag(t.id)}
            >
              <span className={`dot ${tagColor(t.name)}`} />
              <span>{t.name}</span>
              <span className="count">
                {
                  library.links.filter((l) =>
                    l.tags.some((tag) => tag.id === t.id),
                  ).length
                }
              </span>
            </button>
          ))}
          {!library.tags.length && (
            <button className="empty-tags" onClick={() => setModal("tags")}>
              Tus temas, a tu manera.
              <br />
              <span>
                Creá tu primera etiqueta <Plus size={12} />
              </span>
            </button>
          )}
        </div>
        <div className="sidebar-bottom">
          <BookOpen size={18} />
          <span>
            Biblioteca personal
            <small>Datos locales · extracción en Cloudflare</small>
          </span>
        </div>
      </aside>
      <main>
        <div className="content">
          <header className="page-header">
            <div>
              <h1>{untagged ? "Sin etiquetas" : "Tu biblioteca"}</h1>
              <p>Un lugar para lo que querés volver a encontrar.</p>
            </div>
            <button
              aria-label="Agregar link"
              className="primary add-button"
              onClick={() => setModal("add")}
            >
              <Plus size={17} />
              <span>Agregar link</span>
              <kbd>⌘ K</kbd>
            </button>
          </header>
          <div className="search-field">
            <Search size={19} />
            <input
              ref={search}
              aria-label="Buscar links"
              placeholder="Buscar por título, dominio o etiqueta…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query ? (
              <button
                className="icon-button"
                aria-label="Limpiar búsqueda"
                onClick={() => setQuery("")}
              >
                <X size={15} />
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </div>
          <div className="filters">
            <button
              className={`filter ${!domain ? "selected" : ""}`}
              onClick={() => setDomain("")}
            >
              Todos
            </button>
            {domains.slice(0, 4).map((d) => (
              <button
                key={d}
                className={`filter ${domain === d ? "selected" : ""}`}
                onClick={() => setDomain(domain === d ? "" : d)}
              >
                {d}
              </button>
            ))}
            {domains.length > 4 && (
              <select
                aria-label="Otros dominios"
                value={domains.slice(4).includes(domain) ? domain : ""}
                onChange={(e) => setDomain(e.target.value)}
              >
                <option value="">Otros dominios</option>
                {domains.slice(4).map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            )}
            <button
              className="mobile-tags ghost"
              onClick={() => setModal("tags")}
            >
              <SlidersHorizontal size={16} /> Etiquetas
            </button>
          </div>
          {!!selected.length && (
            <div className="active-tags">
              {selected.map((id) => {
                const t = library.tags.find((t) => t.id === id);
                return t ? (
                  <button
                    className={`tag ${tagColor(t.name)}`}
                    key={id}
                    onClick={() => toggleTag(id)}
                  >
                    {t.name}
                    <X size={11} />
                  </button>
                ) : null;
              })}
              <span>Coinciden todas las etiquetas</span>
            </div>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button className="ghost" onClick={() => void refresh()}>
                Reintentar
              </button>
              <button
                className="icon-button"
                aria-label="Cerrar error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="context-filters">
            <label>
              <input
                type="checkbox"
                checked={onlyContext}
                onChange={(e) => setOnlyContext(e.target.checked)}
              />{" "}
              Con contexto
            </label>
            <button className="ghost" onClick={() => setShowUsage(true)}>
              Uso y costos
            </button>
          </div>
          <BatchPanel batches={library.batches} />
          {!!picked.length && (
            <div className="selection-bar">
              <span>{picked.length} seleccionados</span>
              <button
                className="primary"
                disabled={running || !hasContext || !library.tags.length}
                title="Reemplaza todas las etiquetas de los links seleccionados si la evaluación termina correctamente"
                onClick={() => void runBatch("autotag").catch(() => {})}
              >
                Autoetiquetar
              </button>
              <button
                className="ghost"
                disabled={running || !hasContext}
                onClick={() => setShowQuery(true)}
              >
                Consultar
              </button>
              <button
                className="ghost"
                disabled={running}
                onClick={() => void runBatch("extract").catch(() => {})}
              >
                Extraer contexto
              </button>
              <button
                className="icon-button"
                aria-label="Limpiar selección"
                onClick={() => setPicked([])}
              >
                <X size={16} />
              </button>
              <small>
                {hasContext
                  ? "Autotag reemplaza todas las etiquetas, incluidas las manuales."
                  : "Para clasificar, todos los links deben tener contexto y haber terminado de procesarse."}
              </small>
            </div>
          )}
          <div className="list-toolbar">
            <span>
              <input
                type="checkbox"
                aria-label="Seleccionar links filtrados"
                checked={
                  filtered.length > 0 &&
                  filtered.every((l) => picked.includes(l.id))
                }
                onChange={(e) =>
                  setPicked(e.target.checked ? filtered.map((l) => l.id) : [])
                }
              />{" "}
              {!loaded
                ? "Tu biblioteca"
                : `${filtered.length} ${filtered.length === 1 ? "link" : "links"}`}
              {isFiltered && (
                <button className="clear-filters" onClick={clear}>
                  Limpiar filtros
                </button>
              )}
            </span>
            <button
              className="sort-button"
              onClick={() => setAscending(!ascending)}
            >
              {ascending ? "Más antiguos" : "Más recientes"}
              <ArrowDown size={13} className={ascending ? "rotate" : ""} />
            </button>
          </div>
          <section className="link-list" aria-label="Links guardados">
            {!loaded && !error ? (
              <div className="loading">
                <LoaderCircle className="spin" size={22} /> Cargando tu
                biblioteca…
              </div>
            ) : (
              filtered.map((link) => (
                <LinkRow
                  key={`${link.id}-${link.image}`}
                  link={link}
                  checked={picked.includes(link.id)}
                  onSelect={() =>
                    setPicked((current) =>
                      current.includes(link.id)
                        ? current.filter((id) => id !== link.id)
                        : [...current, link.id],
                    )
                  }
                  onContent={() => setContextId(link.id)}
                  onTag={toggleTag}
                  onEdit={() => setModal(link)}
                  onRetry={() =>
                    void mutate(`/links/${link.id}/retry`, "POST").catch((e) =>
                      setError(e.message),
                    )
                  }
                />
              ))
            )}
            {loaded && !filtered.length && (
              <div className="empty-state">
                <div className="empty-icon">
                  {isFiltered ? <Search size={30} /> : <Link2 size={32} />}
                </div>
                <h2>
                  {isFiltered
                    ? "No encontramos esos links"
                    : "Lo encontraste. Guardalo acá."}
                </h2>
                <p>
                  {isFiltered
                    ? "Probá con otro título, dominio o etiqueta."
                    : "Ese artículo, ese video, esa idea. Un link ahora, una buena referencia después."}
                </p>
                <button
                  className="primary"
                  onClick={() => (isFiltered ? clear() : setModal("add"))}
                >
                  {isFiltered ? (
                    "Limpiar filtros"
                  ) : (
                    <>
                      <Plus size={16} /> Guardar mi primer link
                    </>
                  )}
                </button>
                {!isFiltered && (
                  <span className="empty-shortcut">
                    O simplemente pegá un link con <kbd>⌘ V</kbd>
                  </span>
                )}
              </div>
            )}
          </section>
          <button className="drop-zone" onClick={() => setModal("add")}>
            <Link2 size={21} />
            <span>Arrastrá un link o pegá una lista de URLs</span>
            <kbd>⌘ V</kbd>
          </button>
          <footer className="page-footer">
            <span>Menos pestañas abiertas. Más ideas a mano.</span>
            <button className="ghost" onClick={() => setModal("add")}>
              <Command size={12} /> K para guardar
            </button>
          </footer>
        </div>
      </main>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Upload size={40} />
            <h2>Soltalo. Ya lo guardamos.</h2>
            <p>El título y la vista previa llegan después.</p>
          </div>
        </div>
      )}
      {(toast || saving > 0) && (
        <div className="toast" role="status">
          {saving > 0 ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <Check size={17} />
          )}
          <span>{saving > 0 ? "Guardando link…" : toast}</span>
        </div>
      )}
      {contextLink && (
        <ContextPanel
          link={contextLink}
          tags={library.tags}
          onClose={() => setContextId("")}
          onChange={refresh}
        />
      )}
      {showQuery && (
        <QueryPanel
          count={picked.length}
          onClose={() => setShowQuery(false)}
          onRun={(q) => runBatch("query", q)}
        />
      )}
      {showUsage && <UsagePanel onClose={() => setShowUsage(false)} />}
      {modal === "add" && (
        <LinkForm
          tags={library.tags}
          onClose={() => setModal(null)}
          onSave={save}
        />
      )}
      {modal === "tags" && (
        <TagManager
          tags={library.tags}
          onClose={() => setModal(null)}
          onChange={mutate}
        />
      )}
      {modal && typeof modal === "object" && (
        <LinkForm
          link={library.links.find((l) => l.id === modal.id) || modal}
          tags={library.tags}
          onClose={() => setModal(null)}
          onSave={async (_url, tags) => {
            await mutate(`/links/${modal.id}`, "PATCH", { tags });
            setToast("Etiquetas actualizadas.");
          }}
          onDelete={async () => {
            await mutate(`/links/${modal.id}`, "DELETE");
            setToast("Link eliminado.");
          }}
        />
      )}
    </div>
  );
}
function isInput(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    !!target.closest('input,textarea,select,[contenteditable="true"]')
  );
}
