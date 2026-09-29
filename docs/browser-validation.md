# Browser: validación

Evidencia de la entrega del [plan](browser-feature-plan.md) ·
[implementación](browser-implementation-handoff.md).

## Entorno

| | |
| --- | --- |
| Navegador | Chromium 141.0.7390.37 (Playwright, `/opt/pw-browsers/chromium`), headless nuevo, perfiles aislados en `.cache/browser-test/profile-*` |
| Extensión | Linklog 0.1.0, MV3. ID de la build de test: `ahholiofnhckbdnahdbncdmcehflobaf` (`.cache/browser-test/extension`); ID de `apps/extension/dist`: `glkilbcpbncckcbnbcpnejjibfghcehd` (Chrome lo deriva de la ruta) |
| Manifest de test | el de `bun run extension:build` **sin `LINKLOG_ORIGINS`** (el bridge encuentra Linklog en el puerto 3010 por sí solo) + hosts de fixtures (`http://127.0.0.1:3099/*`, `https://github.com/*`) concedidos al instalar. Esa variante no se puede empaquetar. Ver `run.json` → `meta.manifest` |
| Backend | Wrangler local con config propia (`.cache/browser-test/wrangler.jsonc`), D1/R2 nuevos por corrida, UI 3010 / API 8790, **sin bindings remotos**; una app local "marcada" en 3098 para el bridge |
| Jev | proveedor `fixture` (determinista, sin costo; requiere `JEV_PROVIDER=fixture` + `ALLOW_FIXTURE_JEV=1`) |

## Comandos ejecutados

```sh
bun install                 # workspaces, linker hoisted (sin cambio de layout)
bun run typecheck           # app + packages/browser-protocol + apps/extension: OK
bun test                    # 102 tests en 17 archivos: OK
bun run build               # OK
bun run extension:build     # OK, manifest generado
bun run extension:package   # apps/extension/linklog-extension-0.1.0.zip, 13 archivos (sólo dist)
bun run build:all           # OK
bun run extension:chrome    # imprime binario, versión, perfil, extension ID, orígenes y URL
bun run test:browser        # integración real (abajo)
```

Baseline antes de empezar: `typecheck` OK, `bun test` 45/45, `build` OK.

## Integración con Chromium real (`bun run test:browser`)

Última corrida: **44/44 checks pasan** en ~4 minutos —
[`browser-validation/run.md`](browser-validation/run.md) (detalle en `run.json`, 160 llamadas
del proveedor fixture en total). Cada fila es un check automatizado contra la extensión cargada; los
contadores de llamadas son del proveedor **fixture** (prueban la deduplicación del flujo, no
facturación real).

