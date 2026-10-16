# Validación FAC-40/FAC-41 — Hono, auth y aislamiento

**Resultados iniciales (históricos, snapshot `73bf1250555cced0d4b7057a2b77d1e128f24b91`):** se conservan abajo para distinguirlos de la revalidación post-fixes.

**Estado inicial:** validación completada en local descartable; había fallos reproducibles. No se modificaron implementación, tests, dependencias ni migraciones en esa ronda.

## Entorno

- Worktree: `/Users/facundopri/orca/workspaces/link-log/research-auth-cloudflare`, rama `facundoPri/research-auth-cloudflare`.
- HEAD antes y después: `73bf1250555cced0d4b7057a2b77d1e128f24b91` (sin cambios). Main integrado: `32fc90f40c6f136e8038aafa0a143404e531d0f4`.
- App/Worker local: UI `http://127.0.0.1:3210`, API `http://127.0.0.1:8810`, `APP_ENV=local`, Wrangler 4.136.1 y estado temporal `/tmp/linklog-auth-e2e.M3F20d/manual-state` (retirado al cerrar). Datos y cuentas fueron sintéticos; el correo fue la captura local de Wrangler. No hubo deploy, correo real ni D1 remoto.
- Prueba de interfaz en dos perfiles Orca aislados; luego se borraron ambos perfiles y se devolvió la pestaña preparada al perfil Default. El servidor y relay propios quedaron detenidos.

## Gates y contratos

- `bun run typecheck`: **pass**.
- `bun test`: **157 pass, 0 fail**, 22 archivos. Incluye auth, expiración/reuso de magic link, reset y revocación, métodos Hono, aislamiento de rutas, ownership de jobs, controles del bundle (Test Utils y credenciales demo excluidos; Jev fixture incluido) y migraciones.
- `bun run test:e2e`: **10/10 pass** en Worker/D1/R2/Queue/Workflow locales. Verificó registro y verificación, rechazo sin verificar, login, sesión tras reiniciar Worker, magic link de un uso, origen, acceso cruzado A/B en links/content/tags/lenses/batches y Browser, reset/revocación, quotas y limpieza de logs.
- Migraciones 0012/0013 y los datos anteriores se validan en `bun test` con D1 desechable: conserva filas/relaciones de Browser y biblioteca y deja `user_id` sin asignar; no hay adopción por el primer signup. La prueba no tocó una D1 real.
- Los contratos raw de Better Auth bajo Hono y las rutas privadas se cubren en la suite; llamadas sin sesión a biblioteca/Browser y mutaciones dieron 401/403 en esas pruebas. Las rutas API toman el owner de la sesión y los tests rechazan IDs directos ajenos, incluido el mismatch de `libraryId`. La validación del bridge que relaciona sesión, ventana e IDs del cliente queda pendiente con la extensión real.

## Interacción real de auth y dos usuarios

En Orca, A completó alta, verificación local, password login, reload con sesión persistente y logout normal. B, en otro perfil, completó alta, verificación local y login. Ambos crearon el mismo URL, tag y lens: cada biblioteca mostró su propio link/tag/lens. B conservó su link después de borrar el de A (A: 0 copias; B: 1). La UI mostró la pantalla de sign-in después del alta sin hacer visible el aviso esperado de confirmación, aunque el correo local se generó y el enlace permitió verificar; conviene revisar que ese aviso sobreviva al refetch de sesión.

### Fallos reproducidos

