# Verificación y fixes de `auth-code-review-latest.md`

Rama `facundoPri/research-auth-cloudflare`. Base verificada: `eb98062d2166c2a9a3ad7628fe0c35b11754e6e4`. La fuente (`auth-code-review-latest.md`) presentaba sus 10 hallazgos como pistas sin verificar. Cada uno se comprobó contra el código actual y contra las versiones fijadas (better-auth 1.7.7, hono 4.13.12, wrangler/workerd locales). La fuente queda sin tocar y sin commitear. Este informe no reemplaza a los informes firmados anteriores; los complementa.

Commits:
- `765ba7b` fix: verified findings from the latest auth review (código)
- `e850b7d` test: regresiones (`tests/review-latest.test.ts`) y paso 6e del e2e sobre D1 local real (`scripts/e2e-auth.ts`)

## Resumen

| # | Veredicto | Fix |
|---|-----------|-----|
| 1 | Válido | Sí: las claves viajan como un único parámetro JSON (`json_each`) |
| 2 | Válido | Sí: 503 si falla la consulta de la sesión; 401 solo si no hay sesión |
| 3 | Parcialmente válido | Arreglado el error de contabilidad. La mitigación de abuso queda como decisión del owner |
| 4 | Válido | Sí: `charge()` con reembolso; la carrera se informa como "still processing" |
| 5 | Válido | Sí: 400 solo si es explícito (`badRequest`); lo demás es un 500 genérico |
| 6 | Válido (inconsistencia) | Sí: "apagado" explícito aceptado; lo ambiguo sigue fallando cerrado |
| 7 | Mayormente inválido | Better Auth 1.7.7 ya poda. Se añadió una red de seguridad en el cron |
| 8 | Válido (eficiencia) | Sí: una sola sentencia por owner en lugar de una por URL |
| 9 | Coste real, tradeoff intencional | No se cambia (ver medición y riesgos) |
| 10 | Válido (limpieza) | Sí: se eliminó `precharged` |

## Hallazgo por hallazgo

### 1. Ack/cancel con 100 claves superan los 100 parámetros de D1. Válido
- **Evidencia:** `worker/routes/browser.ts` (en `eb98062`). `targetKeys()` admite hasta `BROWSER_LIMITS.maxTargets` = 100 claves. El SELECT del ack ligaba 1+100 parámetros, el UPDATE 2+100 y el cancel 2+100. En D1 local real, el e2e nuevo (paso 6e) da `ack of 100 (500)` sobre `eb98062`.
- **Causa:** `IN (?,?,…)` con un parámetro por clave. El fix R10 cubrió `addLinks` y `enqueue`, pero no estas sentencias.
- **Fix:** `target_key IN (SELECT value FROM json_each(?))` con `JSON.stringify(keys)`. Así cada sentencia liga 2 o 3 parámetros, sea cual sea el número de claves. Cada sentencia sigue siendo única (no se trocea) y la propiedad se sigue comprobando antes con `ownedRequest` y `request_id`.
- **Tests:** `review-latest` §1, sobre TestD1, que aplica el límite de 100. Con 100 claves:
  - el ack confirma 100 y purga las 100 instantáneas de R2;
  - repetirlo es idempotente (0);
  - B recibe 404 y sus 100 claves idénticas quedan intactas;
  - el cancel cancela 100 solo en la request de A.

  Además, el e2e 6e sobre D1 local real (workerd) hace la evaluación de 100 pestañas con el proveedor fixture vía Queue/Workflow: el ack confirma 100, el cancel devuelve 100 y B recibe 404 en ambos.

### 2. Un fallo al consultar la sesión se mapeaba a 401. Válido
- **Evidencia:** `worker/http/middleware.ts` `requireSession` capturaba cualquier excepción y respondía 401. En better-auth 1.7.7 (`dist/api/routes/session.mjs`, líneas 229-232), `getSession` convierte cualquier error que no sea `APIError` (por ejemplo de D1) en `APIError("INTERNAL_SERVER_ERROR")`. Así, una caída de D1 llegaba al cliente como 401 y `src/api.ts`/`src/browser/api.ts` llamaban a `announceUnauthorized()`.
- **Fix:**
  - Si `isAPIError(error) && statusCode === 401` (la sesión desapareció durante el refresh), la respuesta sigue siendo 401.
  - Cualquier otro error devuelve `503 {code:"session-unavailable"}` y solo registra `session_lookup_failed`.
  - El cliente ya trata un 503 como un error no destructivo: `src/api.ts` lanza un mensaje y `src/browser/api.ts` lanza `OfflineError`. Se conservan la UI, la sesión y el estado de la extensión.