| Matriz del plan | Cómo se verificó | Capturas |
| --- | --- | --- |
| Dos ventanas, sin fuga de alcance | 20 pestañas en la ventana de Linklog y 3 en otra; sólo se listan las 20 | [02](browser-validation/02-lens-active.png) |
| Sin extensión | perfil sin extensión → pasos de conexión y reintento | [01](browser-validation/01-no-extension.png) |
| 20 + 3, toggle, B apagado, filtros | 20 llamadas; toggle off/on = 0; 3 nuevas = 3; B inactivo = 0; con filtro "Yes" una pestaña "No" nueva igual se evalúa | [03](browser-validation/03-filter-no.png) |
| AND entre lenses, OR dentro, inversos | Yes∧Article ⊂ Yes∧(Article∨Reference) ⊂ Yes∧(cualquiera) = 12; filtro "No" | [04](browser-validation/04-two-lenses-filters.png) |
| Clasificar no guarda | 0 links antes y después de 48 evaluaciones | |
| Cerrar/reabrir Linklog | resultados vuelven, 0 llamadas | |
| Suspensión real del service worker | `Target.closeTarget` del worker; un marcador en memoria prueba que reinició; `browserSessionId` igual; 0 llamadas | |
| API caído | rutas `/api` abortadas: banner, resultados visibles; al volver se reconcilia por request ID | [05](browser-validation/05-api-offline.png) |
| Respuesta perdida tras POST aceptado | 2 respuestas descartadas después de llegar al backend → mismo job, 2 batches, 2 llamadas | |
| Redelivery / recovery / sondeo | 4 barridos de recuperación durante jobs lentos → sin llamadas extra; se cuentan los `GET /api/browser/evaluations/:id` de la página: < 4 por segundo (antes del arreglo, un bucle sin pausa) | |
| Misma URL reabierta | nuevo `tabInstanceId`, se evalúa de nuevo | |
| Navegación / SPA / hash | hash: 0 llamadas; `pushState`: reevalúa; navegación completa: reevalúa | |
| Editar lens | umbral: 0 llamadas; pregunta: una por pestaña | |
| Re-evaluate | "Re-evaluate this window": exactamente una llamada por pestaña legible, aunque haga varias rondas de 20 | |
| Clean | 0 resultados, lens apagada, definición intacta, 0 llamadas | |
| Fallo de Jev | *Failed* con Retry, sin reintento automático; Retry = 1 llamada; nunca cuenta como "No" | [06](browser-validation/06-failed-retry.png) |
| Sin permiso / página interna | *No access* y *Can't read*, no se envían a Jev | [07](browser-validation/07-access-states.png) |
| Página de aplicación | PR de GitHub (fixture): hecho determinista "Merged" + 2 comentarios en la captura y badge | [07b](browser-validation/07b-github-pr-facts.png) |
| Preview en filas | descripción y `og:image` de la propia página, leídas localmente (comando `previews`) | [15](browser-validation/15-inspector.png) |
| Inspector de pestaña | clic en la fila → panel con contenido en Markdown (tabla GFM, código con lenguaje, links absolutos), pestaña Links y Details | [15](browser-validation/15-inspector.png) |
| Filtro por dominio | uno, varios (OR), quitar un chip, limpiar | [16](browser-validation/16-domain-filter.png) |
| Captura sin datos sensibles | los valores de `<input>` y password del fixture no aparecen en la caché | |
| Bridge | Linklog en 3010 sin origen configurado (el manifest no nombra el puerto); página local sin marcador (fixture en 127.0.0.1:3099): sin bridge, sin `chrome.runtime`, sin respuesta; app local con `<meta name="linklog-app">` en 3098: bridge presente pero `snapshot` antes de `hello` → "Connect first."; comando inválido descartado; pestaña de otra ventana rechazada y sigue abierta | |
| Save | la página manda sólo URLs; 2 links creados por el pipeline normal y **1 batch `extract` encolado** (el fixture es 127.0.0.1, bloqueado por SSRF, y no hay bindings remotos: la extracción no puede completar aquí, se verifica que se encoló); re-Save = duplicado y tags intactos | [08](browser-validation/08-saved.png) |
| Close | cierra sólo las seleccionadas; links guardados intactos | |
| Grupo pineado | creado desde la selección; en la otra ventana aparece sin crear grupo vacío y se materializa al usarlo, con binding | [09](browser-validation/09-groups.png), [10](browser-validation/10-pinned-other-window.png) |
| Nombres duplicados | dos grupos "Research" nativos, una definición pineada | |
| Autogroup | un clic = **una** corrida: 1 batch en Activity y 2 llamadas para 2 pestañas (UI en dev con StrictMode); revisión con sugerencias; una pestaña agrupada mientras corría Jev se conserva; la otra va al pineado | [11](browser-validation/11-autogroup-review.png) |
| Move / Ungroup | Move cambia un grupo existente; Ungroup deja la pestaña abierta | |
| Filtros de grupo | uno, varios (unión) y "Ungrouped" | [12](browser-validation/12-group-filters.png) |
| Dos páginas Linklog | activación concurrente desde ambas: llamadas = pestañas legibles | |
| Mover pestaña / mover Linklog | la fila cambia de ventana con su caché; la página movida pasa a la ventana destino | |
| Segundo perfil | ve el pineado, no las pestañas; `installationId` distinto | [13](browser-validation/13-second-profile.png) |
| Unpin | grupos nativos siguen abiertos | |
| Activity | batches "Browser lens: …" y "Autogroup · open tabs" con consumo | [14](browser-validation/14-activity.png) |
| Migración 0010 en D1 real | Wrangler local: 0001–0009, datos sembrados, luego 0010 → links, jobs, `usage_events.job_id` y leases intactos | |

## Tests unitarios nuevos (`bun test`)

