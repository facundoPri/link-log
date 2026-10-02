# Browser: implementación y handoff

Cómo quedó implementado el [plan](browser-feature-plan.md), qué decisiones se tomaron y
qué límites conocidos quedan. Evidencia en [browser-validation.md](browser-validation.md).

## Mapa del monorepo

| Ruta | Qué es |
| --- | --- |
| `package.json` | App + Worker anfitriones; `workspaces: ["apps/*", "packages/*"]`. `bunfig.toml` fija `linker = "hoisted"` para no cambiar el layout de `node_modules` que ya usaba el proyecto. |
| `packages/browser-protocol` | Contrato puro (sin Chrome, Bun ni Cloudflare): tipos de lens (movidos desde `src/types.ts` y reexportados), mensajes versionados del bridge, validadores, claves de caché/target, fingerprint de lens, filtros AND/OR, diff/patch de snapshots, DTOs del API. |
| `apps/extension` | Extensión MV3. `src/background` (registro de pestañas, caché, grupos, hub de snapshots, comandos), `src/bridge` (content script en `localhost`/`127.0.0.1` de cualquier puerto + orígenes configurados; sólo se activa si la página se identifica como Linklog), `src/extract` (extractor empaquetado, sin privilegios), `src/pages` (Connect y popup con la estética de Linklog), `scripts/build.ts` (bundles, manifiesto determinista, íconos, watch, zip). |
| `worker/browser.ts` | Rutas `/api/browser/*`, identidad de biblioteca, idempotencia, grupos pineados, Save (URLs por el pipeline normal), retención. |
| `worker/links.ts` | `addLink`: alta de un link compartida por All links (`POST /api/links`) y Save desde Browser. |
| `worker/handlers/browser.ts` | Handler de evaluación de capturas (reusa `judge`, pool Jev, leases, workflow, consumo). |
| `migrations/0010_browser_targets.sql` | Target discriminado de job + tablas de browser. |
| `migrations/0011_jobs_target_index.sql` | Índice `jobs(target_id)`. |
| `src/browser/*` | Cliente del bridge, hooks de conexión/snapshot, driver de evaluación (`useLensRunner`, `claimRounds`), acciones (`useBrowserActions`, sin JSX). |
| `src/components/browser/*` | Sidebar de grupos/lenses, filas de pestaña, estado de lens compartido (`BrowserLensStatus`), barra de filtros, barra de selección, inspector (`BrowserInspector` + `BrowserTabContent`), pantalla de conexión (`BrowserConnect`) y diálogos (`BrowserDialogs`). |
| `src/components/DomainFilter.tsx`, `MarkdownView.tsx` | Filtro de dominios y render de Markdown compartidos por All links y Browser. |
| `scripts/ports.ts`, `scripts/dev.ts`, `scripts/chrome.ts` | Puertos configurables, dev sin matar procesos ajenos, launcher con perfil aislado. |
| `tests/browser/` | Entorno aislado + runner de integración con Chromium real. |

## Comandos

| Comando | Qué hace |
| --- | --- |
| `bun run dev` | Igual que antes (build + migraciones locales + Wrangler 8787 + UI 3000). Puertos: `LINKLOG_UI_PORT`, `LINKLOG_API_PORT`. Si un puerto está ocupado, falla con un mensaje; nunca mata el proceso existente. |
| `bun run build` | Build web existente. |
| `bun run extension:build` | Extensión unpacked en `apps/extension/dist` con `manifest.json` generado. El bridge cubre `http://localhost` y `http://127.0.0.1` en **cualquier puerto**; `LINKLOG_ORIGINS` agrega otros orígenes (p. ej. uno desplegado). `LINKLOG_UI_PORT` sólo decide adónde va "Open Linklog". |
| `bun run extension:dev` | Watch. Tras cada rebuild hay que tocar ↻ en `chrome://extensions`; eso reinicia la sesión de la extensión (se pierde la caché de lenses). Recargar la página de Linklog no pierde nada. |
| `bun run extension:package` | `apps/extension/linklog-extension-<versión>.zip` sólo con `dist` (se niega a empaquetar builds de test). |
| `bun run extension:chrome` | Abre Chromium de Playwright / Chrome for Testing (`CHROME_PATH` para otro) con perfil `.profiles/chrome-dev` y la extensión cargada; imprime binario, versión, extension ID, orígenes y URL. |
| `bun run build:all` | App + extensión. |
| `bun run typecheck` | `tsc` de la app, del protocolo y de la extensión (tres tsconfig separados). |
| `bun test` | Tests existentes + protocolo (batching por bytes, validación), caché/registro/grupos/comandos de la extensión (con un `chrome` falso), rutas de browser y migración 0010. `tests/setup.ts` stubbea `cloudflare:workers`. |
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
- La ventana siempre se resuelve desde la pestaña emisora (`sender.tab`) en cada comando, y
  ningún comando salvo `hello` se acepta antes de un `hello` exitoso en esa conexión.