1. **Sign-out con 503 deja una sesión activa sin avisar.** En Chrome/Playwright, una interceptación de una sola petición `POST /api/auth/sign-out` respondió 503. La UI siguió en la shell autenticada en `/`, sin alerta; `GET /api/auth/get-session` respondió 200 con sesión activa. Evidencia de pantalla (usuario sintético): `/tmp/linklog-auth-e2e.M3F20d/signout-503-debug.png`. La ruta de salida navega aunque la revocación haya fallado y no informa el error.
2. **Browser omite `jobsPerUser`.** En D1 local fijé `jobs:<A>` en 300. Tres `POST /api/browser/evaluations` con 100, 100 y 1 target respondieron 201 y crearon 201 targets/jobs. El límite no se consume en `createEvaluation`; la evaluación A/B normal sigue pasando. Con la cuota ya agotada, un `POST /api/links` devolvió 429, pero el GET posterior ya mostraba el link/tag creados antes de fallar el enqueue: también queda un efecto parcial al rechazar la operación.
3. **El límite de cuerpo cuenta caracteres JS, no bytes.** Un `Request` con stream, sin `Content-Length`, 720,070 code units y 2,160,070 bytes UTF-8 (límite configurado 2,100,000) llegó al `Worker.fetch`/Hono y `POST /api/browser/groups` respondió 201. Se reprodujo con D1 de prueba y cuenta sintética; el stream del navegador Orca no fue aceptado por su transporte, por eso el repro aislado ejercitó directamente el fetch handler.
4. **Fixture Jev no se bloquea en ejecución interna.** Para `APP_ENV=preview` y `production`, `readConfig` rechazó `JEV_PROVIDER=fixture` y `ALLOW_FIXTURE_JEV=1`, pero `browserEvaluationHandler.run` invocado directamente completó y guardó respuestas `fixture/jev`. Es una prueba local del handler/Workflow, no de un despliegue; evidencia que el guard HTTP no protege el camino de procesamiento asíncrono si esas variables llegan al runtime.

## Browser extension y cobertura pendiente

La suite real `bun run test:browser` no pudo validar el bridge: `/opt/pw-browsers/chromium` no existe. Con Google Chrome 154.0.8037.93, tanto headless como headed, el runner compiló la extensión pero no apareció el service worker; un smoke test con `--disable-extensions` omitido tampoco lo inició. Por tanto no afirmo un repro real de descripción/cache entre cuentas ni doy por validado el flujo de extensión. El código observado guarda descripciones/metadatos globalmente en `GroupMetaStore` y `forget` limpia `ResultCache`; la fuga A→B de descripción/pinned group debe quedar como riesgo sin confirmar hasta ejecutar el bridge real. La separación A/B anterior corresponde a la app/API, no a una sesión de extensión.

No se desplegó a preview/production ni se ejecutó una extensión instalada real. Se preservó el archivo no relacionado `planning/research/auth-code-review.md` y el árbol de código permaneció sin cambios.

## Revalidación posterior a fixes FAC-40/FAC-41 — 02-10-2026

**Snapshot:** HEAD antes y después `e965bf8d76924984b9bc4095a538baa5e67a977d`, rama `facundoPri/research-auth-cloudflare`; coincide con el SHA que entregó el coordinador. No se detectaron procesos de implementación en este worktree y no cambió HEAD. En este dispatch solo se modificó este informe; `auth-code-review.md` pertenece al reviewer.

**Entorno local:** todos los procesos se lanzaron con CWD `/Users/facundopri/orca/workspaces/link-log/research-auth-cloudflare`. Versiones: Bun 1.3.14, Wrangler 4.136.1, Hono 4.13.12, Playwright Chromium 153.0.8010.12 (browser build `chromium-1243`), extensión 0.1.0. `test:e2e` usó UI `127.0.0.1:3197`, API `127.0.0.1:8897` y el estado local `/var/folders/h_/dr0vb70d1sdbk3wnx6kt2rxr0000gn/T/linklog-e2e-6zDJkc`; el script lo quitó al finalizar. El runner de extensión y los flujos R2/R3/R7 usaron UI `127.0.0.1:3010`, API `127.0.0.1:8790`, fixture local `127.0.0.1:3099`, config temporal `.cache/browser-test/wrangler.jsonc` y estado `.cache/browser-test/state`; no usaron `.wrangler/state`. Los puertos propios quedaron libres. El cache preexistente de 116 MB fue restaurado; el cache generado para estas pruebas se movió a Trash.