- **Test:** `review-latest` §2.
  - Sin cookie, la respuesta es 401.
  - Con D1 fallando en `from "session"`, la respuesta es 503 `session-unavailable`, sin borrar la cookie y sin el token en los logs.
  - Al restaurarse D1, la misma sesión da 200.
  - Con la sesión revocada en D1, da 401.

### 3. Los presupuestos de email de auth pueden agotarse de forma anónima. Parcialmente válido
- **Error de contabilidad (válido, arreglado):** `worker/email.ts` consumía primero el cupo por destinatario y después el diario con `&&`. Un envío rechazado por el tope diario ya había gastado el cupo horario del destinatario. Ahora `charge()` toma los dos cupos o ninguno, y devuelve el primero si el segundo se agota.
  - Test `review-latest` §3: con el tope diario en 1, el segundo destinatario queda con 0 en su cupo.
  - Inverso: 6 envíos a una víctima dan 5 entregados, el diario queda en 5 (el rechazado no lo gasta) y la dirección no aparece en los logs.
- **Topes deliberados (no es un bug):** el presupuesto diario global (`AUTH_EMAIL_DAILY_LIMIT`, 200 por defecto) y el de 5 por destinatario y hora son límites de coste o abuso intencionales. Que la UI diga "revisa tu email" aunque el envío se haya suprimido también es intencional: no revela si la cuenta existe ni el estado de los límites.
- **Riesgo restante (real):** quien reparta peticiones entre muchas IPs (el límite de Better Auth es por IP y ruta) puede agotar el diario. Con 5 peticiones por hora puede silenciar a una dirección concreta. Los contadores locales en D1 no eliminan el abuso distribuido.
- **Decisión del owner:** la mitigación real necesita un desafío anti-bot (por ejemplo Cloudflare Turnstile con el plugin captcha de Better Auth, que requiere claves y configuración) o un proveedor o presupuesto distinto. No se ha provisionado nada ni se ha añadido CAPTCHA. Tampoco se envió correo real.

### 4. `enqueue` no reembolsaba el cupo si el batch fallaba. Válido
- **Evidencia:** `worker/jobs.ts` (en `eb98062`) llamaba a `consume()` antes de `DB.batch` y no lo devolvía nunca. El chequeo de jobs activos seguido del batch no es atómico frente al índice `jobs_active_link` (`migrations/0013_ownership.sql:183`).
- **Fix:**
  - `charge()` y `release()` completo si el batch falla. D1 revierte el batch entero.
  - Tras el rollback, se vuelve a comprobar si hay un job activo. Si otra request ganó la carrera, la respuesta es el mismo 400 "Some selected links are still processing." en lugar de un 500.
  - El reembolso usa la misma ventana (`charge`) y no infla la siguiente.
- **Tests:** `review-latest` §4.
  - Con un fallo inyectado por trigger en `jobs`: 500, 0 jobs, 0 batches y cupo 0. El reintento da 200 con 3 jobs y cupo 3.
  - Carrera simulada (un job rival en cola entre el chequeo y el batch): 400, cupo 0, y solo queda el job rival (sin duplicados).

### 5. El catch-all devolvía errores internos como 400. Válido
- **Evidencia:** `worker/http/app.ts` `onError` devolvía el `message` de cualquier error desconocido con estado 400. Sobre `eb98062`:
  - un `content_details` corrupto en `/links/:id/transcript` devolvía 400 con el mensaje del `SyntaxError`, que puede citar el dato guardado;
  - un fallo de R2 devolvía 400 con el mensaje interno.