- **Detección de Linklog (sin pairing ni token).** El content script del bridge se inyecta en
  `http://localhost/*` y `http://127.0.0.1/*` (cualquier puerto) y en `LINKLOG_ORIGINS`, pero queda
  inerte (sin listener, sin marcador, sin conexión) salvo que la página tenga
  `<meta name="linklog-app">`, que renderiza `src/index.html`. El background vuelve a validar
  emisor: esta extensión, frame principal, documento activo, origen permitido y URL de la pestaña
  del mismo origen (`isBridgeSender`). Una pestaña con bridge conectado — o de un origen donde
  Linklog ya se conectó en esta sesión — es "Linklog": no se lista, no se lee y no se cierra.
  Los patrones del bridge nunca cuentan como acceso a contenido (se filtran de los permisos).
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
  reclamada de nuevo: una respuesta tardía no resucita nada. Sólo escribe y anuncia
  (`results-changed`) cambios reales de estado/respuesta/error/job: un sondeo que ve "sigue en
  cola" no dispara nada. `accepted`/`release`/`deposit` sólo tocan requests del `libraryScope`
  de la conexión.
- Capturas en caché aparte (`cap:`) con presupuesto LRU de 3 MB; una captura sirve a varios
  lenses de la misma revisión. Los resultados nunca se desalojan en silencio: si no caben, el
  error de cuota se muestra.
- Límite aceptado: `storage.session` se pierde al reiniciar Chrome o recargar/actualizar la
  extensión.

### Flujo de evaluación (`src/browser/useLensRunner.ts`)
1. Con un lens activo, la página pide `claim` (todas las pestañas elegibles de la ventana; filtros y
   selección no cambian el alcance). La extensión captura el DOM y limita cada request a 20
   pestañas y a **1,8 MB en bytes UTF-8** del JSON exacto que la página va a enviar
   (`toEvaluationTarget` + `jsonBytes`, compartidos en el protocolo); el resto queda para la
   siguiente ronda. El costo de Jev ya está acotado por pestaña (una llamada, contenido recortado a
   160 000 caracteres); este límite es sólo de transporte (cuerpo máximo del Worker, 2,1 MB).
   **Re-evaluate** re-ejecuta todas las pestañas indicadas (la ventana o la selección) y cada una
   **una sola vez por clic**: cada ronda pide sólo las que ninguna ronda anterior intentó
   (`attempted`, `claimRounds`). La activación/auto-completado sólo toma las que faltan.
2. La página hace `POST /api/browser/evaluations` (same-origin, sin CORS). 201 → `accepted`.
3. Un sondeo de `pending` consulta `GET /api/browser/evaluations/:requestId`, deposita resultados
   en la extensión y confirma con `/ack` (el backend purga el payload de los targets respondidos).
   Es un único loop auto-programado (1,5 s con trabajo pendiente, 5 s sin) con guarda de
   reentrada; los eventos de resultados no lo reinician.
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
- `DELETE /api/browser/evaluations/:id` con `targetKeys` cancela sólo esos jobs aún en cola
  (Clean manda exactamente los targets limpiados); una llamada ya enviada queda registrada.
