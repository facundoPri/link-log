# Browser: implementación y handoff

Cómo quedó implementado el [plan](browser-feature-plan.md), qué decisiones se tomaron y
qué límites conocidos quedan. Evidencia en [browser-validation.md](browser-validation.md).

## Mapa del monorepo

| Ruta | Qué es |
| --- | --- |
| `package.json` | App + Worker anfitriones; `workspaces: ["apps/*", "packages/*"]`. `bunfig.toml` fija `linker = "hoisted"` para no cambiar el layout de `node_modules` que ya usaba el proyecto. |
| `packages/browser-protocol` | Contrato puro (sin Chrome, Bun ni Cloudflare): tipos de lens (movidos desde `src/types.ts` y reexportados), mensajes versionados del bridge, validadores, claves de caché/target, fingerprint de lens, filtros AND/OR, diff/patch de snapshots, DTOs del API. |
| `apps/extension` | Extensión MV3. `src/background` (registro de pestañas, caché, grupos, hub de snapshots, comandos), `src/bridge` (content script solo en orígenes Linklog), `src/extract` (extractor empaquetado, sin privilegios), `src/pages` (Connect y popup con la estética de Linklog), `scripts/build.ts` (bundles, manifiesto determinista, íconos, watch, zip). |
| `worker/browser.ts` | Rutas `/api/browser/*`, identidad de biblioteca, idempotencia, grupos pineados, Save desde captura, retención. |
| `worker/handlers/browser.ts` | Handler de evaluación de capturas (reusa `judge`, pool Jev, leases, workflow, consumo). |
| `migrations/0010_browser_targets.sql` | Target discriminado de job + tablas de browser. |
| `src/browser/*` | Cliente del bridge, hooks de conexión/snapshot, driver de evaluación, acciones y diálogos. |
| `src/components/browser/*` | Sidebar de grupos/lenses, filas de pestaña, barra de filtros, barra de selección, diálogos. |
| `scripts/ports.ts`, `scripts/dev.ts`, `scripts/chrome.ts` | Puertos configurables, dev sin matar procesos ajenos, launcher con perfil aislado. |
| `tests/browser/` | Entorno aislado + runner de integración con Chromium real. |

## Comandos

| Comando | Qué hace |
| --- | --- |
| `bun run dev` | Igual que antes (build + migraciones locales + Wrangler 8787 + UI 3000). Puertos: `LINKLOG_UI_PORT`, `LINKLOG_API_PORT`. Si un puerto está ocupado, falla con un mensaje; nunca mata el proceso existente. |
| `bun run build` | Build web existente. |
| `bun run extension:build` | Extensión unpacked en `apps/extension/dist` con `manifest.json` generado. Los orígenes del bridge salen de `LINKLOG_ORIGINS` o de los puertos (por defecto `127.0.0.1`/`localhost` en 3000 y 8787). |
| `bun run extension:dev` | Watch. Tras cada rebuild hay que tocar ↻ en `chrome://extensions`; eso reinicia la sesión de la extensión (se pierde la caché de lenses). Recargar la página de Linklog no pierde nada. |
| `bun run extension:package` | `apps/extension/linklog-extension-<versión>.zip` sólo con `dist` (se niega a empaquetar builds de test). |
| `bun run extension:chrome` | Abre Chromium de Playwright / Chrome for Testing (`CHROME_PATH` para otro) con perfil `.profiles/chrome-dev` y la extensión cargada; imprime binario, versión, extension ID, orígenes y URL. |
| `bun run build:all` | App + extensión. |
| `bun run typecheck` | `tsc` de la app, del protocolo y de la extensión (tres tsconfig separados). |
| `bun test` | Tests existentes + protocolo, caché/registro/bridge de la extensión y migración 0010. |
| `bun run test:browser` | Integración real (ver abajo). |

### Chrome estable

Chrome estable ignora `--load-extension`. Cargar a mano: `bun run extension:build` →
`chrome://extensions` → Developer mode → **Load unpacked** → `apps/extension/dist`. Al instalar
se abre la página **Connect**, donde se concede (o no) el acceso a contenido.

## Decisiones principales

### Identidad y sincronización
- `installationId` en `storage.local`; `browserSessionId` en `storage.session` (sobrevive a la
  suspensión del worker, cambia al reiniciar Chrome o recargar la extensión).
- `tabInstanceId` se crea en `tabs.onCreated`/primer avistamiento y se liga al `tabId`.
  `onReplaced` transfiere la identidad. Reabrir una URL crea una instancia nueva.