- **Fix:**
  - Nuevo `badRequest(message)` (`HttpError` 400) en `worker/http/context.ts`.
  - Todas las validaciones del camino HTTP pasaron a usarlo: routes, `store.text/threshold`, `enqueue`, `browser.ts`.
  - `normalizeUrl` es compartido con la UI, así que se envuelve en `urlInput()`.
  - Cualquier otro error devuelve `500 "Something went wrong. Try again."` y registra solo `{event:"unhandled_error", type, method, route}`, sin mensaje, cuerpo, tokens ni cookies.
  - Los errores de D1 siguen devolviendo 500 "Could not save. Try again.".
  - Los errores de Workflow/Queue no pasan por aquí y no cambian.
- **Tests:** `review-latest` §5.
  - JSON corrupto y fallo de R2 dan 500 genérico, y ni el dato ni el mensaje aparecen en los logs.
  - Una URL inválida, un nombre vacío, un batch vacío o un ack sin claves siguen siendo 400 con su mensaje.

### 6. `ALLOW_FIXTURE_JEV=0` hacía fallar `readConfig`. Válido (inconsistencia)
- **Evidencia:** `worker/config.ts` rechazaba cualquier valor truthy ("0" y "false" incluidos) fuera de local/test, mientras que `fixtureJevAllowed` solo habilita con exactamente `"1"`.
- **Fix:** fuera de local/test solo pasa un "apagado" explícito (sin definir, `""`, `"0"` o `"false"`, sin distinguir mayúsculas). `"1"` y cualquier valor ambiguo (`true`, `yes`, `on`, `2`…) siguen dando 503. `JEV_PROVIDER=fixture` falla siempre, valga lo que valga el flag. Se mantiene el doble chequeo en tiempo de ejecución (`fixtureJevAllowed`).
- **Tests:** `review-latest` §6, 11 casos.

### 7. La tabla `rateLimit` de Better Auth nunca se poda. Mayormente inválido
- **Evidencia:** en better-auth 1.7.7 (`dist/api/rate-limiter/index.mjs`, líneas 79-185), el almacenamiento `database` ya ejecuta `deleteExpiredRows`, que borra **todas** las filas con `lastRequest < now − ventanaMáx`. Lo hace al renovarse la ventana de cualquier clave. Es decir, sí hay poda, aunque oportunista: con tráfico compuesto solo por pares IP/ruta nuevos, no se dispara.
- **Fix (red de seguridad, pequeña):** el cron `recover()` (cada 5 min) borra además las filas con `"lastRequest" < now − 1 día`. Está verificado que `lastRequest` se guarda en milisegundos epoch y que las ventanas configuradas son de 60 s como máximo. Un día de margen no puede borrar un bucket vivo.
- **Test:** `review-latest` §7. Una petición real de Better Auth escribe `lastRequest` ≈ `Date.now()` en ms. Tras `recover`, se borra la fila de hace 2 días y se conservan la fila real y la de hace 30 s.

### 8. `addLinks` hace una consulta a D1 por URL, en serie. Válido (eficiencia)
- **Evidencia:** `worker/links.ts` hacía `await find()` en bucle (hasta 100 SELECT en serie) y otra pasada en serie para las inserciones concurrentes.
- **Fix:** una sola sentencia por owner con la lista como único parámetro JSON (`json_each`, 2 parámetros). Si hay varias filas candidatas, gana la que coincide en `original_url` y, si no, la que coincide en `url`. Antes ese desempate quedaba indefinido con `.first()`. La segunda pasada usa la misma función.
- **Resultado:** las SELECT de búsqueda bajan de N (+M) a 1 (+1).
- **Aclaración:** esto reduce los viajes en serie y las sentencias de búsqueda. No afirmo cómo cuenta D1 las sentencias de un `batch()` frente al límite de consultas por invocación (50 en Free y 1000 en Paid según la documentación). El INSERT por lotes de `addLinks` sigue teniendo una sentencia por enlace. Tampoco hay que confundirlo con el límite general de subrequests de Workers.
- **Tests:**
  - `review-latest` §8: importar 100 URLs hace exactamente 1 búsqueda. La deduplicación se mantiene (90 nuevas y 10 existentes, una de ellas resuelta por `url`). Las 50 URLs idénticas de B no cuentan para A. Los huérfanos reciben su job.
  - Además, los tests existentes de R9/R10 y el e2e (importación de 100 y guardado de 97 en D1 real) pasan.

