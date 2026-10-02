# FAC-48 — Mapa de “Needs attention”

Base: `main` @ `32fc90f` (incluye PR #4). Solo diagnóstico; no hay cambios de producto.
Repro: `bun test ./planning/research/needs-attention.repro.ts` (10/10 pass, SQLite en memoria, red mockeada; no toca `.wrangler/state`, no despliega). La suite existente (`bun test`) sigue en 102/102.

Leyenda de confianza: **R** = reproducido ejecutando el código real del Worker · **C** = leído en código, no ejecutado · **H** = hipótesis · **L** = observado en vivo (fetch público desde Bun local, aproximación al egress de Workers).

## 1. Qué es “Needs attention” hoy

- **No es un tag ni una columna.** Es una vista derivada en el cliente: `l.status === "failed" || l.content_state === "failed"` (`src/components/Sidebar.tsx:90-92` para el contador, `src/App.tsx:427-429` para el filtro). El ítem del sidebar solo aparece si el contador es > 0 (`Sidebar.tsx:130`).
- Combina **dos ejes independientes** con escritores distintos:
  - `links.status` (`pending|ready|failed`) = resultado del **preview de metadatos** (GET HTML, OG tags).
  - `links.content_state` (`missing|queued|ready|partial|failed`) = resultado de la **extracción de contenido** (Browser Rendering / adapters).
- `status` además se **virtualiza en el servidor**: `library()` devuelve `failed` para cualquier fila `pending` con más de 30 s desde `metadata_started_at || created_at` (`worker/store.ts:143-147`). El valor guardado sigue siendo `pending`.
- La fila muestra badges separados: “No preview” (`status=failed`, `LinkRow.tsx:200-205`) y “Context failed” (`content_state=failed`, `LinkRow.tsx:194-199`). La razón textual solo existe para el eje de contenido (`content_error`); para el preview no se guarda ninguna razón.
- El string literal `'Needs attention'` también es `jobs.step` de un job fallido (`worker/jobs.ts:264`), pero la Activity no lo muestra para jobs `failed`: muestra `j.error` (`ActivitySheet.tsx:176, 198-212`). Un autotag o lens fallido queda con `step='Needs attention'` y **no** hace aparecer el link en la vista.

## 2. Tabla de transiciones

`A` = entra en la vista, `S` = sale, `=` = sin cambio en la vista.

| # | Disparador | Transición (status / content_state) | Efecto en vista | Archivo:línea | Evidencia / confianza |
|---|---|---|---|---|---|
| 1 | Guardar link (Add, paste, import, Save desde Browser) | INSERT `pending` / `missing` → enqueue extract → `queued` | = | `worker/links.ts:13-17`, `worker/index.ts:231-250`, `worker/browser.ts:321-330`, `worker/jobs.ts:98-103`; default `pending` en `migrations/0001_library.sql` | R (escenario A) |
| 2 | **Pasan 30 s sin que el job haya corrido el preview** (esperando slot del pool `browser`, límite 2) | guardado `pending`, servido `failed` / `queued` | **A** (fila: “Extracting…” + “No preview” a la vez) | `worker/store.ts:143-147`; preview detrás del pool: `worker/handlers/extract.ts:45`, `worker/jobs.ts:16, 204-233, 246` | R (A, I). Que la espera supere 30 s en uso real: H fuerte (ver §4) |
| 3 | El workflow corre el preview OK | `ready` / … | **S** si content no está `failed` | `worker/handlers/extract.ts:48-53` | R (A) |
| 4 | El preview responde no-2xx o no-HTML (403 bot wall, 429, PDF…) | `failed` persistido (sin razón guardada), aunque el contenido salga bien | **A** y se queda | `worker/metadata.ts:78-92` → `extract.ts:50-51` | R (B); L: `medium.com` → 403, `arxiv.org/pdf/…` → `application/pdf`; los dos dan `failed` |
| 5 | **Re-extract** de un link sano cuando solo el preview falla | `ready` → `failed` / contenido sigue `ready` | **A** (sin que haya cambiado nada del contenido) | `extract.ts:50-51` reescribe `status` en cada extracción | R (C) |
| 6 | `resolve-and-preview` lanza (DNS, timeout 10 s, host privado, puerto) tras 1 reintento | `pending`→`failed` y `failed` (si no había contenido) | **A** | `extract.ts:48`, `worker/jobs.ts:258-273` | R (G) |
| 7 | Extracción de contenido falla, link **sin** contenido previo | = / `failed`, `content_error=msg`; job `failed/Needs attention` | **A** | `worker/jobs.ts:268-273`, `worker/content-state.ts:2` | R (D) |
| 8 | Extracción de contenido falla, link **con** contenido previo | = / se preserva `ready`/`partial`, `content_error=msg` | = (solo “Last extraction failed” en el inspector) | `content-state.ts:2`, `Inspector.tsx:506` | R (E) |
| 9 | Reintentar extracción (Retry / Re-extract / Extract context / elegir pista) | = / `queued`, `content_error=NULL` al **encolar** | **S** inmediato (antes de correr); vuelve a **A** si falla | `worker/jobs.ts:98-103`; UI `Inspector.tsx:629`, `LinkRow.tsx:267`, `index.ts:289-299` | R (D) |
| 10 | “Retry preview” (solo visible si `status=failed`) | `pending` + `metadata_started_at=now` → `enrich` fuera de la cola → `ready`/`failed` | **S** solo si el sitio ahora da 200 **y** content no está `failed` | `worker/index.ts:572-578, 38-62`; UI `LinkRow.tsx:270`, `Inspector.tsx:345, 941` | R (B, F, G) |
| 11 | “Retry preview” con un job activo | HTTP 400 “Wait for the running job to finish.” | = (la opción se muestra igual, porque el `failed` es virtual) | `worker/index.ts:563-571` | R (I) |
| 12 | Pegar/subir contenido manual | = / `ready` (o `partial`) | **S** solo del eje contenido; si `status=failed` sigue en la vista | `worker/index.ts:449-465` | R (B) |
| 13 | Cancelar batch de extract con jobs en cola | = (sigue `pending`) / `missing` | = y luego **A** a los 30 s, para siempre (“No preview”) | `worker/index.ts:301-331` | R (F) |
| 14 | Redelivery encuentra el workflow `errored/terminated/complete` | = (puede quedar `pending`) / `failed` “Extraction was interrupted” | **A** | `worker/jobs.ts:136-157` | R (H), invocando `dispatch` con instancia mockeada |
| 15 | Autotag / lens falla | nada en `links`; job `failed/Needs attention` | = (solo toast “N failed — see Activity”) | `worker/jobs.ts:262-267`, `App.tsx:236-245` | C |
| 16 | Recarga / polling | Sin estado en el cliente: todo sale de `GET /api/library` + `Date.now()` del servidor. El polling (1.8 s) corre mientras haya links `pending` o batches activos | La vista cambia **solo por tiempo** (filas 2 y 13) sin ningún evento | `App.tsx:163-200`, `store.ts:143-147` | R (tick de reloj + recarga en A, F, H, I) |
| 17 | Cron `recover()` reenvía jobs `queued/running` (5 min; 30 s en dev) | `dispatch` es idempotente por ID del workflow; no repite pasos pagos | = (salvo fila 14) | `worker/jobs.ts:114-121, 122-163`, `scripts/dev.ts` | C. La hipótesis de “reprocesamiento repetido” queda **débil** |

## 3. Casos representativos (reproducidos)

Salida de `bun test ./planning/research/needs-attention.repro.ts`, recortada:

```
A | saved                          | status=pending content=queued  attention=false
A | +31s reload, job not started   | status=failed  content=queued  attention=true
A | workflow ran OK                | status=ready   content=ready   attention=false      ← aparece y se recupera solo
B | extract OK, preview non-OK     | status=failed  content=ready   attention=true  job=done/Done
B | Retry preview (same response)  | status=failed  content=ready   attention=true       ← se repite
B | manual paste of content        | status=failed  content=ready   attention=true       ← pegar no lo limpia
C | first extract OK               | status=ready   content=ready   attention=false
C | re-extract, preview 429        | status=failed  content=ready   attention=true       ← un link sano vuelve a entrar
D | extract fails                  | status=ready   content=failed  attention=true  job=failed/Needs attention
D | Retry → enqueued (not run)     | status=ready   content=queued  attention=false      ← sale antes de probar
D | retry fails again              | status=ready   content=failed  attention=true       ← vuelve a entrar
E | re-extract fails, prior content| status=ready   content=ready   attention=false err="Markdown: HTTP 503"
F | batch cancelled → +31s reload  | status=failed(virtual) content=missing attention=true  (guardado: pending)
G | preview throws                 | status=failed  content=failed  attention=true
G | Retry preview succeeds         | status=ready   content=failed  attention=true       ← sigue en la vista
H | dispatch: instance errored     | status=pending content=failed  attention=true  job=failed/Interrupted
I | POST /retry while queued       | HTTP 400 "Wait for the running job to finish."
```

### Pasos para reproducir a mano (dev local aislado)

Usar un estado propio para no tocar el de otros: `LINKLOG_PERSIST_TO=$(mktemp -d) LINKLOG_UI_PORT=3100 LINKLOG_API_PORT=8790 bun run dev`.

1. **Aparece y se recupera (A):** pegar 6–10 URLs HTML válidas de golpe. Al pasar ~30 s, los links que siguen esperando slot muestran “Extracting…” y “No preview” y suben el contador de Needs attention. A medida que el pool avanza, salen de la vista.
2. **Se repite (B):** guardar `https://medium.com/` o un PDF (`https://arxiv.org/pdf/1706.03762`). El contenido se extrae, pero el link queda con “No preview”. “Retry preview” lo deja igual. Pegar contenido manual tampoco lo saca.
3. **Un link sano vuelve a entrar (C):** re-extraer un link de un sitio que limita por tasa o bloquea bots de forma intermitente. Si el GET de preview no da 200, el link entra aunque el contenido nuevo sea correcto.
4. **Entra y sale con cada reintento (D):** un link cuya extracción falle siempre, sin contenido previo. “Retry” lo saca de la vista al encolar y lo devuelve al fallar.
5. **Cancelación (F):** importar varias URLs y cancelar desde el toast antes de que corran. A los 30 s aparecen como “No preview” / Needs attention, sin razón visible. Se recuperan con “Retry preview”.

Los pasos 1–5 a mano **no se ejecutaron** en esta sesión (requieren Browser Rendering remoto y tiempo real). Sí se ejecutaron sus equivalentes aislados A–I.

## 4. Causas candidatas (priorizadas)

1. **El `pending → failed` virtual a los 30 s ya no corresponde al pipeline** (explica “aparece y luego se recupera”). La regla es del commit inicial (`7c5f4ad`, 2026-09-21), cuando el preview corría inline con `enrich` (README:60 lo describe como recuperación ante reinicios). Desde `1219eb1` (2026-09-23) el preview va **dentro** del workflow de extracción y **detrás del pool `browser` de 2 slots** (`extract.ts:45`, `jobs.ts:16`). Cualquier link que espere slot más de 30 s aparece como fallido. Además, un lease huérfano se retiene hasta 5 min (`jobs.ts:219`), lo que alarga la espera. Confianza: mecanismo R. Frecuencia en uso real: H (depende de la latencia de Browser Rendering y del tamaño de los batches).
2. **Un fallo del preview de metadatos cuenta como “Needs attention” aunque el contenido esté bien, y no guarda razón** (explica “lo recibe repetidamente”). Cualquier no-2xx o no-HTML (`metadata.ts:78-92`) persiste `failed`. “Retry preview” repite el mismo GET determinista. Cada re-extract reescribe `status` y puede volver a meter un link sano. Confianza: R, más L (403 de medium.com, PDF).
3. **Dos ejes con acciones de recuperación distintas bajo una sola etiqueta.** “Retry preview” no toca el contenido (G). Pegar contenido no toca el preview (B). “Retry” de extracción limpia el estado al **encolar**, no al tener éxito (D). Resultado: la vista parpadea y la acción visible no siempre la limpia. Confianza: R.
4. **Asimetría según el historial.** El mismo fallo de extracción marca el link solo si nunca tuvo contenido (`content-state.ts:2`, E vs D). Confianza: R. Puede ser intencional; preguntar.
5. **Estados huérfanos sin salida automática.** Una cancelación (F) o una interrupción (H) dejan `status='pending'` guardado para siempre. Solo sale del limbo por el `failed` virtual. Confianza: R.
6. **Hipótesis descartadas o débiles:** reprocesamiento repetido por redelivery o cron (dispatch idempotente, `jobs.ts:122-163`: C). Estado en el cliente que sobreviva una recarga: no existe; todo es del servidor (C/R).

## 5. Qué quedó probado y qué no

- **Probado (R):** filas 1–14 y 16 de la tabla, con el handler `fetch`, `LinkWorkflow.run` y `dispatch` reales sobre las migraciones reales. Clasificación en vivo del preview para 8 URLs públicas (L; egress local, no de Workers).
- **No probado:**
  - Stack completo `wrangler dev` + Queue + Workflows reales. El step falso no emula los reintentos por defecto de Workflows en steps sin config, ni la reanudación tras un reinicio.
  - Cuánto esperan de verdad los jobs por un slot de `browser`.
  - La UI renderizada (no se abrió el navegador).
  - Datos reales del dueño: no hay `.wrangler/state` en este worktree y no se tocó el de otros.
  - Los ejemplos concretos del PDF/tldraw original.
- **Todavía sin reproducir:** workflow `terminated` por timeout real de 2 min. Lease huérfano de 5 min alargando la espera. Si Workers egress recibe más 403/429 que Bun local.

## 6. Preguntas para el grilling

1. ¿Los ejemplos que viste (“lo recibe repetidamente” / “luego se recupera”) eran links recién guardados en lote, o links viejos re-extraídos? ¿Mostraban “No preview”, “Context failed” o los dos? (Separa la causa 1 de las 2 y 3.)
2. ¿Un link cuyo **contenido** se extrajo bien pero cuyo **preview** (título, imagen) falló debería estar en Needs attention? ¿O solo cuando falta algo que bloquee autotag o lenses?
3. ¿Un link en cola o procesándose puede aparecer alguna vez en Needs attention? Si no, ¿qué señal reemplaza la recuperación a 30 s pensada para reinicios del Worker?
4. Si un re-extract falla pero hay contenido previo, ¿debe avisar? Hoy solo lo hace el inspector (E). ¿Es intencional la asimetría con D?
5. ¿Qué cuenta como **transitorio** (5xx, 429, timeout, DNS, interrupción) y qué requiere acción del usuario (403 permanente, no-HTML, contenido vacío, >2 MB, “no public transcript”)? ¿Existe un cuarto estado, “reintentando”, distinto de “necesita atención”?
6. Reintentos acotados: ¿cuántos intentos automáticos y con qué espera? ¿Solo para pasos sin costo (preview/DNS) o también para Browser Rendering y Jev, que hoy están deliberadamente en `retries: 0` por costo?
7. ¿Cuándo se limpia exactamente? ¿Al tener éxito el paso que falló, al tener éxito cualquier extracción, al pegar contenido o al descartarlo a mano? ¿Debe existir “Dismiss”?
8. ¿Debe guardarse y mostrarse la **razón** del fallo de preview (HTTP 403, `application/pdf`…)? Hoy no se persiste nada.
9. Tras cancelar un batch, ¿los links deben quedar como “sin contexto” neutros (no atención), o marcados para reintentar?
10. ¿Los fallos de autotag/lens (hoy `step='Needs attention'` pero invisibles en la vista) deberían entrar en Needs attention o quedarse solo en Activity?
11. ¿“Needs attention” sigue siendo una vista derivada, o querés que pase a ser un estado persistido con historial de intentos (para auditar “se repite”)?

## 7. Decisiones del dueño (grilling, 2026-10-01)

Resumen de las respuestas a §6. “Jev” corresponde a lo transcrito como shep/Jeff/jeb.

| Tema | Decisión |
|---|---|
| Cuándo entra | **Solo cuando se agotaron todos los reintentos.** Mientras un link está en cola, procesándose o reintentando, no entra. El síntoma reportado coincide con la causa 1 (batch → algunos entran → salen poco a poco). |
| Preview falla pero el contenido sale bien | Entra (debería ser raro). El preview se reintenta automáticamente con espera progresiva y límite, y el usuario puede reintentarlo a mano. |
| Contenido falla | Es el caso más probable. Entra al agotar los reintentos. |
| Contenido que en realidad es un muro de login o bloqueo | Cuenta como fallo y entra. |
| Activity | Mostrar el intento actual (“2 de 3”), el motivo del reintento en lenguaje simple (“No se pudo extraer el contenido”, “No se pudo obtener el preview”) e info de timeout. Permitir **cancelar un link individual** mientras corre. |
| Re-extract falla con contenido previo | No entra. Se ve en Activity, y en el inspector como “falló, se muestra la versión anterior”. Sin historial complejo en la UI. |
| Transitorio vs. acción del usuario | Lo transitorio solo se espera (reintentos). Al final, si sigue sin resolverse: entra con un motivo entendible, no técnico. |
| Reintentos | Preview: 2. Browser Rendering → Markdown: 1. Jev: 2 por link, contando con que casi siempre falla **antes** de llamar a la API (por ejemplo, contenido aún no listo). |
| Jev sobre links sin contenido listo | Que espere encolado **por link** hasta que el contenido esté listo, sin pedirle nada al usuario. Un batch de extracción no bloquea Jev de otros links. Jev **nunca** dispara la extracción automáticamente (evitar loops y pedidos duplicados). |
| Cómo se limpia | Cuando el paso que falló se vuelve a correr y funciona. Botón **Retry** del paso fallido dentro de Needs attention, y **Dismiss**. |
| Motivo técnico del fallo | No se muestra crudo al usuario. Se loguea en Cloudflare para detectar patrones (por ejemplo, demanda de PDFs o sitios que requieren una API). |
| Cancelar un batch | “Como si no hubiera pasado nada”: lo que ya corrió se conserva y lo no corrido no deja estado. |
| Fallos de autotag o lens | No entran en Needs attention. Si falta contenido, se pide buscarlo, pero no automáticamente. |
| Modelo | Persistido y robusto, ligado a Activity, para seguir dónde y cuándo corre cada cosa. |

## 8. Propuesta de implementación (para revisar, no implementada)

### 8.1 Estado persistido en lugar de vista derivada

- **Quitar** el `pending → failed` virtual (`worker/store.ts:143-147`). “Procesando” pasa a significar que existe un job `queued/running/waiting` para el link. Un `pending` sin job (cancelado o nunca corrido) es neutro: “Preview no obtenido” (`LinkRow.tsx:139-143`), no atención.
- Agregar a `links`: `attention_kind` (`preview|content|blocked`), `attention_reason` (código), `attention_job_id`, `attention_at`. La vista pasa a ser `attention_kind IS NOT NULL` (servidor y `Sidebar`/`App` leen el mismo campo).
- **Se setea** solo en `record-failure` del intento final (`worker/jobs.ts:258-273`) y en el muro de login detectado. **No se setea** en: cancelación, re-extract fallido con contenido previo bueno, ni fallos de Jev o lens.
- **Se limpia** cuando el paso del mismo tipo tiene éxito (preview OK limpia `preview`; contenido OK limpia `content`/`blocked`), con Dismiss o al borrar el link. Un fallo final posterior lo vuelve a levantar.
- El Retry de la vista corre **solo el paso fallido**, y la marca se mantiene hasta el éxito. Así se evita el parpadeo del escenario D: hoy `jobs.ts:101` limpia al encolar. Mientras tanto, la fila muestra “Reintentando…”.
- “Retry preview” deja de usar `ctx.waitUntil(enrich)` (`worker/index.ts:578`) y pasa a ser un job `preview` por la cola. Queda visible en Activity, se recupera por cron y respeta los mismos reintentos.

### 8.2 Reintentos visibles y acotados

- Workflows expone `ctx.attempt` dentro de `step.do` (`worker-configuration.d.ts:14005-14010`), así que alcanzan los reintentos nativos con `backoff: "exponential"`. Al empezar cada intento se escribe `jobs.attempt/max_attempts/attempt_started_at`. Antes de relanzar el error se escribe `jobs.retry_reason`. Activity muestra, por ejemplo, “Contenido · intento 2/2 · 40 s de 2 min · el sitio tardó demasiado”.
- **Preview** (`extract.ts:48`): hoy un no-2xx **no lanza**, sino que devuelve `status:'failed'` (`metadata.ts:78-92`), así que los reintentos nunca aplican. Hay que clasificar: lanzar (reintentable) en timeout, DNS, 5xx, 429 y 408; devolver el fallo final sin reintentar en no-HTML, 404 y 410. Límite 2 con espera exponencial (por ejemplo 5 s → 20 s).
- **Browser Rendering → Markdown** (`extract.ts:56`, `web.ts`): límite 1 solo para errores transitorios. Sin reintento en “no content”, en >2 MB ni en hosts no públicos.
- **Interrupción** (`jobs.ts:136-157`): hoy marca fallo directo. Propuesta: contarla como intento y re-crear el job una vez antes de darlo por fallido.
- Códigos de motivo con texto para el usuario: `timeout` “El sitio tardó demasiado”, `unreachable`, `site_error` (5xx), `rate_limited`, `blocked` (401/403) “El sitio bloquea el acceso automático”, `not_found`, `not_html` “Es un PDF/archivo, no una página”, `empty`, `too_large`, `login_wall`, `interrupted`, `no_transcript`.

### 8.3 Jev esperando contenido: cola serial por link

Restricciones actuales: `enqueue` rechaza **todo el batch** si algún link no tiene contenido (`jobs.ts:50-53`) o si alguno está procesando (`jobs.ts:54-60`). El índice único `jobs_active_link` (`migrations/0001`) impide dos jobs activos en el mismo link.

Propuesta:

1. **Nuevo estado `waiting`** (fuera del índice único, que solo cubre `queued/running`). Al encolar cualquier job para un link que ya tiene uno activo, el nuevo queda en `waiting` y no se envía a la Queue. Funciona como una FIFO por link: autotag y lens sobre el mismo link corren uno después del otro, nunca en paralelo.
2. **Promoción por link, no por batch.** En el mismo step `complete`/`record-failure` (`jobs.ts:249-274`), promover el `waiting` más antiguo de ese link a `queued` y enviarlo. Los pools siguen separados (`browser` 2, `jev` 16, `jobs.ts:16`): extraer otros links no frena el Jev de un link ya listo. `recover()` (`jobs.ts:114-121`) también promueve los huérfanos (`waiting` sin predecesor activo), así una promoción perdida no deja nada colgado.
3. **Chequeo previo dentro del job de Jev** antes de pedir slot del pool: si no hay `content_key` o el contenido quedó `failed`/`blocked`, el job falla sin costo con “Falta el contenido; extraelo primero”. No entra en atención y **no** dispara la extracción, así que no hay loops.
4. **Validación por link en `enqueue`.** Se aceptan los links con contenido o con extracción activa/en espera. Los demás se devuelven como “omitidos: necesitan contenido”. La UI ofrece una acción **explícita** “Extraer y luego auto-taggear”, que encadena un extract y un autotag en `waiting`. Es una decisión del usuario, no algo automático.
5. **Reintentos de Jev: 2, solo ante 429, 5xx o error de red antes de recibir respuesta.** Sin reintento en errores deterministas (contexto excedido, respuesta inválida repetible). La espera por contenido **no** consume reintentos, porque no es un fallo. Cada intento queda medido en `usage_events`. Esto cambia la política del README (“Paid steps are not silently retried”) a “reintentos acotados y visibles”, y hay que documentarlo.

Por qué D1 `waiting` y no `step.waitForEvent`: no deja instancias de Workflow vivas esperando, no requiere que el extract sepa a quién notificar, sigue el patrón existente (D1 como outbox, cron como red de seguridad) y respeta el índice único sin cambiarlo.

### 8.4 Cancelar un link individual

`DELETE /api/jobs/:id`:

- **`queued`/`waiting`:** se marca `Cancelled`.
- **`running`:** `PROCESS_LINK.get(id).terminate()` y luego `Cancelled`. Se restaura `content_state` con `preservedContentStateSql("missing")`, se libera el lease y no se toca `attention_*`.

Los dependientes en `waiting` del mismo link se cancelan en cascada, con aviso. Una llamada paga en vuelo puede cobrarse igual: `recover()` ya la registra como `failed` (`jobs.ts:115`).

### 8.5 Telemetría

`observability.enabled` ya está activo (`wrangler.jsonc:30`). Se emite un `console.log` JSON por intento fallido: `{event:"link_step_failed", step, attempt, final, reason, http_status, content_type, domain, adapter}`. Solo el dominio, sin la URL completa. Sirve para medir la demanda de PDFs, los sitios con muros y la tasa de 429.

### 8.6 Orden sugerido (cada parte se puede entregar sola)

1. Quitar el `failed` virtual de 30 s y dejar neutros los cancelados. Ataca directamente el síntoma reportado.
2. Clasificación de motivos, reintentos del preview y del Markdown, intento visible en Activity, telemetría.
3. `attention_*` persistido, con Retry del paso fallido (preview por la cola) y Dismiss.
4. Cola serial por link para Jev, validación por link y reintentos de Jev.
5. Cancelación por link en Activity.
6. Detección de muro de login, calibrada con los datos de telemetría de la parte 2.

### 8.7 Puntos a confirmar

1. **403/401:** ¿falla rápido (un muro anti-bot rara vez se abre en segundos) o se reintenta igual? Propuesta: falla rápido con el motivo `blocked`.
2. **Reintentos de Jev:** ¿se aceptan con costo potencial ante 429/5xx, o solo los que ocurren antes de enviar la llamada? En un timeout no siempre se sabe si se cobró.
3. **Muro de login:** ¿se guarda igual el texto (visible, pero excluido de Jev) o se descarta? Los falsos positivos son el riesgo: conviene una heurística conservadora (texto corto más patrones como “sign in”, “captcha”, “Just a moment”, “Access denied”) y ajustarla con la telemetría.
4. **Dismiss:** ¿oculta solo ese fallo (vuelve a aparecer si un intento posterior falla) o silencia el link para siempre?
5. **Cancelar un extract con un Jev esperando:** ¿se cancela en cascada (propuesta) o el Jev falla con “falta contenido”?