- `documentRevision` sube cuando cambia la URL **sin fragmento** (navegación completa o
  `pushState`). Recargar la misma URL o cambiar sólo el `#hash` no la cambia; por eso una
  actualización del mismo PR no reevalúa sola: hay **Re-evaluate** explícito y la fecha de
  captura se ve en el menú ⋯ de la fila.
- Tras una navegación hay 1,5 s de asentamiento (`SETTLE_MS`) antes de leer el DOM: los cambios
  de título durante la carga no disparan evaluaciones.
- La ventana siempre se resuelve desde la pestaña emisora (`sender.tab`) en cada comando.
- Sincronización: cada ráfaga de eventos agenda una reconciliación (`Hub.flush`) que vuelve a
  consultar `chrome.tabs`/`tabGroups` y envía un **patch** (diff contra lo último enviado a esa
  conexión) con revisión monotónica. La página sólo aplica un patch cuyo `baseRevision` coincide;
  si no, pide snapshot. Al reconectar, volver al foco o despertar el worker se pide snapshot
  completo. Así no se pierden eventos durante el handshake.
- Las páginas de Linklog se excluyen de la lista y de Close. Incógnito queda fuera.

### Caché (`apps/extension/src/background/cache.ts`)
- Clave: `libraryScope / browserSessionId / tabInstanceId~documentRevision~lensId~fingerprint~generation`.
  `libraryScope = local:<libraryId>` (el prefijo `local` es la ranura para una futura cuenta).
- **Versión del lens = fingerprint** de tipo, pregunta, opciones, niveles y criterios. El umbral
  no participa: cambiarlo re-agrupa sin reevaluar. Las lentes de biblioteca mantienen su contrato
  numérico `version` para All links.
- Estados `missing/submitting/queued/running/done/failed/unavailable/expired`; nada de eso es "No".
- `claim` (bajo un mutex del service worker) marca `submitting` y **guarda el request ID antes del
  POST**. Dos páginas que activan a la vez nunca reclaman la misma pestaña.
- `deposit` descarta respuestas si la pestaña cerró, navegó, se limpió (generación) o fue
  reclamada de nuevo: una respuesta tardía no resucita nada.
- Capturas en caché aparte (`cap:`) con presupuesto LRU de 3 MB; una captura sirve a varios
  lenses de la misma revisión. Los resultados nunca se desalojan en silencio: si no caben, el
  error de cuota se muestra.
- Límite aceptado: `storage.session` se pierde al reiniciar Chrome o recargar/actualizar la
  extensión.

### Flujo de evaluación (`src/browser/useLensRunner.ts`)
1. Con un lens activo, la página pide `claim` (todas las pestañas elegibles de la ventana; filtros y
   selección no cambian el alcance). La extensión captura el DOM y limita cada request a 20
   pestañas y ~1,6 M caracteres.
2. La página hace `POST /api/browser/evaluations` (same-origin, sin CORS). 201 → `accepted`.
3. Un sondeo de `pending` consulta `GET /api/browser/evaluations/:requestId`, deposita resultados
   en la extensión y confirma con `/ack` (el backend purga el payload).
4. Respuesta perdida: el request sigue `submitting`; el sondeo lo encuentra por request ID. Si el
   backend nunca lo recibió (404 tras 15 s), se re-captura y se reenvía **con el mismo ID**.
5. API caído: banner, resultados guardados visibles, nada se vacía; al volver se reconcilia.

### Backend
- `jobs.link_id` pasa a ser nullable con `target_id → browser_targets` y
  `CHECK(exactamente uno)`. La migración reconstruye antes `usage_events` y `provider_leases`
  (hijos de `jobs`): hacer `DROP TABLE jobs` con ellos presentes dispararía `ON DELETE SET NULL`
  / `CASCADE` y perdería consumo y leases.
- `browser_requests` es el recibo de idempotencia: se inserta en la misma transacción D1 que el
  batch, los targets y los jobs. Misma clave + mismo hash de payload → mismo trabajo; hash
  distinto → 409. Las capturas se escriben en R2 después del recibo (un duplicado no puede
  pisarlas) y se borran al terminar el job.
- Se reutilizan cola, outbox/recovery, workflow con ID = job, pool Jev de 16 leases, `measured`
  (consumo en Activity/Usage) y `judge`. La ruta nunca hace fetch de las URLs recibidas.
- Un timeout de TypeSafe se reporta como "puede haberse cobrado; reintentá explícitamente".
  No hay reintento automático.
- `DELETE /api/browser/evaluations/:id` cancela jobs aún en cola (Clean/cierre); una llamada ya
  enviada queda registrada.