### 9. `betterAuth()` se reconstruye en cada petición `/api/*`. Coste real, tradeoff intencional (sin cambio)
- **Medición** (Bun, D1 en memoria, 500 iteraciones):
  - instancia nueva más `getSession`: unos 424 µs;
  - instancia reutilizada: unos 83 µs;
  - sobrecoste: unos 0,34 ms de CPU por petición.

  `createAuth` es perezoso (unos 26 µs) y el coste aparece en la primera llamada a la API.
- **Por qué no se cambia:** la instancia captura el `env`, la config, el mailer y `waitUntil` del `ExecutionContext` de **esa** petición (para el email y para `backgroundTasks`). Memoizarla por isolate haría que una petición usara el `waitUntil` o el mailer de otra. Hacerlo de forma segura exigiría una indirección con alcance de petición (por ejemplo `AsyncLocalStorage`) para esas dependencias. Hacerla perezosa no ayuda, porque todas las rutas privadas necesitan `getSession`.
- **Decisión del owner:** solo si el presupuesto de CPU llega a importar (por ejemplo, en el plan Free, 10 ms de CPU).

### 10. Parámetro muerto `precharged` en `enqueue`. Válido (limpieza)
- **Evidencia:** ningún llamador lo pasaba (`grep enqueue(`: `routes/links.ts:50` y `routes/activity.ts:45`). Un `true` habría saltado el cupo.
- **Fix:** se eliminaron el parámetro y su JSDoc. Lo comprueba el typecheck.

## Comprobaciones ejecutadas (snapshot 2026-10-05)

- `bun test tests/review-latest.test.ts`:
  - después: **22 pass / 0 fail**;
  - antes (worktree temporal en `eb98062` con el mismo test): **12 fail** (§1×2, §2, §3, §4×2, §5, §6×3, §7, §8). Los casos que pasan en ambos son guardas, por ejemplo "fails closed".
- `bun test` completo: **220 pass / 0 fail** (28 archivos).
- `bun run typecheck`: OK (raíz, `packages/browser-protocol` y `apps/extension`).
- `bun scripts/e2e-auth.ts` (workerd, D1/R2/Queue/Workflow locales, puertos 3197/8897, estado temporal borrado al terminar):
  - después: **E2E OK, 13 checks**, incluido el 6e nuevo;
  - antes: falla en `ack of 100 (500)`.
  - Se ejecutó sin `bun run build`, porque el diff no toca `src/`. El `dist/` previo se conservó.
- No se repitió la suite Browser/Chromium completa: el diff no toca la extensión ni la UI, y el contrato de las rutas se cubre arriba.
- `git diff --check`: OK.

## Fuentes (consultadas el 2026-10-05)
- Límites de D1, 100 parámetros por consulta, también dentro de `batch()`, y consultas por invocación: https://developers.cloudflare.com/d1/platform/limits/
- `json_each` en D1, con un parámetro JSON en `IN`: https://developers.cloudflare.com/d1/sql-api/query-json/
- Código fijado e instalado de better-auth 1.7.7: `node_modules/better-auth/dist/api/routes/session.mjs` (`getSession`, líneas 229-232) y `node_modules/better-auth/dist/api/rate-limiter/index.mjs` (almacenamiento `database`, líneas 79-185); `better-call` `APIError.statusCode`.

## Límites y decisiones pendientes
- **Hallazgo 3:** el abuso distribuido de los endpoints anónimos de email sigue siendo posible dentro de los topes de coste. Hace falta una decisión del owner sobre Turnstile/CAPTCHA, un proveedor o los límites. No se ha implementado nada externo.
- **Hallazgo 9:** sin cambio. Reabrir solo si la CPU por petición llega a ser un problema, y con una indirección por petición, nunca capturando el env o el ctx de otra.
- **Hallazgo 8:** la reducción del recuento de consultas de D1 por invocación no está demostrada para las sentencias del `batch()`. Solo está demostrada para las búsquedas.
- **Hallazgo 5:** algunos mensajes que antes llegaban como 400 por accidente (errores internos) ahora son el 500 genérico. Se revisó que todas las validaciones intencionales del camino HTTP usan `badRequest`. Si apareciera alguna que no, se vería como un 500 genérico, no como una fuga.
- Fuera de alcance: API keys/FAC-44, facturación/FAC-49, social login, passkeys, MCP y sharing.