- Si R2 falla al guardar un snapshot después del recibo, esos targets quedan `failed` ("The page
  snapshot could not be stored. Evaluate the tab again.") sin despachar el job: ni request
  huérfano ni llamada a Jev.
- `createEvaluation` rechaza lentes con `scope !== "browser"` (`lens-scope`).
- `GET /api/browser/catalog` ya no escribe en D1 (el `library_id` se crea una vez y luego se lee).
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
- **Tras reiniciar Chrome o recargar la extensión** `storage.session` se vacía pero Chrome puede
  restaurar los grupos. Por eso el aspecto de cada grupo vinculado (título, color, descripción)
  se guarda también en `storage.local`, y durante los 2 minutos siguientes a una sesión nueva se
  re-vincula un grupo restaurado sólo si es inequívoco: mismo `groupId` (recarga de la extensión)
  o mismo título + color de **una única** definición, sin más candidatos que grupos vinculados
  antes. Lo ambiguo queda sin vincular (nunca se fusiona por nombre). Es best effort: si Chrome
  emite el cierre de los grupos al salir, la pista se pierde y el grupo queda local.
- Definiciones pineadas en D1 (`browser_groups`), sin unicidad de nombre. Mover pestañas a un
  destino pineado sin instancia crea el grupo en la ventana actual y lo vincula; si ya hay binding
  en la ventana se reutiliza. Nunca se fusiona por nombre.
- Editar un pineado actualiza la definición compartida (descripción; nombre/color sólo para
  destinos futuros). Unpin borra la definición y los bindings; los grupos reales siguen.
- Autogroup: sólo pestañas seleccionadas **sin grupo**, Pick one sobre hasta 10 destinos (+ "Don't
  group"), revisión y corrección antes de aplicar, `moveToGroup(onlyIfUngrouped)` revalida en la
  extensión y conserva las que se agruparon mientras corría Jev. Se compara la versión del
  catálogo y se avisa si cambió. La corrida arranca en el clic (no en un efecto del diálogo), así
  que corre una sola vez por acción aun con StrictMode; con más de 100 pestañas o más de 1,8 MB se
  parte en varios requests (una entrada de Activity por request) y las sugerencias se unen en la
  misma revisión.

### Permisos
- Obligatorios: `tabs`, `tabGroups`, `storage`, `scripting` y los orígenes de Linklog (bridge).
- Opcionales: `http://*/*`, `https://*/*`, pedidos desde Connect (gesto del usuario). El acceso se
  evalúa por origen, así que también respeta permisos por sitio que otorgue Chrome.
- El bridge no necesita `host_permissions` (sólo el `matches` de su content script).
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
  `byline`, `lang` y `extractor` (`article`/`page`). Lentes, Autogroup y el inspector usan este
  Markdown. Toda captura que se empareja con la URL de una pestaña se verifica: si la pestaña
  navegó entre el snapshot y la lectura (revisión o `documentKey` distintos) falla con "The tab
  navigated…" en vez de mezclar la URL de una página con el contenido de otra.
- **Previews** (`previews`): sólo metadatos de la página (descripción, `og:image`, sitio) para las
  filas, leídos localmente con una función inline (sin inyectar el extractor) en **todas las
  pestañas con acceso**; las imágenes se cargan desde el servidor de cada sitio. Se piden en tandas
  de 100 y sólo se marcan como vacías las que se intentaron. Caché en memoria del worker; nunca van
  al backend.
- **Inspector** (`src/components/browser/BrowserInspector.tsx`): clic en una fila abre el panel
  lateral (mismo ancho redimensionable que All links). Muestra imagen, descripción, grupo, estado de
  guardado, resultados de las lentes activas y las pestañas Content (Preview/Markdown, copiar, volver a
  leer con `capture { fresh: true }`), Links (links del contenido, guardables) y Details. Una
  lectura vieja que termina tarde se ignora. "First seen" es cuándo la extensión vio la pestaña
  por primera vez (se reinicia con Chrome o la extensión), no cuándo se abrió.
  ↑/↓ navega, Esc cierra; doble clic va a la pestaña.
- **Filtro por dominio**: mismo popover que All links (varios dominios, OR; chips con ×; Clear).
- **Save** = agregar el link en All links: la página manda sólo URLs (`POST /api/browser/save`,
  en tandas de ≤100 y ≤1,8 MB) y el Worker usa el mismo `addLink` que `POST /api/links`
  (normalización, reglas de URL y dedupe) y encola **un** batch `extract` por request, como un
  import: metadata, contenido y autotag del pipeline normal. Nada leído localmente pasa a ser
  contenido de la biblioteca. Los duplicados se reportan y no se tocan; la insignia "Saved" sale
  de la biblioteca. URLs de más de 4096 caracteres se rechazan en el cliente.
- Estados que no son respuesta: "Unreadable" (fila y barra de lentes usan el mismo término y la
  misma cuenta) muestra el motivo y ofrece **Use title**; "Retry N failed" reintenta exactamente
  las fallidas/expiradas que cuenta.

## Límites conocidos / siguientes pasos
- **Riesgo aceptado del bridge sin pairing** (decisión explícita): el marcador
  `<meta name="linklog-app">` identifica, no autentica. Cualquier página servida en
  `localhost`/`127.0.0.1` que lo incluya obtiene el bridge y, tras `hello`, puede listar las
  pestañas de su ventana, leerlas (si se concedió acceso a contenido) y cerrarlas/agruparlas. Los
  sitios remotos no pueden; los comandos siguen limitados a la ventana de la pestaña emisora. Si
  corrés herramientas locales no confiables, la mitigación sería un pairing/token (descartado por
  ahora) o compilar con `LINKLOG_ORIGINS` y restringir los `matches` a esos orígenes.
- La caché no sobrevive a reinicio de Chrome ni a recarga de la extensión (acordado).
- La extracción lee el DOM cargado de la página principal: el contenido de iframes no se lee (ni se
  avisa, porque casi siempre son marcos técnicos invisibles); contenido virtualizado queda fuera y
  los PDFs se marcan como no disponibles.
- No se hizo un smoke con Jev real en esta sesión (no hay credenciales en el entorno); ver
  validación.
- La cancelación sólo alcanza jobs aún en cola; una evaluación en curso termina y su resultado
  se descarta localmente si ya no corresponde.