- Retención (`BROWSER_RESULT_TTL_DAYS`, 7 por defecto): snapshots borrados al terminar o por el
  cron; resultados no confirmados expiran a los 7 días (`expired`, reevaluación explícita);
  al confirmar se purga el payload y queda el recibo + `usage_events`. Datos internos de
  Workflows siguen la retención de Cloudflare; no se promete borrado inmediato de backups/logs.
- `lenses.scope` (`library`/`browser`): una lente de browser no aparece en All links y no puede
  usarse en batches de links guardados.
- Hechos deterministas: el extractor reconoce, p. ej., el estado de un PR/issue de GitHub
  ("Merged") y lo muestra como badge y lo manda como evidencia a Jev. No reemplaza preguntas.
- Proveedor `fixture` para tests: requiere `JEV_PROVIDER="fixture"` **y** `ALLOW_FIXTURE_JEV="1"`;
  no está en la extensión ni en el zip.

### Grupos
- Descripción y binding pineado viven en `storage.session` de la extensión por `groupId`
  nativo; cerrar el grupo los descarta.
- Definiciones pineadas en D1 (`browser_groups`), sin unicidad de nombre. Mover pestañas a un
  destino pineado sin instancia crea el grupo en la ventana actual y lo vincula; si ya hay binding
  en la ventana se reutiliza. Nunca se fusiona por nombre.
- Editar un pineado actualiza la definición compartida (descripción; nombre/color sólo para
  destinos futuros). Unpin borra la definición y los bindings; los grupos reales siguen.
- Autogroup: sólo pestañas seleccionadas **sin grupo**, Pick one sobre hasta 10 destinos (+ "Don't
  group"), revisión y corrección antes de aplicar, `moveToGroup(onlyIfUngrouped)` revalida en la
  extensión y conserva las que se agruparon mientras corría Jev. Se compara la versión del
  catálogo y se avisa si cambió.

### Permisos
- Obligatorios: `tabs`, `tabGroups`, `storage`, `scripting` y los orígenes de Linklog (bridge).
- Opcionales: `http://*/*`, `https://*/*`, pedidos desde Connect (gesto del usuario). El acceso se
  evalúa por origen, así que también respeta permisos por sitio que otorgue Chrome.
- Sin history, cookies, debugger, nativeMessaging ni `externally_connectable`.
- Estados honestos: *Loading*, *No access*, *Can't read* (chrome://, extensiones, store, PDF),
  *Not loaded* (descartada), *Frozen*. Nunca se activa, recarga ni desplaza una pestaña para leerla.
  Para esas pestañas existe la opción explícita **Use title** (sólo título y URL, marcada como tal).

### Contenido, previews e inspector
- **Extractor** (`apps/extension/src/extract`): copia saneada del DOM visible (sin scripts, formularios,
  inputs, contenteditable ni nodos ocultos; shadow roots abiertos incluidos; URLs absolutas) →
  **Readability** si la página es un artículo y conserva ≥40 % del texto principal (si no, se usa la
  región `main` sin navegación/footers, para no perder hilos de PR o listas) → **Turndown + GFM**
  (tablas, código con lenguaje, listas, imágenes, links). Todo local; además devuelve `image`,
  `byline`, `lang` y `extractor` (`article`/`page`). Lentes, Autogroup y Save usan este Markdown.
- **Previews** (`previews`): sólo metadatos de la página (descripción, `og:image`, sitio) para las
  filas, leídos localmente en pestañas con acceso; caché en memoria del worker; nunca van al backend.
- **Inspector** (`src/components/browser/BrowserInspector.tsx`): clic en una fila abre el panel
  lateral (mismo ancho redimensionable que All links). Muestra imagen, descripción, grupo, estado de
  guardado, resultados de las lentes activas y las pestañas Content (Preview/Markdown, copiar, volver a
  leer con `capture { fresh: true }`), Links (links del contenido, guardables) y Details.
  ↑/↓ navega, Esc cierra; doble clic va a la pestaña.
- **Filtro por dominio**: mismo popover que All links (varios dominios, OR; chips con ×; Clear).
- Save guarda también la `og:image` como imagen del link.

## Límites conocidos / siguientes pasos
- La caché no sobrevive a reinicio de Chrome ni a recarga de la extensión (acordado).
- La extracción lee el DOM cargado: contenido virtualizado, iframes de otros orígenes y PDFs
  quedan marcados como parciales o no disponibles.
- No se hizo un smoke con Jev real en esta sesión (no hay credenciales en el entorno); ver
  validación.
- La cancelación sólo alcanza jobs aún en cola; una evaluación en curso termina y su resultado
  se descarta localmente si ya no corresponde.
