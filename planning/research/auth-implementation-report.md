# FAC-40 + FAC-41 — Reporte de implementación

**Fecha:** 02-10-2026. **Rama:** `facundoPri/research-auth-cloudflare` (sin push ni PR). **Base previa a implementación:** `4d23fe1e5d67a67ad6a00bed120faab79269b46d`. **Base de integración:** `main` `32fc90f40c6f136e8038aafa0a143404e531d0f4` (PR #4 Browser/extensión), integrada por merge local. **Snapshot de código aprobado por el reviewer:** `a8a1f628c77862a83bd8a235048ca4b15e091509`. El commit que agrega este cierre documental es posterior y no cambia código.

Entrega única para FAC-40 (autenticación) y FAC-41 (datos privados por usuario), con la capa HTTP migrada a Hono por decisión del dueño. Todo se probó **localmente** (Bun + workerd/Miniflare + Chromium de Playwright). No hubo despliegue, correo real, D1 remota ni adjudicación de datos reales.

Cómo leer este documento: **§0 es el estado vigente**. Las secciones 1–5 describen arquitectura y esquema, actualizadas donde una ronda cambió una garantía. Lo marcado **Histórico** conserva la evidencia de la entrega inicial (`73bf125`). El detalle por finding (R1–R10, antes/después) está en [auth-fix-report.md](auth-fix-report.md). El review y la validación independientes están en [auth-code-review.md](auth-code-review.md) y [auth-validation-report.md](auth-validation-report.md).

## 0. Estado vigente (snapshot `a8a1f62`)

### Garantías

- **Auth:** Better Auth 1.7.7 sobre D1 nativo. Email + contraseña con verificación obligatoria, magic link de 5 min y un uso, reset que revoca sesiones, sesiones en D1 sin cookie cache. CSRF/origin activos y `trustedOrigins` exacto. Config fail-closed: 503 si falta o es débil, 403 para un host ajeno.
- **HTTP:** Hono 4.13.12. `/api/auth/*` recibe el `Request` crudo antes de cualquier parser. El resto de `/api` es privado por defecto: same-origin JSON, sesión → `Principal`, cuota de escrituras y body ≤ 2.1 MB **contado en bytes** del stream.
- **Datos por dueño:** todas las tablas de biblioteca y Browser tienen dueño. Cada query filtra por `user_id` de la sesión; un id ajeno, heredado o borrado responde 404/409 sin revelar al dueño. Hay triggers de dueño requerido, dueño inmutable y relaciones del mismo dueño. Las claves R2 llevan el prefijo del usuario. Queue/Workflow/cron resuelven el dueño desde el batch persistido.
- **Datos previos:** quedan sin asignar e invisibles hasta la adjudicación local explícita. Nunca se asignan al primer signup. El `library_id` heredado va a un único dueño (índice único, migración 0014).
- **Cuotas:** cada contador es un UPSERT atómico **por clave** en D1. `charge()` consume varias claves en secuencia y compensa las tomadas si una no alcanza: todo-o-nada **por compensación**, no una transacción multi-cuota. Los reembolsos ocurren en la misma ventana. Browser comparte `jobs:<user>` con la biblioteca.
- **Alta/import/Browser save:** las cuotas se admiten antes de escribir. Los links nuevos, su batch de extracción, sus jobs y el `content_state` se escriben en **un** `D1.batch`, que D1 ejecuta como transacción: un fallo no deja nada y devuelve la cuota. Cada sentencia enlaza una cantidad constante de parámetros, así que 1–100 URLs entran en una sola transacción. Un link sin contenido ni jobs (de una operación interrumpida anterior) recibe una extracción al volver a guardarse, una sola vez. **D1 + Queue no es atómico:** tras el commit, el envío a Queue es best effort, con D1 como outbox y `recover()` por cron.
- **Logout:** primero se cierra la sesión en el servidor. Solo si lo confirma (o responde 401) se ejecuta el `forget` de la extensión, la limpieza local y la recarga. Ante HTTP o red fallidos no se toca nada: sesión, bridge, cache y metadata quedan, y aparece un error con **Retry**.
- **Extensión:** resultados, requests y metadata de grupos (descripción, pin, hints de reinicio) se **leen filtrados por el scope de la cuenta** (`library_id` único, aleatorio, entregado solo a la sesión dueña). Otra cuenta del mismo perfil no los ve aunque `forget` no haya corrido. El scope es secreto, no prueba de identidad. Tabs y grupos nativos de Chrome son del perfil.
- **Fixtures:** Test Utils y las credenciales demo quedan **fuera** del bundle (`tests/bundle.test.ts`, `scripts/build.ts`). El provider Jev fixture **sí** está en el bundle y falla cerrado fuera de local/test por guard de runtime (`fixtureJevAllowed`, también en Queue/Workflow). No hay usuario por defecto ni bypass.

### Gates verificados (resultados reales, por snapshot)

| Gate | Resultado | Snapshot del código probado |
| --- | --- | --- |
| `bun run typecheck` (raíz, protocolo, extensión) | OK | `d433a8a` (= código de `a8a1f62`) |
| `bun test` | **198 pass, 0 fail**, 27 archivos; el shim aplica el límite D1 de 100 parámetros | `d433a8a` |
| `bun run test:e2e` (workerd + D1/R2/Queue/Workflow locales vía proxy; UI 3197 / API 8897; estado tmp) | **12/12**: auth completa, A/B, Browser A/B, atomicidad del import con fallo inyectado, import de 100 y save de 97 | `d433a8a` |
| `bun tests/browser/run.ts` (Chromium de Playwright 1243 + extensión real; UI 3010 / API 8790) | **45/45**, incluye logout refused (503) → estado y bridge intactos → Retry → cuenta B sin fuga | `531782f`. R10 (`c558f58`) cambió solo `worker/links.ts`, `worker/jobs.ts` y `worker/routes/activity.ts`, no extensión/UI/auth; no se repitió por indicación del coordinador |
| Validación independiente | Luna (`auth-validation-report.md`) y veredicto **APPROVED** del reviewer sobre `a8a1f628c77862a83bd8a235048ca4b15e091509` | según esos informes |

### Commits de la entrega (sobre `4d23fe1`, primer padre)

`2427b71` auth · `635e5bb` ownership · `79d2dda` UI · `eb88989` dev/demo · `04e914a` tests · `d1de00d` merge de main + Hono + Browser privado · `d06a0b2`, `73bf125` tests Browser · `50c6030` docs · ronda 1: `9733db6` (R2), `98a55df` (R1/R8), `9b93a1d` (R4), `081e9eb` (R5), `1b87290` (R6), `d1663cc` (R3/R7), `aa16ff9`, `e965bf8` · ronda 2: `ea5b75c` (R9), `f2fb5db` (R3), `11a3611`, `531782f`, `9dd9fee` · ronda 3: `c558f58` (R10), `d433a8a`, `a8a1f62`.

### Demo local y extensión

- `bun run demo` → http://127.0.0.1:3100 (API 127.0.0.1:8800, estado `.wrangler/demo-state`, bindings solo locales). Crea `demo-a@linklog.test` y `demo-b@linklog.test` con el flujo real. El email es **simulado** (archivos bajo `.wrangler/tmp/email/`). En el primer minuto tras sembrar, un login manual puede recibir 429 (límite de 5 sign-ins/min por IP).
- Extensión, según la **configuración inspeccionada** (no es una prueba nueva con la demo 3100): el bridge corre en páginas que se identifican como Linklog sobre `http://localhost` o `http://127.0.0.1` **en cualquier puerto** (`packages/browser-protocol/src/keys.ts`, `LOCAL_BRIDGE_MATCHES`/`isBridgeOrigin`). Basta abrir la demo directamente. Para que el botón "Open Linklog" del popup apunte a la demo: `LINKLOG_UI_PORT=3100 bun run extension:build`, recargar la extensión y después la página (`scripts/ports.ts:linklogUrl`, `apps/extension/scripts/build.ts`). Un dominio desplegado se agrega con `LINKLOG_ORIGINS=https://… bun run extension:build`.

### Checklist del dueño

- [ ] Arrancar `bun run demo` (puertos y estado de arriba) y comprobar que no usa datos reales.
- [ ] Sin login: la app muestra el login; GET, escrituras y contenido de `/api` responden 401 sin datos.
- [ ] Alta con email + contraseña → aviso "Check … for a confirmation link" visible → verificar desde el email simulado → entrar. Los errores y el reenvío tienen mensajes utilizables.
- [ ] Magic link: entrar una vez; reusarlo o usarlo vencido se rechaza.
- [ ] "Forgot password" → reset: la contraseña anterior deja de servir, las otras sesiones se cierran y el enlace no se reutiliza.
- [ ] Recargar y reabrir: la sesión persiste. **Logout con fallo:** en DevTools, bloquear o fallar `POST /api/auth/sign-out` (503 o sin red) → aparece el error con **Retry**; la sesión sigue activa y, en Browser, la extensión sigue conectada con sus resultados y la descripción de grupos intactos. Con Retry exitoso: pantalla de login y la cookie anterior recibe 401.
- [ ] Dos cuentas A/B (perfiles o contextos separados): la misma URL, tag y lens en cada una son independientes. Los IDs ajenos en lectura, edición, borrado, contenido, tags/lenses, lotes/cancelación/jobs y uso se rechazan sin filtrar datos.
- [ ] Procesar y reintentar enlaces: resultados, archivos R2, jobs y uso quedan en la cuenta correcta.
- [ ] **Import en el límite:** importar 100 URLs nuevas → éxito, un job por link. Reimportar → todo duplicado, sin cobro ni jobs nuevos. 101 URLs se rechaza por contrato. Con la cuota agotada: 429 sin filas parciales. Revisar las regresiones de rollback con fallo inyectado, reembolso de cuotas, dedupe concurrente, Queue caída y recuperación del outbox (`tests/link-atomicity.test.ts`, `tests/link-bindings.test.ts`, E2E 6c/6d).
- [ ] Browser/extensión con A y B en el mismo perfil: evaluar, re-evaluar, guardar tabs, grupos (con descripción), polling y cancelación. Al cambiar de cuenta no reaparecen resultados ni descripciones de pins de la otra. El `library_id` de una cuenta no da acceso a la otra.
- [ ] Revisar en Hono que las rutas públicas y privadas estén agrupadas y que una ruta nueva quede bajo el middleware privado con autorización por dueño en la query.
- [ ] Confirmar que producción/previews no tienen usuario por defecto ni bypass, que Test Utils y demo quedan fuera del bundle y que el fixture Jev falla cerrado (guard de runtime).
- [ ] Antes de adjudicar links antiguos: `legacy:adjudicate inventory` → `backup` → elegir el dueño verificado → `assign --dry-run` sobre una **copia** → revisar conteos y rollback. Ningún signup reclama datos.
- [ ] Revisar versiones fijadas (Better Auth 1.7.7, Hono 4.13.12), dominio y orígenes, secretos fuera de Git y límites de abuso.
- [ ] **Antes de desplegar (requisito operativo pendiente, no aprovisionado ni aprobado):** confirmar el plan de Workers/D1 y el presupuesto de consultas. La tabla de [límites D1](https://developers.cloudflare.com/d1/platform/limits/) publica *Queries per Worker invocation* = 1000 en Workers Paid y 50 en Free (acceso 02-10-2026). Es una métrica distinta del límite de *subrequests* de Workers ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests): Paid 10000, Free 50, y 1000 para servicios internos en Free). Un import de 100 URLs ya hace 100 lecturas explícitas de dedupe antes del batch, más de 50. No hay conteo remoto medido. Que el producto sea gratis para los usuarios no define el plan de infraestructura.
- [ ] En el entorno desplegado autorizado: DNS y correo real (entregabilidad), cookies HTTPS, todos los dominios y previews, aislamiento A/B. La simulación local no prueba nada de eso.

No se exige aquí FAC-44/API keys, billing/planes, login social, passkeys, sharing ni MCP.

### Límites vigentes

- **Sin validación remota:** dominio, Email Service, D1/R2 remotas, secretos, edge (`cf-connecting-ip`, cookies `__Secure-`), `workers.dev` y previews. Runbook en §9 (histórico, sigue válido).
- **Heredado de main, fuera de esta PR:** `POST /api/browser/evaluations/:id/ack` y `DELETE /api/browser/evaluations/:id` con 100 targets enlazan 101–102 parámetros, y la limpieza de media en `worker/handlers/extract.ts` enlaza `link_id` + la cantidad de media. Pueden exceder el límite de 100 parámetros de D1. Esta entrega no los valida.
- `forget` es limpieza de buen esfuerzo (tope de 1.5 s; una extensión vieja no lo ofrece). La privacidad entre cuentas viene de las lecturas por scope, no de esa limpieza.
- La API es privada por defecto: una ruta desconocida da 401 sin sesión y 404 con sesión.
- Fuera de alcance: FAC-44/API keys, billing, passkeys, Google/GitHub, login con Cloudflare, sharing, MCP, nuqs.

## 1. Commits (histórico, entrega inicial)

| Commit | Contenido |
| --- | --- |
| `2427b71` | Better Auth 1.7.7 sobre D1 nativo, factory por entorno, config fail-closed, email (Cloudflare `send_email`) y límites. |
| `635e5bb` | FAC-41: propiedad por usuario en todos los datos de biblioteca, migración, triggers, herramienta de adjudicación. |
| `79d2dda` | UI: pantallas de auth, gate de sesión, proxy local same-origin. |
| `eb88989` | Dev: stacks locales aislados y fixtures A/B. |
| `04e914a` | Tests: flujos auth, aislamiento A/B, migraciones, proxy, bundle y e2e (evidencia inicial sobre `4d23fe1`: 91 tests + e2e 9/9; **histórica**, no prueba el estado actual). |
| `d1de00d` | Merge de `main` 32fc90f: Hono, Browser privado por cuenta, migraciones renumeradas 0012/0013, `forget` en la extensión, scripts/tests actualizados. Padres: `04e914a`, `32fc90f`. |
| `d06a0b2` | Test Browser: imprime el directorio de evidencia realmente usado. |
| `50c6030` | Este reporte, README (cuentas/privacidad, demo, límites de Cloudflare) y decisiones posteriores en `auth-cloudflare.md`. |
| `73bf125` | Check de cambio de cuenta en Chrome real (`forget` al cerrar sesión) y clasificación de pruebas en este reporte. |

El merge integra en un solo commit la resolución de conflictos y lo que esa resolución exige (Hono reemplazó al router propio en `worker/index.ts`, y el esquema Browser necesitaba dueños para compilar y migrar). Dividirlo habría requerido reescribir un router intermedio que no se iba a usar.

## 2. Arquitectura

### HTTP (Hono 4.13.12)

`worker/index.ts` exporta `{ fetch: app.fetch, queue, scheduled }` y `LinkWorkflow`. `worker/http/app.ts` arma la app en este orden:

1. `app.use("/api/*", withConfig)`: lee y valida la config **por request** (`readConfig`, fail-closed → 503), comprueba el host (403) y crea una instancia de Better Auth por request ligada a `env` y `executionCtx` (sin sesiones ni instancias globales).
2. `app.on(["GET","POST"], "/api/auth/*", c => auth.handler(c.req.raw))`: Better Auth recibe el `Request` sin consumir, antes de cualquier parser o protección privada. Otros métodos → 405. Los endpoints fuera de alcance (social, update-user, delete-user, etc.) están en `disabledPaths` → 404.
3. Grupo privado `app.route("/api", privateApi)`: privado **por defecto**. Usa `sameOriginWrites` (Origin exacto = `BETTER_AUTH_URL`, `Sec-Fetch-Site` same-origin si viene, `Content-Type: application/json` → 403/415), luego `requireSession` (sesión D1 → `Principal { kind: "session", userId, sessionId }` en `c.var.principal`; sin ella → 401) y por último `writeQuotaAndBody` (cuota de escrituras por usuario y JSON objeto ≤ 2.1 MB, contados en **bytes** del stream desde la ronda de review (R5)). Rutas por módulo: `worker/routes/{links,taxonomy,activity,browser}.ts`. Una ruta desconocida responde 401 sin sesión (no permite descubrir rutas) y 404 con sesión.
4. `app.all("*")` → `ASSETS` (shell SPA pública, sin datos).
5. `onError`: `HttpError` (status + `code`), `LimitError` → 429, errores D1/trigger → 500 genérico, validación → 400. No se loguean cuerpos, tokens ni cookies.

`AppEnv = { Bindings: Env; Variables: { config, auth, principal, body } }`. La autorización por dueño **no** depende del middleware: cada query lleva `user_id` (ver §3). FAC-44 podrá añadir `Principal { kind: "apiKey", … }` en su propio grupo con su política, sin tocar las rutas de sesión. No se implementó nada de FAC-44.

### Auth (Better Auth 1.7.7, D1 nativo)

- `worker/auth.ts` `authOptions(config, db, mailer, waitUntil)` es compartido por producción y por la instancia de tests. Solo los tests añaden Test Utils (`tests/support/auth.test-instance.ts`). `tests/bundle.test.ts` verifica que el bundle del Worker no lo incluya.
- Email + contraseña (10–128 caracteres) con verificación obligatoria (`sendOnSignUp`/`sendOnSignIn`, auto sign-in tras verificar). Magic link de 5 min, de un solo uso y con token hasheado. Reset de 1 h que revoca las demás sesiones. Logout.
- Sesiones en D1: 7 días, `updateAge` 1 día, **sin cookie cache**, así que la revocación se nota en el siguiente request. Cookies `linklog.*`: `__Secure-` y `Secure` fuera de local/test; HttpOnly, SameSite Lax.
- `trustedOrigins = [BETTER_AUTH_URL]`. `disableCSRFCheck`/`disableOriginCheck` se fijan explícitamente en `false`. IP desde `cf-connecting-ip`. Rate limit de Better Auth con `storage: "database"` (tabla `rateLimit`) y reglas estrictas para sign-in/up/magic/reset/verification.
- `worker/config.ts` hace fail-closed: `APP_ENV` ∈ local|test|preview|production (wrangler.jsonc trae `production` por defecto); `BETTER_AUTH_URL` debe ser un origen pelado, HTTPS público fuera de local y loopback en local; secreto ≥ 32 caracteres que no sea de desarrollo; binding `EMAIL` presente; `EMAIL_FROM` válido. **Nuevo:** `JEV_PROVIDER=fixture`/`ALLOW_FIXTURE_JEV` solo en local/test. Desde la ronda de review (R4), `judge()` aplica la misma regla (`fixtureJevAllowed`) donde corre el provider, incluido Queue/Workflow. El código del fixture está en el bundle; su exclusión fuera de local/test es ese guard de runtime.
- Email (`worker/email.ts`): Cloudflare `send_email` (`EMAIL`) en `waitUntil` (timing parejo), con límite por destinatario (hash) de 5/h y diario global (`AUTH_EMAIL_DAILY_LIMIT`, por defecto 200). Logs solo de `kind` y resultado. En local, Wrangler **simula** el envío (archivos en `.wrangler/tmp/email/`).
- Límites de app (`worker/limits.ts`): contadores atómicos en D1 (un UPSERT…RETURNING) para links por usuario, jobs por usuario y escrituras por minuto. Desde la ronda de review, `charge()` consume varias claves en secuencia y compensa las tomadas si una no alcanza (no es una transacción multi-cuota), y devuelve lo no usado en la misma ventana. Alta, import y Browser save (`addLinks`) cobran links + jobs **antes** de guardar (R8) y escriben links + batch + jobs en **un** `D1.batch` transaccional; un fallo no deja nada y devuelve la cuota (R9). La Queue posterior es best effort, con D1 como outbox y `recover()`. Cada sentencia enlaza una cantidad constante de parámetros (D1: máximo 100 por sentencia, también dentro de batch), así que import y save de hasta 100 URLs entran en una sola transacción (R10, ronda 3). Las evaluaciones Browser comparten `jobs:<user>` con la biblioteca (R1). Hay tests de concurrencia (30 paralelos → exactamente 10) y un e2e (10 sign-ins concurrentes → exactamente 5 en D1 real local).

### Frontend

`src/Root.tsx` es el gate de sesión. `App` se monta con `key={user.id}`: al cambiar de cuenta se descarta todo el estado. Cualquier 401 (`src/api.ts`, `src/browser/api.ts`) dispara `refetch` y vuelve a la pantalla de login. `signOutAndReset()` primero cierra la sesión en el servidor. Solo si lo confirma (o responde 401) ejecuta los hooks `onSignedOut` (Browser → `forget` en la extensión, tope 1.5 s), borra `localStorage` `linklog.*` y `sessionStorage` y recarga. Si falla, no limpia nada, el bridge sigue conectado y muestra el error con Retry (R3, ronda 2). El gate mantiene AuthScreen montado durante el refetch anónimo posterior al alta (R7). Browser registra un hook que pide a la extensión `forget` (ver §3).

## 3. Propiedad de datos (FAC-41) y esquema

### Migraciones

Base de main: `0010_browser_targets`, `0011_jobs_target_index`. Esta entrega las conserva y agrega:

- `0012_auth.sql`: tablas Better Auth (`user`, `session`, `account`, `verification`, `rateLimit`), `app_rate_limits` y `user_settings (user_id, key)`. Generado con `scripts/auth/print-schema.ts` (getMigrations) y revisado.
- `0014_unique_library_id.sql` (ronda de review, R6): índice único de `library_id` por cuenta; deduplica copias previas conservando la primera.
- `0013_ownership.sql`:
  - **Reconstruidas** (para pasar la unicidad de global a por dueño): `links` (`UNIQUE(user_id, original_url)`), `tags` y `lenses` (`UNIQUE(user_id, name NOCASE)`, `lenses.scope` conservado), y todo lo que cuelga de ellas: `link_tags`, `jobs` (`link_id` y `target_id` nullable con `CHECK` exclusivo), `tag_evaluations`, `lens_results`, `usage_events` (`user_id` propio), `provider_leases`, `media_items` y `hidden_related_links`. Se usan copias `*_next` que referencian solo padres `*_next`; se borran hijos antes que padres y se renombra al final, porque D1 no permite apagar FKs y `DROP` de un padre dispara cascadas. Un test verifica que el esquema final no referencie tablas `*_next`/`*_prev`.
  - **`ALTER TABLE … ADD COLUMN user_id`** (nullable): `batches`, `browser_requests`, `browser_groups`. Los índices de main (`jobs_active_link`, `jobs_active_target`, `jobs_target`, `browser_targets_request`) se conservan o se recrean.
  - **Triggers como defensa en profundidad:** dueño requerido en inserts; dueño inmutable una vez asignado (la adjudicación solo llena NULL); relaciones del mismo dueño (`link_tags`, `jobs` para link **o** target, `tag_evaluations`, `lens_results`, `usage_events`, `browser_requests`↔`batches`, `browser_targets` con request con dueño, `media_items`, `hidden_related_links`).
- Datos existentes: todos los IDs, relaciones, valores y claves R2 se conservan con `user_id NULL`, así que quedan **sin asignar e inaccesibles**. Nada se asigna al primer signup ni a fixtures.

### Consultas y procesamiento

- Toda ruta resuelve el dueño desde `Principal`, nunca desde el body (hay un test que inyecta `user_id`). `getOwnedLink`, `ownedBatch` y los lookups de lens/tag/grupo/request llevan `AND user_id=?`. Un ID ajeno, heredado o borrado responde igual: 404.
- Dedupe e import por dueño (`addLink(env, userId, url)`, `INSERT … WHERE NOT EXISTS(… user_id=?)`).
- R2: el contenido nuevo va en `users/<userId>/links/<linkId>/…` y solo se lee desde una fila propia cuyo `content_key` cae bajo su prefijo (o el prefijo legado `links/<id>/` de esa misma fila). Las capturas Browser van en `users/<userId>/browser/<requestId>/…`.
- Queue/Workflow/cron: `loadOwnedJob` resuelve el dueño desde `batches.user_id` persistido y carga link o capture **solo** de ese dueño. Un batch sin dueño no corre y `recover` lo ignora. El uso (`measured`) toma `user_id` del batch.
- Browser: `library_id` por cuenta en `user_settings` (la extensión agrupa sus resultados por ese id). `catalog`, grupos, lenses, evaluaciones (`GET`/`ack`/`DELETE`), `save` y estado van por dueño. Reusar un `requestId` o un id de grupo ajeno → 409 `conflict`, sin revelar a quién pertenece. Un lens ajeno → 404 `lens-missing`. El `libraryId` de otra cuenta → 409 `library-mismatch`. `cleanupBrowser` (retención) sigue siendo un barrido global por tiempo y no expone nada.
- Extensión: comando aditivo `forget`, ofrecido como capability en `hello` y sin cambio de `PROTOCOL_VERSION`. Borra resultados, requests y (desde R2) la metadata y los hints de grupos del scope de la conexión, y termina el handshake. **La garantía no es `forget`:** resultados y metadata de grupos (description, pin, hints de reinicio) se leen filtrados por el scope de la conexión, así que otra cuenta del mismo perfil no los ve aunque la sesión expire o la extensión se reinicie. Los grupos y tabs nativos de Chrome no cambian.
- Preferencias: `user_settings`. La tabla global `settings` heredada queda sin leer hasta la adjudicación.

### Rollback

- Preferido: restaurar el backup previo (local: `legacy:adjudicate backup`; remoto: D1 Time Travel/export).
- `scripts/migrations/rollback/0013_ownership.down.sql`: vuelve al esquema de main (unicidad global, `lenses.scope`, jobs target). Solo es seguro con un único dueño: si dos dueños comparten URL o nombre, aborta de forma atómica. Pone `user_id` en NULL en `batches`/`browser_*`, de modo que un `0012_auth.down.sql` posterior no borre filas en cascada (cubierto por un test).
- `0012_auth.down.sql`: opcional. Elimina cuentas y sesiones; la biblioteca no se toca.

## 4. Herramienta de adjudicación (solo local)

`bun run legacy:adjudicate <cmd> --state-dir <dir>` (`scripts/adjudicate-legacy.ts`). **No se ejecutó sobre datos reales.**

1. Detener `bun run dev`.
2. `inventory`: muestra conteos de filas sin dueño (links, tags, lenses, batches, usage, `browser_requests`/`browser_targets`/`browser_groups`, derivados, links con R2, settings) y la lista de usuarios (id, email, verificado, fecha).
3. `backup`: copia completa del state dir (D1 + R2 + secreto local) a `<dir>.backup-<timestamp>`. Se niega a correr si la base está abierta.
4. Elegir el dueño: el usuario **verificado** que corresponde a la persona dueña de la biblioteca local (por email, confirmado por el dueño; nunca "el primero").
5. `assign --user-id <id> --email <email> --dry-run`: valida que id y email coincidan, que el usuario esté verificado y que no haya conflictos (URL o nombres ya usados por ese usuario). Muestra conteos antes, movidos y después, y no escribe nada.
6. `assign …` sin `--dry-run`: hace todo en una transacción `BEGIN IMMEDIATE`. Copia `settings` a `user_settings`. El `library_id` heredado (el scope de la extensión) va **solo** al usuario que recibe filas heredadas en esa ejecución y solo si nadie lo tiene; tras R6, un segundo `assign` a otro usuario no lo comparte, verifica que no queden relaciones cruzadas y que los conteos coincidan, corre `PRAGMA foreign_key_check` y hace COMMIT; ante cualquier duda, ROLLBACK.
7. Para revertir: restaurar el backup del paso 3.

Para D1 remota no hay herramienta, y asignar requiere una decisión explícita del dueño. El procedimiento equivalente sería export → ensayo sobre copia local → `UPDATE … WHERE user_id IS NULL` revisado → verificación.

## 5. Desarrollo y demo A/B

| Uso | Comando | UI | API | Estado |
| --- | --- | --- | --- | --- |
| Dev normal | `bun run dev` | http://127.0.0.1:3000 | 127.0.0.1:8787 (inspector 9787) | `.wrangler/state` (o `LINKLOG_PERSIST_TO`) |
| Demo A/B | `bun run demo` | http://127.0.0.1:3100 | 127.0.0.1:8800 (inspector 9800) | `.wrangler/demo-state` |
| E2E auth | `bun run test:e2e` | http://127.0.0.1:3197 | 127.0.0.1:8897 | tmp descartable (`$TMPDIR/linklog-e2e-*`) |
| Browser real | `bun run test:browser` | http://127.0.0.1:3010 | 127.0.0.1:8790 | `.cache/browser-test/state` |

- La demo crea `demo-a@linklog.test` / `demo-b@linklog.test` con el flujo real (sign-up → email simulado → verificación) y datos de muestra con la misma URL, tag y lens en ambas cuentas. Es idempotente. Se niega a sembrar `.wrangler/state` o un host no loopback. Usa bindings solo locales (`LINKLOG_WRANGLER_LOCAL=1`). Las credenciales demo solo se inyectan en la UI de la demo; `scripts/build.ts` se niega a compilar con ellas, así que nunca llegan a `dist/`.
- Verificado el 02-10-2026 con un state dir nuevo (`LINKLOG_PERSIST_TO=.cache/demo-check bun run demo`): A y B ven la misma URL, el mismo tag y el mismo lens, cada uno con su link privado. El seeding usa 4 sign-ins desde 127.0.0.1, así que un login manual en el primer minuto puede recibir 429 (límite de 5 sign-ins/min por IP, a propósito).
- La sesión persiste entre reinicios: el secreto local se genera una vez por state dir (`linklog-auth-secret`, modo 600, fuera de Git) y el e2e prueba el reinicio.
- Los puertos ocupados no se matan: `runStack` aborta y pide otro puerto.
- No existe usuario por defecto ni bypass. Test Utils y credenciales demo quedan fuera del bundle (test de bundle, `scripts/build.ts`). El fixture Jev sí está en el bundle, con guard de runtime fuera de local/test (ver §0).

## 6. Histórico: comandos y resultados de la entrega inicial (`73bf125`)

> Resultados de la entrega inicial, previos a las rondas de review. Los gates vigentes están en §0.

| Comando | Resultado |
| --- | --- |
| `bun run typecheck` (raíz + protocolo + extensión) | OK |
| `bun test` | **157 pass, 0 fail** (22 archivos: auth, isolation, migración/rollback/adjudicación con datos Browser, rutas Browser vía Hono con A/B, retención, proxy, bundle, extensión con `forget`, protocolo, etc.) |
| `bun run test:e2e` (workerd + D1/R2/Queue/Workflow locales, a través del proxy) | **E2E OK, 10/10**: sign-up → login no verificado rechazado → verificación → sesión vía proxy; sesión tras reinicio del Worker; magic link de un uso; Origin ajeno rechazado (app y Better Auth); A/B misma URL/tag/lens con 404/400 en IDs ajenos; workflow sin filas cruzadas, R2 con prefijo de dueño, uso por dueño; **Browser A/B** (library id por cuenta, captura de A evaluada por Queue/Workflow con Jev fixture, B recibe 404/409 en request/lens/grupo, uso por dueño, snapshot borrado al confirmar); reset que revoca sesiones y logout; rate limit concurrente (exactamente 5 de 10); logs del Worker sin passwords, tokens ni cookies. |
| `CHROME_PATH=<Chromium de Playwright 1243> LINKLOG_BROWSER_EVIDENCE=.cache/browser-validation-auth bun run test:browser` (extensión real, sesión real de una cuenta local creada por sign-up + verificación) | **45/45** (02-10-2026, después de agregar el check de cambio de cuenta; la corrida previa sin ese check dio 44/44). Una corrida anterior perdió el stack local a mitad de camino (UI y API dejaron de responder después de "create a pinned group"; 31/44) sin diagnóstico. Se agregó un log de qué proceso termina (`scripts/dev.ts`) y la segunda corrida completa no lo reprodujo: queda como observación abierta. Las dos aserciones de bridge que fallaban (`linklogBridge === "1"`) estaban desactualizadas en `main` desde protocolo v2 y se corrigieron a `PROTOCOL_VERSION`. La evidencia commiteada de main en `docs/browser-validation/` **no se tocó** y no se atribuye a esta entrega. |

`bun run build` sale limpio (también lo ejecutan `test:e2e`/`test:browser`). `scripts/check-api.ts` ahora requiere `LINKLOG_CHECK_EMAIL`/`LINKLOG_CHECK_PASSWORD` de una cuenta local; no se ejecutó contra un dev vivo.

### Clasificación de las pruebas (pedido del coordinador)

- **Chrome real + extensión real (`tests/browser/run.ts`, 45 checks):** los 44 contratos Browser de main (conexión, lenses y caché, ciclo de vida, identidad, estados, contenido, seguridad del bridge, Save/Close, grupos, dos páginas/ventanas/segundo perfil, Activity) corren ahora con una cuenta autenticada de verdad (sign-up + verificación por email simulado; la cookie de sesión se inyecta en cada perfil y `api()` manda Cookie + Origin). Check nuevo **"Accounts"**: A cierra sesión desde el menú real → la extensión borra las 65 entradas del scope de A → la cookie vieja de A recibe 401 → B entra por el formulario en el mismo perfil → `library_id` distinto, 0 grupos fijados, 0 celdas de lens y ninguno de los lenses de A.
- **Fixture/transporte:** el Jev fixture (`JEV_PROVIDER=fixture`, solo local/test; en esa entrega la config fail-closed lo rechazaba en HTTP, y desde R4 también lo bloquea el guard de runtime), el email simulado de Wrangler y las fallas de red simuladas con `page.route` (outage, respuesta perdida). Ninguna llamada paga.
- **Expectativas que cambiaron por auth (sin retirar aserciones de seguridad):** `startApi` espera 401 en lugar de 200 (la API ya no es pública) y se agregó el binding `EMAIL` a la config de test (sin él, la config fail-closed respondía 503). En `tests/auth.test.ts`, "ruta desconocida → 404" pasó a 401 sin sesión y 404 con sesión, lo que es más restrictivo. Las dos aserciones de bridge `=== "1"` estaban desactualizadas en main desde el protocolo v2 y ahora comparan contra `PROTOCOL_VERSION`; siguen exigiendo que haya bridge. No se eliminó ninguna aserción.
- **API/Worker con A/B y auth real:** `bun test` (rutas Browser vía Hono con dos sesiones Better Auth sobre D1) y `test:e2e` (workerd real a través del proxy). La autorización siempre sale de la sesión. Los IDs de cliente (`libraryId`, `requestId`, ids de grupo) nunca autorizan: un id ajeno da 404/409, y el `forget` de la extensión solo actúa sobre el scope de **su propia** conexión.
- **Pendiente / límites (histórico; la parte de metadata la superó R2, ver §0):** la corrida 1 sin diagnóstico (ver arriba). La metadata local de grupos nativos (descripción, vínculo con el pin) vivía en el almacenamiento de la extensión por perfil de Chrome, no por cuenta: otra cuenta en el mismo perfil ve los grupos nativos de Chrome (que de todos modos son visibles en el navegador), pero no los pins ni lenses del servidor. No se probó contra un Linklog desplegado ni con Chrome estable cargando la extensión a mano.

## 7. Fuentes verificadas (acceso 01–02-10-2026)

- Better Auth 1.7.7 = `latest` en npm el 02-10-2026; 1.7.7 es además el mínimo parcheado según el memo. [Hono integration](https://better-auth.com/docs/integrations/hono) (handler con `c.req.raw`, `getSession` con headers crudos, `nodejs_compat`), [rate limit](https://better-auth.com/docs/concepts/rate-limit), [security](https://better-auth.com/docs/reference/security).
- Hono 4.13.12 = `latest` en npm el 02-10-2026. [Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers): `export default { fetch: app.fetch, scheduled… }` y `Bindings` tipados.
- Cloudflare: [D1](https://developers.cloudflare.com/d1/), [Wrangler D1](https://developers.cloudflare.com/d1/wrangler-commands/), [send_email / Email Service](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/), [secretos](https://developers.cloudflare.com/workers/configuration/secrets/), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

## 8. Checklist manual del dueño

Reemplazado por el checklist vigente de §0.

## 9. Histórico: límites de la entrega inicial (los vigentes están en §0)

- **Sin prueba remota:** no se provisionaron dominio, Email Service, D1/R2 remotas ni secretos. La entregabilidad del correo (SPF/DKIM/DMARC, cuota de Email Service), las cookies `__Secure-` sobre HTTPS real, el comportamiento de `cf-connecting-ip` en el edge y la política para `workers.dev`/previews se cubren solo con config y tests unitarios (por ejemplo, el host ajeno da 403). Hay que ejecutarlos en un entorno autorizado.
- Runbook de despliegue (no ejecutado): crear D1/R2 y Queue; reemplazar el `database_id` local; `wrangler secret put BETTER_AUTH_SECRET`; vars `BETTER_AUTH_URL` (dominio canónico) y `EMAIL_FROM`; habilitar Email Service con el dominio remitente verificado y `send_email` remoto; `wrangler d1 migrations apply --remote` **sobre una copia primero**; deploy; probar alta, verificación, magic, reset y A/B en el dominio real; dejar `invocation_logs` apagados (los links de auth llevan tokens en la URL).
- Rate limit de Better Auth sobre D1: los contadores son por clave e IP y se probó la concurrencia local. El costo de D1 bajo ataque sigue sin medir.
- La retención Browser es un barrido global de 7 días; las capturas viejas con prefijo `browser/<requestId>/` (anteriores a esta rama) siguen limpiándose por tiempo.
- La API es privada por defecto: una ruta desconocida da 401 sin sesión y 404 con sesión (antes daba 404/405 sin sesión).
- Browser comparte los 300 jobs/h con la biblioteca (R1): una ventana con muchas pestañas y varios lenses puede agotarlos; aparece un aviso y los targets quedan failed con retry.
- No implementado (fuera de alcance): FAC-44/API keys, billing/entitlements, passkeys, Google/GitHub, login con Cloudflare, sharing, MCP. nuqs no se instaló (no aporta a auth).

## 10. Estado final

Ver §0 (snapshot aprobado `a8a1f62`, commits y gates). No se borró `.wrangler/state` ni se tocaron datos reales, otros worktrees o procesos ajenos; los servidores de validación usaron puertos propios y se detuvieron.
