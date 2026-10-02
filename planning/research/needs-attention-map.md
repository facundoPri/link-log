# FAC-48 — Mapa de “Needs attention”

Base: `main` @ `32fc90f` (incluye PR #4). Solo diagnóstico; no hay cambios de producto.
Repro: `bun test ./planning/research/needs-attention.repro.ts` (11/11 pass, escenarios A–J, SQLite en memoria, red mockeada; no toca `.wrangler/state`, no despliega). La suite existente (`bun test`) sigue en 102/102.

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
| 16b | Autotag o lens sin `TYPESAFE_API_KEY` | `POST /api/batches` 200. Cada job toma un slot `jev`, inserta una fila en `usage_events` y falla “TYPESAFE_API_KEY is not configured.” sin llamar al proveedor | = | `worker/jobs.ts:61-85`, `worker/ai/jev.ts:185-194`, `worker/usage.ts:36-52` | R (escenario J) |
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
- **Preview** (`extract.ts:48`): hoy un no-2xx **no lanza**, sino que devuelve `status:'failed'` (`metadata.ts:78-92`), así que los reintentos nunca aplican. Hay que clasificar: lanzar (reintentable) en timeout, DNS, 5xx, 429 y 408; devolver el fallo final sin reintentar en no-HTML, 404, 410 y **401/403 o firma anti-bot** (decidido: falla rápido, §8.7). Límite 2 con espera exponencial (por ejemplo 5 s → 20 s).
- **Browser Rendering → Markdown** (`extract.ts:56`, `web.ts`): límite 1 solo para errores transitorios. Sin reintento en “no content”, en >2 MB, en hosts no públicos, en bloqueo anti-bot ni en muro de login.
- **Interrupción** (`jobs.ts:136-157`): hoy marca fallo directo. Propuesta: contarla como intento y re-crear el job una vez antes de darlo por fallido.
- Códigos de motivo con texto para el usuario: `timeout` “El sitio tardó demasiado”, `unreachable`, `site_error` (5xx), `rate_limited`, `blocked` (401/403) “El sitio bloquea el acceso automático”, `not_found`, `not_html` “Es un PDF/archivo, no una página”, `empty`, `too_large`, `login_wall`, `interrupted`, `no_transcript`.

### 8.3 Jev esperando contenido: cola serial por link

Restricciones actuales: `enqueue` rechaza **todo el batch** si algún link no tiene contenido (`jobs.ts:50-53`) o si alguno está procesando (`jobs.ts:54-60`). El índice único `jobs_active_link` (`migrations/0001`) impide dos jobs activos en el mismo link.

Propuesta:

1. **Nuevo estado `waiting`** (fuera del índice único, que solo cubre `queued/running`). Al encolar cualquier job para un link que ya tiene uno activo, el nuevo queda en `waiting` y no se envía a la Queue. Funciona como una FIFO por link: autotag y lens sobre el mismo link corren uno después del otro, nunca en paralelo.
2. **Promoción por link, no por batch.** En el mismo step `complete`/`record-failure` (`jobs.ts:249-274`), promover el `waiting` más antiguo de ese link a `queued` y enviarlo. Los pools siguen separados (`browser` 2, `jev` 16, `jobs.ts:16`): extraer otros links no frena el Jev de un link ya listo. `recover()` (`jobs.ts:114-121`) también promueve los huérfanos (`waiting` sin predecesor activo), así una promoción perdida no deja nada colgado.
3. **Chequeo previo dentro del job de Jev** antes de pedir slot del pool: si no hay `content_key` o el contenido quedó `failed`/`blocked`, el job falla sin costo con “Falta el contenido; extraelo primero”. No entra en atención y **no** dispara la extracción, así que no hay loops.
4. **Validación por link en `enqueue`.** Se aceptan los links con contenido o con extracción activa/en espera. Los demás se devuelven como “omitidos: necesitan contenido”. La UI ofrece una acción **explícita** “Extraer y luego auto-taggear”, que encadena un extract y un autotag en `waiting`. Es una decisión del usuario, no algo automático.
5. **Reintentos de Jev según la fase (decidido, §8.7).** La regla separa **antes de enviar** de **después de enviar**:
   - **Antes de enviar** (lectura de R2, slot del pool, D1 transitorio): se reintenta hasta 2 veces, solo con motivos conocidos y acotados.
   - **Después de enviar** (HTTP de error, timeout, respuesta inválida, saldo insuficiente): **nunca** se reintenta automáticamente; el usuario puede reintentar a mano desde Activity.
   - **Errores de red sin respuesta:** se tratan como “después de enviar”, porque en Workers no se puede probar que la petición no salió.
   - La espera por contenido no es un fallo y no consume reintentos.
   - La política del README (“Paid steps are not silently retried”) se mantiene.

   Implementación: marcar `meter.sent = true` justo antes del `fetch`/`env.AI.run` (`worker/ai/jev.ts:195, 229`) y guardar la fase en `usage_events` (columna `phase`). Mejor todavía, crear la fila de uso recién al enviar: hoy `measured()` la inserta antes de cualquier chequeo (`worker/usage.ts:36-52`). Activity muestra “Falló antes de llamar a Jev (sin costo)” o “Jev respondió con error (puede haberse cobrado)”.
6. **Corte por batch ante errores de cuenta o configuración.** Si el proveedor responde 401/402/403 o “saldo insuficiente”, los jobs restantes del mismo batch fallan sin llamar, con el mismo motivo. Así no se repiten N llamadas destinadas a fallar.

Por qué D1 `waiting` y no `step.waitForEvent`: no deja instancias de Workflow vivas esperando, no requiere que el extract sepa a quién notificar, sigue el patrón existente (D1 como outbox, cron como red de seguridad) y respeta el índice único sin cambiarlo.

### 8.3b Validar la configuración de Jev antes de encolar

Hecho reproducido (escenario J del repro): sin `TYPESAFE_API_KEY`, `POST /api/batches` (autotag) devuelve **200**. Cada link arranca un workflow, toma un slot del pool `jev`, inserta una fila en `usage_events` y recién entonces falla con “TYPESAFE_API_KEY is not configured.” (`worker/ai/jev.ts:193`, dentro de `measured()`). No llega ninguna petición al proveedor, pero se crean N workflows y N filas de uso fallidas. `capabilities(env).jev` ya existe (`worker/store.ts:14-26`), pero ni `enqueue` (`worker/jobs.ts:61-85`) ni la UI lo usan (solo aparece como valor inicial en `src/App.tsx:75`).

Propuesta:

- En `enqueue`, para `autotag`/`lens`: si `!capabilities(env).jev`, rechazar el pedido completo con “Jev no está configurado (falta la API key)”. Es una condición global, así que rechazar todo es correcto.
- En la UI, deshabilitar Auto-tag, Lens y Re-evaluate con ese mismo motivo en el tooltip, usando `library.capabilities.jev`.
- Mantener el chequeo dentro del job como defensa (la key puede cambiar entre encolar y correr), pero **antes** de `measured()`, para no ensuciar Usage.
- Límite conocido: con el proveedor `cloudflare`, `capabilities.jev` solo verifica que exista el binding `AI`; el saldo no se puede verificar antes. Ese caso lo cubre el corte por batch (punto 6 de §8.3).

### 8.3c Muro de login, Dismiss y “preview como contenido”

- **Muro de login o bloqueo detectado en el contenido extraído:** el texto **se descarta** (no se guarda en R2 ni cambia `content_key`).
  - Sin contenido previo: `content_state` queda sin contenido, con `attention_kind='blocked'` y el mensaje “Se obtuvo una página de login, no el contenido”.
  - Con contenido previo: se mantiene la versión anterior y el fallo queda en Activity.
  - El preview (título, descripción, imagen) se conserva.
- **Dismiss** solo saca el link de la lista (`attention_kind = NULL`) y no cambia nada más. Un fallo final posterior vuelve a levantar la marca. Sin contenido, Jev sigue sin poder correr en ese link.
- **Fallback “contenido desde el preview”** (decidido, §8.8):
  - **Cuándo aplica:** solo cuando la extracción del contenido terminó en fallo final (reintentos agotados, bloqueo o muro de login) **y** el preview sí se obtuvo. Nunca mientras el link está en cola, procesándose o esperando. Si también falló el preview, no hay nada que usar y el link entra en Needs attention normalmente.
  - **Dos formas de activarlo:**
    - **Global**, en un panel de Configuración nuevo (tabla `settings`, ya existe en `migrations/0003`): “Si no se puede obtener el contenido, usar el preview para Jev”. Apagado por defecto. Se aplica automáticamente en el paso de fallo final.
    - **Por link**, como acción junto a Dismiss en la fila de Needs attention.
  - **Qué guarda:** título + descripción como contenido, con `content_source='preview'` y `content_state='partial'`. Jev recibe **solo ese texto**. La etiqueta “Contenido obtenido del preview” **no** forma parte del texto enviado a Jev: se deriva de `content_source` y es solo para el usuario (el inspector ya etiqueta por fuente, `Inspector.tsx:64-72`).
  - **Qué ve el usuario:** en el inspector, “Contenido obtenido del preview” más el botón **“Reintentar obtener contenido”** (corre una extracción normal; si funciona, reemplaza el fallback). Los resultados de Jev **no** llevan ninguna marca especial.
  - **Lista:** con contenido de fallback, el link sale (o no entra) en Needs attention, porque ya tiene un camino de uso. El motivo original del fallo queda en Activity.

### 8.4 Cancelar un link individual

`DELETE /api/jobs/:id`:

- **`queued`/`waiting`:** se marca `Cancelled`.
- **`running`:** `PROCESS_LINK.get(id).terminate()` y luego `Cancelled`. Se restaura `content_state` con `preservedContentStateSql("missing")`, se libera el lease y no se toca `attention_*`.

Los dependientes en `waiting` del mismo link se cancelan en cascada (decidido: si se cancela la extracción, se cancela todo lo que depende de ella). Lo mismo aplica al cancelar un batch de extract. Una llamada paga en vuelo puede cobrarse igual: `recover()` ya la registra como `failed` (`jobs.ts:115`).

### 8.5 Telemetría

`observability.enabled` ya está activo (`wrangler.jsonc:30`). Se emite un `console.log` JSON por intento fallido: `{event:"link_step_failed", step, attempt, final, reason, http_status, content_type, domain, adapter}`. Solo el dominio, sin la URL completa. Sirve para medir la demanda de PDFs, los sitios con muros y la tasa de 429.

### 8.6 Orden sugerido (cada parte se puede entregar sola)

1. Quitar el `failed` virtual de 30 s y dejar neutros los cancelados. Ataca directamente el síntoma reportado.
2. Validar la configuración de Jev al encolar y en la UI (§8.3b). Es chico, evita trabajo inútil y no depende de nada.
3. Clasificación de motivos (incluye 401/403 y anti-bot, que fallan rápido), reintentos del preview y del Markdown, intento visible en Activity, telemetría.
4. `attention_*` persistido, con Retry del paso fallido (preview por la cola), Dismiss y “usar el preview como contenido” por link. El panel de Configuración con el fallback global puede ir acá o en una parte propia justo después.
5. Cola serial por link para Jev, validación por link, reintentos de Jev según la fase y corte por batch.
6. Cancelación por link en Activity, con cascada.
7. Detección de muro de login (descartar el texto), calibrada con los datos de telemetría de la parte 3.

### 8.7 Decisiones de la segunda ronda (2026-10-01)

1. **401/403 y anti-bot: falla rápido, sin reintentos.** Si había contenido previo, se muestra la versión anterior con el motivo del fallo (“el sitio bloquea el acceso automático”), que queda en el historial de Activity. Si no había contenido, entra en Needs attention con ese motivo. El usuario puede reintentar más adelante.
2. **Reintentos de Jev según la fase:**
   - **Antes de enviar:** solo en casos borde conocidos.
   - **Después de enviar:** nunca automático. Si la API de Jev falla, no se reintenta y se avisa.
   - El usuario siempre puede reintentar a mano.
   - Implementación en §8.3, punto 5.
3. **Sin API key, nada debe llegar a correr:** validar antes de encolar y en la UI (§8.3b). Reproducido: hoy se acepta y falla link por link.
4. **Muro de login:** se descarta el texto y se muestra “se obtuvo una página de login”. Cuenta como sin contenido; el preview se conserva.
5. **Dismiss** solo saca el link de la lista. Junto a Dismiss puede ofrecerse “usar el preview como contenido”, opcionalmente también como configuración global, para habilitar Jev (§8.3c). Las dos acciones lo sacan de la lista.
6. **Cancelar una extracción cancela todo lo que depende de ella** (los Jev en espera de ese link).

**Ticket futuro, fuera de FAC-48 (a redactar después):** obtener el contenido con la extensión del navegador del usuario, para esquivar bloqueos anti-bot y leer páginas que requieren login. Antecedente técnico: la extensión ya captura Markdown de pestañas para los lenses de Browser (`browser_targets`, `worker/browser.ts`). Habría que reutilizar esa captura como fuente de contenido de un link guardado, con consentimiento explícito.

### 8.8 Decisiones de la tercera ronda (2026-10-01)

1. **Reintentos antes de enviar a Jev: mínimos.** Solo R2 `get` con error transitorio y conflicto o timeout de D1, con **1 reintento** (dentro del tope de 2 decidido antes). Nada más hasta tener telemetría.
2. **Detector de muro de login:** arranca con la heurística propuesta (texto corto más patrones: “sign in”, “log in to continue”, “captcha”, “Just a moment”, “Access denied”, “verify you are human”), solo en el adapter web. Cada detección emite telemetría (`event:"login_wall_detected"`, dominio, patrón que coincidió, largo del texto) para medir la frecuencia y los falsos positivos, y reevaluar si hay muchos casos.
3. **Fallback “contenido desde el preview”:** configuración global en un panel de Configuración nuevo, más la acción por link. Solo aplica ante fallo final de la extracción del contenido. El contenido se identifica como “Contenido obtenido del preview”, con la opción “Reintentar obtener contenido”. Esa etiqueta no se envía a Jev y los resultados de Jev no llevan marca (§8.3c).

**Ideas para después (fuera del alcance inicial de FAC-48):**

- **Marcar contenido como inválido:** acción del usuario que borra el contenido guardado (R2 y `content_key`), deja el link sin contenido y registra un evento con el dominio y el motivo. Sirve como telemetría para mejorar el detector.
- **Control de calidad con Jev:** durante el autotag, una pregunta extra que evalúe si el contenido es una extracción fallida (login, bloqueo, página vacía). Tiene costo por link; conviene evaluarlo solo si la heurística resulta insuficiente.
- **Extensión del navegador como fuente de contenido** (ticket aparte; ver §8.7).

Con esto no quedan decisiones de diseño abiertas para FAC-48. Lo que falta definir es de implementación: textos finales de la UI, nombres de columnas y migración.