La suite y los repros R2/R3/R7 iniciales se abrieron en un `launchPersistentContext` con el Chromium que Playwright instala bajo `chromium-1243`; el runner real inició el service worker. La guía oficial recomienda contexto persistente y su canal `chromium` para headless; ese helper selecciona el browser mediante `executablePath`, no mediante la opción `channel`. En el follow-up pedido por el reviewer ejecuté R2 en un perfil persistente temporal separado con `channel: "chromium"`, sin repetir la suite: Chromium 153.0.8010.12 cargó la extensión y su service worker real (`chrome-extension://…/background.js`) arrancó tanto en el flujo como al abrir de nuevo el mismo perfil. Antes de expirar la sesión, A mostró description con marcador privado, `pinnedId` e hint no vacíos; luego revocada la sesión local y tras reload, B en el mismo perfil obtuvo `description:""`, `pinnedId:null`, sin el marcador en snapshot ni en la petición Autogroup, mientras los metadatos/hints de A seguían guardados bajo su scope y el grupo y sus tabs nativos permanecían abiertos. Repro conservado fuera del árbol versionado: `bun /tmp/linklog-auth-r2-channel-evidence/r2-channel.ts`; requiere cuatro identidades sintéticas locales suministradas por variables de entorno, cuyos valores no se guardan. No se usaron Chrome/Edge de sistema ni perfiles reales. [Guía oficial Playwright: extensiones Chromium](https://playwright.dev/docs/chrome-extensions). Evidencia adicional: `/tmp/linklog-auth-validation-e965bf8d-browser-evidence/r2-b-autogroup-no-a-description.png`.

### Gates y regresiones ejecutadas

| Gate / repro | Resultado observado |
| --- | --- |
| `bun run typecheck` | **Pass** en TypeScript raíz, browser-protocol y extensión. |
| `bun test` | **182 pass, 0 fail**, 25 archivos; ejecutó regresiones R1–R8, auth, Hono, migraciones, aislamiento, bundle y stores/commands de la extensión. |
| `bun run test:e2e` | **10/10** en Worker/workerd con D1/R2/Queue/Workflow locales: alta/verificación/password, sesión tras restart Worker, magic link/reuso, dos dueños, IDs ajenos, jobs/usage, reset y logout. |
| `CHROME_PATH='/Users/facundopri/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' LINKLOG_BROWSER_EVIDENCE=/tmp/linklog-auth-validation-e965bf8d-browser-evidence bun tests/browser/run.ts` | **45/45** con extensión MV3 real y perfil persistente; service worker, scopes por ventana/perfil, cache/recovery, bridge, grupos, tabs, Autogroup, sign-out A→B. |
| `bun test /tmp/linklog-r8-fault-e965bf8d.ts` | Repro local de fault injection pasó sus assertions porque confirmó la escritura parcial descrita abajo; no es un gate verde del comportamiento R8 ante fallo D1. |
| R2/R3/R7 en Chromium con perfiles locales descartables | R2 real A→B tras revocar sesión; R3 503 con extensión activa y Retry; R7 refetch lento/rápido y verificación por UI. Evidencia saneada en `/tmp/linklog-auth-validation-e965bf8d-browser-evidence/`. |
| `bunx wrangler deploy --dry-run --outdir /tmp/linklog-auth-validation-e965bf8d-bundle-check` | Un bundle Worker; contiene `fixtureJev`/código fixture y guard. No contiene `testUtils`, credenciales demo ni `BUN_PUBLIC_LINKLOG_DEV_FIXTURES`. No fue deploy. |

La corrección de clasificación es deliberada: `tests/bundle.test.ts` solo excluye Test Utils, las credenciales demo y el flag público de fixtures del Worker/SPA; no busca ni excluye `fixtureJev`. El build SPA rechaza `BUN_PUBLIC_LINKLOG_DEV_FIXTURES`, y las pruebas R4 verifican que el handler Workflow rechace el fixture en `preview`/`production` antes de answer/usage. No se encontró un endpoint de auto-login en el Worker; Test Utils tampoco está en el bundle. Por tanto, el Jev fixture **está distribuido** pero su invocación se cierra por entorno en background.

### Matriz R1–R8

| ID | Resultado post-fix y método |
| --- | --- |
| R1 | **Pass en regresiones de backend:** cuatro casos verificaron cuota Browser compartida con biblioteca, 429 sin receipt/capture/job/Queue, replay sin doble cargo, carrera junto al límite con un ganador y cuenta B independiente. La interacción visual del aviso/retry por 429 no se reprodujo aparte. |
| R2 | **Pass:** tests de GroupMetaStore/commands cubrieron scope por cuenta, session expirada sin `forget`, hints en restore, metadata legacy y limpieza. En extensión real A guardó pin/description; se revocó su sesión en el Worker sin `beforeSignOut`/`forget`, se recargó y B inició sesión en el mismo perfil. B vio el grupo nativo con `description:""`, `pinnedId:null`; metadata e hints de A seguían bajo su scope, el grupo y sus tabs nativos siguieron abiertos y el Autogroup POST de B incluía el destino A sin el marcador privado. El follow-up separado con `channel:"chromium"` repitió únicamente esta comprobación sobre Chromium 153 y confirmó arranque del service worker y markers positivos de A previos al cambio. Browser suite adicional confirmó B sin pins/lenses/resultados de A después del logout exitoso. |
| R3 | **Parcial; hallazgo abajo:** tests unitarios cubrieron 503/429/red/401/éxito/retry; browser real interceptó un 503, mostró Retry, mantuvo la sesión, y un Retry exitoso revocó la cookie. Sin embargo, antes del POST la extensión ya había borrado cache/metadata y desconectado el scope. |
| R4 | **Pass en handler local:** `browserEvaluationHandler.run` rechazó flags fixture con `APP_ENV=preview` y `production` antes de answer/usage; `test` conservó fixture. Bundle verifica ausencia de Test Utils y credenciales demo. No se invocó una Workflow desplegada en preview/production. |
| R5 | **Pass en Worker/Hono local:** stream chunked de UTF-8 por encima de 2.1 MB devuelve 413 antes de insertar grupo; un cuerpo multibyte menor conserva texto. E2E/auth y proxy mantuvieron signup, redirects/cookies y auth raw funcionales. No se midió el límite del edge Cloudflare. |
| R6 | **Pass en D1 sintético/migraciones:** `0012`/`0013` preservaron filas/relaciones/valores previos —incluidos browser requests/targets/groups, jobs y library anterior— y dejaron propietarios legacy sin asignar al primer signup. Copia/adjudicación asignó `library_id` heredado a A una sola vez; B con cero filas no lo recibió, retry de A mantuvo identidad, dry-run no escribió, ID propio se conservó e índice único rechazó duplicado. No se modificó D1 real. |
| R7 | **Pass en browser UI real:** con el refetch `get-session` detenido, siguieron montados “Create your account”, el email draft y el formulario; liberado el refetch, se mantuvieron notice/email y la sesión siguió anónima hasta verificar. El caso rápido también mantuvo notice/draft; abrir cada enlace local verificó e inició esa cuenta. |
| R8 | **Pass para cuota agotada/retry normal; falla un fallo transitorio a mitad de import:** las regresiones existentes cubrieron 429 sin link/tag/job/batch, retry tras liberar cuota, dedupe y concurrencia. Fault injection del segundo `INSERT` dejó una URL persistida sin job/batch/Queue y cobró cuota 1; reintentar las dos devolvió `[duplicate, created]`, generó trabajo solo para la segunda y dejó la primera sin job. |

### Hallazgos post-fix

1. **R3 — logout 503 pierde datos locales de A aunque la sesión siga activa.** En un perfil con extensión conectada creé un grupo nativo A no fijado con descripción, un resultado y un pending request/hint sintéticos. Intercepté una vez `POST /api/auth/sign-out` con 503: se vio el error y Retry, `get-session` siguió activo, pero results/pending/groups/hints pasaron de `1/1/1/1` a `0/0/0/0`; la tab y grupo nativos quedaron abiertos. El siguiente bridge `snapshot` respondió `Connect first.`. El motivo es el hook `beforeSignOut` que ejecuta `forget` antes de confirmar el sign-out del servidor, contrario al contrato documentado por `signOutFlow` de no limpiar en error. Al pulsar Retry con el backend disponible, el cookie anterior obtuvo 401 en `/api/library` y la UI recargó al login. Pasos y screenshots: `/tmp/linklog-r3-extension-e965bf8d.ts`, `r3-before-signout.png`, `r3-signout-503.png`, `r3-retry-anonymous.png`.

2. **R8 — un error D1 entre inserciones deja una importación parcialmente persistida e irrecuperable por reintento de la misma lista.** Con dos URLs nuevas y una falla inyectada en el segundo `INSERT` de `addLinks`, quedó la primera fila sin job/batch/Queue y cuota links/jobs en 1. El retry devolvió `created=[false,true]`, terminó con dos links, un job/batch/Queue y cuotas 2/2; el job corresponde solo a la segunda URL, por lo que la primera quedó sin extracción. Es un fault injection contra el D1 shim local, no una afirmación de que se observó una falla en Cloudflare D1; reproduce la ventana entre escrituras secuenciales y el enqueue final. Script temporal: `/tmp/linklog-r8-fault-e965bf8d.ts`.

### Límites restantes

- No se usaron D1/R2/Workflow, Email Service, cookies HTTPS, cuotas edge ni hosts de preview/production remotos. R4 ejecutó el handler real con `APP_ENV` simulado, no una instancia remota.
- R2 simuló expiración revocando en el Worker y recargando; no esperó siete días ni reinició/reinstaló todo el browser profile. Los tests de store cubren restore/hints y el browser real confirmó suspensión/reinicio del service worker.
- R3 reprodujo error HTTP 503 en UI; fallo de red fue cubierto por unit tests, no como interceptación de red en browser.
- R1 429 visual y retry desde la UI no fueron interactuados en esta ronda; los contratos backend y ownership sí se ejercitaron.
- R8 la falla entre dos escrituras fue inyectada en `TestD1`; no se simuló indisponibilidad del servicio D1 remoto.

## Revalidación dirigida post-fixes R3/R9 — 02-10-2026

**Snapshot canónico:** HEAD antes y después `9dd9feef8a4e2323fcbca9d0ee7ca280ee6c216f`, rama `facundoPri/research-auth-cloudflare`; sin cambios durante la corrida. Desde `e965bf8d76924984b9bc4095a538baa5e67a977d` se inspeccionaron los commits `f2fb5db` (sign-out), `ea5b75c` (links), `11a3611` (E2E), `531782f` (browser) y `9dd9fee` (reportes); el árbol versionado de implementación/tests/config/deps/migraciones quedó intacto. No se detectaron procesos escritores de implementación. Este apartado conserva resultados históricos y no reemplaza las rondas anteriores.

**Entorno y gates:** worktree `/Users/facundopri/orca/workspaces/link-log/research-auth-cloudflare`; Bun 1.3.14, Wrangler 4.136.1, Hono 4.13.12 y Chromium 153.0.8010.12 en `channel: "chromium"`. `bun run typecheck`: pass. `bun test`: **187/187 pass, 0 fail, 26 archivos**. `bun run test:e2e`: **11/11 pass** en Worker/workerd y D1/R2/Queue/Workflow locales, incluyendo import fault-injected a mitad del batch, retry/dedupe, auth, ownership A/B, Browser y logout. El E2E usó UI `127.0.0.1:3197`, API `127.0.0.1:8897` y su estado aislado autocleaned. No se reutilizó servidor de otro worktree.

### R3 — logout recuperable con extensión real

Repro UI + extensión MV3 con `launchPersistentContext({ channel: "chromium" })`, perfil descartable y service worker real cargado; UI/API en `127.0.0.1:3240`/`127.0.0.1:8840`, sitio de handshake local `127.0.0.1:3309`. Usé dos cuentas sintéticas locales. Antes de salir, A tenía resultados/pending/grupos/hints `1/1/1/1`, handshake efectivo y un grupo/tab nativo con descripción privada. El primer `POST /api/auth/sign-out` se interceptó como 503: la UI mostró Retry, la sesión A siguió activa y el snapshot siguió funcionando; los cuatro conteos, descripción, conexión y grupo/tab quedaron intactos. Un segundo Retry abortó por red y conservó esos mismos datos y sesión. El Retry siguiente, con red disponible, completó el logout: el cookie viejo obtuvo 401 en `/api/library`, `get-session` fue anónimo y el scope local A quedó vacío `0/0/0/0`, manteniendo abierto el grupo/tab nativo. Luego inicié B desde la UI en el mismo perfil: B recibió otro `libraryId`, su catálogo empezó vacío y el snapshot de ese grupo nativo no expuso la descripción ni el marcador privado de A; los grupos/tabs del navegador siguieron presentes. **R3 pasa** para 503, rechazo de red, retry exitoso, limpieza al completar y cambio A→B.

Evidencia reproducible saneada: `bun /tmp/linklog-auth-r3-round2-evidence/r3-round2.ts` (requiere variables de entorno con cuentas sintéticas, no persistidas). Screenshots: `/tmp/linklog-auth-r3-round2-evidence/r3-before-signout.png`, `r3-signout-503.png`, `r3-retry-anonymous.png` y `r3-b-no-a-leak.png`; no incluyen tokens/cookies. El harness verifica la respuesta del comando snapshot, no solo que el service worker arranque.

### R9 — atomicidad, recovery y límite de parámetros D1

Las regresiones en `bun test` y E2E inyectaron el fallo en la segunda inserción de una importación nueva. La operación quedó completamente revertida (sin link/job/batch huérfano y con cuotas reembolsadas); al retirar el fallo, reintentar la misma lista creó cada link/job una vez, y repetir el import deduplicó sin cargos ni trabajo adicional. Las pruebas de Queue verificaron commit con outbox durable cuando el envío no está disponible y recuperación posterior; cobertura de concurrencia, dedupe y owner B pasó en la suite/E2E. No se observó borrado compensatorio concurrente.

Además envié imports de N URLs únicas mediante API a Wrangler/Miniflare con D1 local real, una cuenta sintética y contadores aislados por caso. La sentencia batch tiene N+4 bindings (N IDs y cuatro fijos); el límite documentado por Cloudflare D1 es 100 parámetros ligados por query ([límites oficiales de D1](https://developers.cloudflare.com/d1/platform/limits/), consultados el 02-10-2026).

| URLs nuevas N | Bindings | HTTP | Links / jobs / batches / huérfanos | Cuotas links/jobs | Retry idéntico |
| ---: | ---: | ---: | ---: | ---: | --- |
| 96 | 100 | 200 | 96 / 96 / 1 / 0 | 96 / 96 | 200; 0 creados, 96 duplicados; estado sin cambios |
| 97 | 101 | 500 | 0 / 0 / 0 / 0 | 0 / 0 | No repetido ante el mismo límite determinista |
| 99 | 103 | 500 | 0 / 0 / 0 / 0 | 0 / 0 | No repetido ante el mismo límite determinista |
| 100 | 104 | 500 | 0 / 0 / 0 / 0 | 0 / 0 | No repetido ante el mismo límite determinista |

El boundary harness fue `bun /tmp/linklog-auth-r9-bindings-evidence/r9-bindings.ts`; no añadió un guard artificial y contó filas/cuotas después de cada respuesta. A partir de 101 bindings el D1 local devolvió 500 y la sentencia transaccional dejó todas las tablas/contadores en cero. La respuesta HTTP fue genérica y no expuso el error interno, por lo que la coincidencia con el máximo oficial es evidencia fuerte del límite y no una captura textual del error SQLite. La suite prueba rollback/retry después de resolver un fallo transitorio; el retry de N≥97 no se ensayó porque ese mismo lote determinista seguirá excediendo el límite.

**Hallazgo para el reviewer:** imports de 97+ URLs nuevas en una sola solicitud fallan con 500 en el entorno D1 local aunque el estado queda coherente y no cobra cuotas. La consulta actual debe dividirse o agruparse respetando el máximo de bindings si el contrato permite lotes de ese tamaño. El máximo observado para esa query es 96 URLs nuevas; un lote de 96 importó correctamente y fue idempotente al reintentar.

### Alcance y limpieza

No se probaron D1/Queue remotos, preview/production, despliegue ni extensión contra servicio remoto; Chromium sí cargó la extensión real desde un perfil temporal local. No se usaron secretos, correos ni cuentas reales. Se preservaron scripts/screenshot saneados bajo `/tmp`; se retiraron procesos/estado/perfiles propios y se restauró `dist` al contenido preexistente antes de cerrar. `auth-code-review.md` siguió siendo del reviewer; solo este informe es una modificación de este dispatch.

## Revalidación dirigida de R10 — 02-10-2026

**Snapshot y alcance:** HEAD antes y después `a8a1f628c77862a83bd8a235048ca4b15e091509`, rama `facundoPri/research-auth-cloudflare`. Se leyeron `auth-fix-report.md` ronda 3 y los cambios de `c558f58`, `d433a8a`, `a8a1f62`: `addLinks` usa bindings constantes dentro de un `D1.batch`; `enqueue` consulta IDs en chunks de 99 más owner cuando aplica; cancelación selecciona links por subquery en el batch. Entorno: Bun 1.3.14, Wrangler 4.136.1, Hono 4.13.12; Worker/API local en `127.0.0.1:8850` y `127.0.0.1:8851`, UI auxiliar `127.0.0.1:3250`/`3251`, D1/R2 persistidos solo bajo los dos directorios temporales descritos. No escribí código/tests/config/migraciones y HEAD no cambió.

**Gates pertinentes:** `bun run typecheck` **pass**. `bun test tests/link-bindings.test.ts tests/link-atomicity.test.ts tests/isolation.test.ts`: **28 pass, 0 fail** (bindings 96/97/99/100, import/Browser save, fresh+orphans, rollback, cancel, owner isolation, concurrencia, outbox y recovery). Repro temporal adicional `bun test /tmp/linklog-auth-r10-a8a1-validation/r10-late-fault-shim.test.ts`: **1 pass, 0 fail, 10 assertions**; induce el fallo en el job número 100, después de ejecutar links, batch y los primeros 99 jobs en el `TestD1.batch` atómico.

### Import HTTP y Browser save sobre D1 local

Probe con Wrangler/Miniflare, Worker HTTP autenticado y estado desechable bajo `/tmp/linklog-auth-r10-a8a1-validation/state`; CWD del servidor y Wrangler CLI: este worktree. A y B fueron cuentas sintéticas distintas, con un namespace de URL y contadores link/job reiniciados por caso. El producer local de Queue se configuró sin consumer para evitar procesar la carga; por tanto, aquí los mensajes de Queue no se midieron. Los conteos siguientes son consultas SQL directas a las tablas D1 y cuotas, no resultados de `TestD1`.

| Ruta | N | HTTP inicial | Links / jobs / batches / huérfanos / `content_state=queued` | Cuotas link/job | Retry |
| --- | ---: | ---: | --- | --- | --- |
| Import, owner A | 96 | 200 | 96 / 96 / 1 / 0 / 96 | 96 / 96 | 200; 0 nuevos, 96 duplicados; estado/counters igual |
| Import, owner A | 97 | 200 | 97 / 97 / 1 / 0 / 97 | 97 / 97 | 200; 0 nuevos, 97 duplicados; estado/counters igual |
| Import, owner A | 99 | 200 | 99 / 99 / 1 / 0 / 99 | 99 / 99 | 200; 0 nuevos, 99 duplicados; estado/counters igual |
| Import, owner A | 100 | 200 | 100 / 100 / 1 / 0 / 100 | 100 / 100 | 200; 0 nuevos, 100 duplicados; estado/counters igual |
| Browser save, owner B | 96 | 200 | 96 / 96 / 1 / 0 / 96 | 96 / 96 | 200; todos duplicate; estado/counters igual |
| Browser save, owner B | 97 | 200 | 97 / 97 / 1 / 0 / 97 | 97 / 97 | 200; todos duplicate; estado/counters igual |
| Browser save, owner B | 99 | 200 | 99 / 99 / 1 / 0 / 99 | 99 / 99 | 200; todos duplicate; estado/counters igual |
| Browser save, owner B | 100 | 200 | 100 / 100 / 1 / 0 / 100 | 100 / 100 | 200; todos duplicate; estado/counters igual |

Assertion/repro: `bun /tmp/linklog-auth-r10-a8a1-validation/r10-local-d1.ts` (requiere identidades sintéticas efímeras por variables de entorno, no incluidas en el archivo). El probe filtra SQL por owner y URL prefix y verifica los mismos contadores después de cada retry. El gate existente del implementador `bun run test:e2e` 12/12 no se repitió, según el alcance pedido.

### Huérfanos, fallo tardío y Queue

El probe real de D1 sembró 60 links huérfanos del owner con 40 URLs nuevas. Un trigger abortó el **job número 100** dentro del `D1.batch`, cuando ya se habían ejecutado las 40 inserciones de link, la fila batch y 99 inserciones de job. El POST de import devolvió 500 genérico; la consulta posterior mostró sin cambios las 60 filas preexistentes, 0 nuevas, 0 jobs/batches nuevos, 60 huérfanos y cuotas link/job 0/0. Al retirar el trigger, el retry importó 40 y reconoció 60 existentes, dejando 100 links, 100 jobs, una batch, 0 huérfanos y cuotas 40/100; repetirlo dio 0 nuevos/100 duplicados sin cambio de estado. Repro: `bun /tmp/linklog-auth-r10-late-d1/r10-late-d1.ts`; resultados saneados: `/tmp/linklog-auth-r10-late-d1/late-d1-results.json`.

La medición de Queue cero pertenece **solo al shim `TestD1`**: el probe temporal `r10-late-fault-shim.test.ts` falla el último insert de jobs, observa `queued.length === 0` y quotas 0/0, luego verifica retry con 100 jobs/100 envíos y dedupe sin nuevos envíos. En el runtime Wrangler/Miniflare usado para inspeccionar D1 no expuse un contador Queue fiable con la configuración producer-only; no atribuyo ausencia de archivos/tablas internos a una garantía del producto ni afirmo medición real de Queue. Las regresiones `link-atomicity.test.ts` también pasaron para fallo, Queue no disponible tras commit y reenvío por recovery.

### Chunks de jobs y cancelación de 100

En el mismo D1 local ejecuté `POST /api/batches` con 99 links A y un ID de B en el item 100 (segundo chunk): respondió error y el estado/cuotas de A no cambiaron. Otra llamada con 100 links A y el único job activo en el item 100 rechazó la selección; el job activo permaneció y no aparecieron cargos ni batch/jobs nuevos. Son solicitudes HTTP reales, con consultas directas a las tablas tras cada rechazo.

Con 100 links de A sin trabajo activo, escribí markdown a una ruta mediante API local y confirmé lectura desde R2 local. A inició una batch extract de 100; B recibió 404 al intentar cancelarla y no cambió los 100 jobs queued ni pudo leer el contenido. Un trigger de D1 falló la segunda sentencia del `D1.batch` de cancelación, después de la sentencia que restauraba estado de los links. La respuesta falló; D1 dejó los 100 jobs queued y el link con `content_key`/markdown intactos, lo que confirma rollback conjunto. Sin el trigger, el retry canceló los 100 jobs, dejó el contenido como `ready`, preservó la misma key y devolvió el markdown original; B siguió obteniendo 404. Todo fue D1/R2 local sintético, no remoto.

### Límite operativo de plan y cobertura restante

La tabla oficial de [límites de D1](https://developers.cloudflare.com/d1/platform/limits/) (consultada el 02-10-2026) indica hasta 1000 “Queries per Worker invocation” en Workers Paid y 50 en Free, y máximo 100 bindings por query también dentro de cada sentencia de un batch. **Inferencia conservadora:** el import actual hace una lectura de dedupe por URL única, así que una llamada de 100 URLs ya supera las 50 lecturas Free antes de las escrituras. No medí consumo total por invocación ni en edge, así que no concluyo el margen operativo Paid; tampoco usé ni llamé una app/deployment Free/Workers Free ni probé D1/Queue remoto.

No se repitieron E2E completo, Browser 45/45, extensión/UI ni R3/R2; no eran parte de esta regresión de D1. Se preservaron los resultados anteriores en `/tmp` y `.cache`; únicamente se usaron estados temporales propios, sin `.wrangler/state`, credenciales reales ni despliegue.