- `tests/browser-migration.test.ts`: 0010 sobre SQLite con FKs activas — conserva jobs,
  usage (sin nulificar `job_id`), leases, lens results; checks de target; rollback atómico.
- `tests/browser-retention.test.ts`: snapshots borrados, resultados no confirmados → `expired`
  a los 7 días, barrido idempotente; request ID desconocido; POST idempotente (misma clave =
  mismo job, payload distinto = 409, lens cambiada = 409) sin crear links.
- `packages/browser-protocol/tests`: fingerprint (umbral no cuenta), filtros (inversos, unknown ≠
  No, AND/OR, score), claves, patrones de permisos, validación de mensajes, diff/patch.
- `apps/extension/tests`: 20+3, activaciones concurrentes, recuperación por request ID,
  respuestas tardías tras cierre/navegación/Clean, retry explícito, versión de lens, presupuesto
  de capturas y error de cuota (índice consistente tras `QuotaError`), `deposit` que sólo reporta
  cambios reales y respeta el `libraryScope`, Clean que devuelve los `targetKeys` exactos,
  registro de pestañas (hash/SPA/reapertura/reemplazo), validación del emisor del bridge
  (cualquier puerto local, orígenes configurados), estados de acceso, re-vinculación de grupos
  pineados tras reinicio/recarga (`groups.test.ts`) y comandos con un `chrome` falso
  (`commands.test.ts`): `hello` obligatorio, presupuesto de `claim` en bytes con contenido no
  ASCII, `attempted`, reanudación con el mismo request ID, `capture` con/sin `fresh`, pestaña que
  navegó, páginas de Linklog y de otra ventana.
- `packages/browser-protocol/tests/transport.test.ts`: `jsonBytes`/`chunkByBytes` (no ASCII, límite
  de ítems, ítem sobredimensionado), la captura más ancha posible cabe en un request, claves de
  prototipo (`constructor`, `toString`, `hasOwnProperty`…) rechazadas, límites de `clean`/`deposit`,
  orígenes del bridge.
- `tests/browser-routes.test.ts`: `DELETE` con `targetKeys`, lentes de biblioteca rechazadas,
  `ack` sólo de respondidos, fallo de R2 → targets `failed` sin despacho, Save por el pipeline
  normal (dedupe, un batch `extract`, sin contenido local), catálogo sin escrituras.
- `tests/claim-rounds.test.ts`: Re-evaluate evalúa cada pestaña una vez aunque haga varias rondas.

## Lo que no se pudo verificar aquí

- **Smoke con Jev real: no realizado.** El entorno no tiene `.dev.vars` ni credenciales de
  TypeSafe/Cloudflare. El camino de producción usa el mismo `judge()` que ya estaba verificado con
  `jev-1.13.0`; sólo cambia el `state` enviado (URL, título, procedencia, completitud, hechos,
  contenido). Recomendado: `JEV_PROVIDER=typesafe` en `.dev.vars` y activar una lente sobre 2–3
  pestañas.
- **Extractor en un DOM de unit test**: no hay DOM (happy-dom/jsdom) en las dependencias; la
  invariante de privacidad (sin valores de `<input>`/password) se verifica end-to-end en la
  integración ("page capture excludes form values and passwords").
- **Reinicio real de Chrome con grupos restaurados**: Playwright no restaura sesiones; la
  re-vinculación está cubierta por `groups.test.ts`.
- **Pestañas descartadas/congeladas en integración**: `chrome.tabs.discard()` (y abrir
  `chrome://…` desde la extensión) cierra el contexto de Playwright en Chromium headless,
  reproducido con una extensión vacía. Cubierto por tests unitarios de `contentAccess`; conviene
  una verificación manual con `bun run extension:chrome` (clic derecho → descartar vía
  `chrome://discards`).
- **Diálogo de permisos**: el prompt nativo de `chrome.permissions.request` no es automatizable;
  la build de test concede los hosts de fixtures al instalar y un origen no concedido
  (`localhost:3099`) valida el estado *No access*. La página Connect se probó en la corrida smoke.
- **Timeout ambiguo del proveedor**: el mensaje y la ausencia de reintento están en el código
  (`worker/ai/jev.ts`), no hay un test que fuerce un timeout real de TypeSafe.
- Chrome estable no permite `--load-extension`; la carga manual está documentada en el handoff.
