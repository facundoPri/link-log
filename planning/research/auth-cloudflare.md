# FAC-40 — Better Auth y Cloudflare: decisión y contexto de implementación

**Investigación inicial:** 28-09-2026. **Actualización con comentarios del dueño y fuentes oficiales:** 01-10-2026. **Estado:** Better Auth aprobado por el dueño; integración propuesta pendiente de validación. Este documento prepara el próximo trabajo de implementación; no implementa autenticación ni configura servicios.

Se volvió a leer [FAC-40](https://linear.app/facundopri/issue/FAC-40/research-and-approve-authentication-then-implement) mediante Orca el 01-10-2026: está **In Progress**. Su descripción todavía conserva la etapa de investigación/aprobación; los comentarios del dueño sobre este informe resuelven las decisiones de producto que siguen. No se modificó Linear. Contexto relacionado: [FAC-41, aislamiento por usuario](https://linear.app/facundopri/issue/FAC-41/separate-saved-links-by-user), [FAC-44, carga mediante API](https://linear.app/facundopri/issue/FAC-44/implement-a-secure-url-only-upload-api-with-plan-aware-limits) y [FAC-49, planes](https://linear.app/facundopri/issue/FAC-49/research-payment-providers-and-cost-based-plans-paddle-creem), leídos en la investigación inicial.

## 1. Decisiones del dueño

| Tema | Decisión registrada |
| --- | --- |
| Lanzamiento | Público multiusuario y gratuito. Cada persona puede crear su cuenta. |
| Autenticación | Better Auth, con conexión directa a Cloudflare cuando esté documentada; D1 nativo es la propuesta concreta. |
| Login inicial | Email + magic link y email + contraseña, incluyendo verificación y recuperación. |
| Login posterior | Google y GitHub. Sin inicio de sesión con una cuenta Cloudflare. |
| Correo | Cloudflare como servicio inicial de envío, sujeto a provisionamiento y prueba de entrega. |
| Datos | Links, tags y lenses privados por usuario. Sin definiciones compartidas ni sharing inicial. |
| FAC-44 | API keys personales: crear, listar, borrar/revocar y enviar uno o varios links. |
| Desarrollo | Acceso cómodo con una cuenta preparada o mecanismo local equivalente; propuesta concreta en §5. |
| Más adelante | Passkeys para evaluar; MCP y billing fuera del primer alcance. No implementar planes ni entitlements ahora. |

“Local para el usuario” se interpreta como propiedad privada de sus datos dentro del producto público. No implica mantener la base pública en la máquina de cada usuario. **Proveedor aprobado no significa integración probada ni autorización para desplegar desde esta investigación.**

## 2. Lo observado en este worktree

- [`package.json`](../../package.json): React 19, TypeScript y Bun; no están instalados Better Auth, nuqs, Hono ni un framework de routing. [`src/index.ts`](../../src/index.ts) sirve la UI en `127.0.0.1:3000` y proxya `/api/*` a Wrangler en `127.0.0.1:8787`. Compara `Origin` en la frontera del navegador y luego quita `Host` y `Origin`; su `fetch` no configura redirecciones manuales. [`src/api.ts`](../../src/api.ts) usa la API del mismo origen visible al navegador.
- [`wrangler.jsonc`](../../wrangler.jsonc): un Worker con Static Assets SPA y `run_worker_first: ['/api/*']`, D1 `DB`, R2 `CONTENT`, Queues, Workflows y cron. Ya tiene `nodejs_compat`. `AI` y `BROWSER` tienen bindings remotos; que la biblioteca sea local no significa que todo procesamiento sea offline. El ID D1 es un placeholder, no prueba de una base desplegada.
- [`worker/index.ts`](../../worker/index.ts) limita la API a loopback y aplica reglas de origen/JSON en escrituras. **No hay identidad ni autorización por dueño.** `/api/library` lee la biblioteca global; operaciones por ID, contenido, cancelación y uso también necesitan aislamiento. No se encontró implementación de extensión en este checkout.
- Las [migraciones](../../migrations/0001_library.sql), [`worker/store.ts`](../../worker/store.ts) y [`worker/jobs.ts`](../../worker/jobs.ts) muestran tablas sin dueño: links, tags, lenses, relaciones, evaluaciones, resultados, media, batches, jobs y uso. URL original y nombres de tags/lenses son únicos globalmente. Jobs guardan IDs y snapshots de configuración en D1 y continúan mediante Queue/Workflow/cron. R2 usa `links/<linkId>/…`.
- [`scripts/dev.ts`](../../scripts/dev.ts) aplica migraciones **locales** antes de arrancar Wrangler. El README describe funcionamiento local, sin despliegue ni base remota. El estado local y D1 remoto son bases distintas: mover datos exige exportación/importación explícita, además de migrar esquema. [Wrangler D1](https://developers.cloudflare.com/d1/wrangler-commands/) (acceso: 01-10-2026).

## 3. Comparación conservada y elección técnica

| Opción | Compatibilidad documentada y operación | Decisión para Linklog |
| --- | --- | --- |
| **Better Auth + D1 nativo** | Better Auth documenta `database: env.DB`. Usuarios, cuentas, sesiones y verificaciones en D1; cookies en navegador. Operar migraciones, secretos, correo, abuso y actualizaciones. [D1 nativo](https://better-auth.com/blog/1-5), [sesiones](https://better-auth.com/docs/concepts/session-management). | **Recomendada**, dentro del proveedor aprobado. Aprovecha el binding y SQL existentes. Cada plugin debe probarse en este Worker. |
| **Better Auth + Drizzle/D1** | Adaptador oficial Better Auth con `provider: 'sqlite'`; Drizzle documenta su driver D1. Generar esquema auth y luego migraciones ORM agrega otra herramienta. [Better Auth](https://better-auth.com/docs/adapters/drizzle), [Drizzle](https://orm.drizzle.team/docs/get-started/d1-existing). | Alternativa si aparece una necesidad concreta de ORM; no se justifica reescribir la persistencia ahora. |
| **Cloudflare Access** | Autentica entrada mediante políticas Zero Trust e IdP/OTP. Sus cookies/JWT pertenecen a Access; la app sigue necesitando propiedad por recurso. Con Static Assets, `ctx.access` no se transmite al Worker de usuario; protección a nivel Worker no admite WebSockets. [Access/Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). | Adecuado para perímetro privado o administrativo. No será el sistema de cuentas públicas elegido. |
| **Auth propio en Workers/D1** | Workers aporta runtime y almacenamiento; Linklog tendría que resolver protocolos, sesiones y recuperación. No se encontró una solución first-party Cloudflare equivalente a las cuentas completas de Better Auth para este caso. | Complejidad innecesaria con Better Auth aprobado. |

Fuentes de la tabla consultadas el **01-10-2026**. La falta de una solución encontrada es un límite de esta investigación, no una afirmación de inexistencia universal.

### Identidad humana, protección de entrada y credenciales de máquina

Access puede entregar identidad, pero no define quién posee un link. En un perímetro futuro habría que validar firma, issuer y audiencia del JWT, y mantener un ID interno durable; su `sub` puede cambiar al borrar y volver a agregar una persona. Los service tokens identifican automatizaciones y no representan por sí mismos al dueño humano. [JWT Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [identidad Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/), [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) (acceso original: 28-09-2026).

API Shield verifica JWT existentes; Turnstile prueba resistencia a bots. Ninguno crea una cuenta Linklog. La librería OAuth de Workers sirve para autorización de clientes, por ejemplo MCP, y necesita un mecanismo de identidad. El OAuth social de Cloudflare en Better Auth inicia sesión con una **cuenta Cloudflare**; queda descartado por decisión del dueño. [API Shield](https://developers.cloudflare.com/api-shield/security/jwt-validation/), [Turnstile](https://developers.cloudflare.com/turnstile/get-started/), [OAuth Workers/MCP](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [Cloudflare social en Better Auth](https://better-auth.com/docs/authentication/cloudflare) (acceso original: 28-09-2026).

## 4. Integración propuesta con APIs oficiales

### D1, runtime, migraciones y sesiones

Usar una fábrica de auth que reciba el **binding del entorno** y configuración explícita de URL/secreto/correo, con `database: env.DB`. D1 directo está documentado desde 1.5; usa `batch()` y no transacciones interactivas. La guía Workers/Hono usa `nodejs_compat` y un handler de `Request`/`Response`. **Montarlo en el Worker actual sin adoptar Hono es una composición propuesta**, pendiente de spike. [D1](https://better-auth.com/blog/1-5), [Workers](https://better-auth.com/docs/integrations/hono) (acceso: 01-10-2026).

Generar y revisar SQL de auth con la CLI de la versión fijada, incluir sólo los plugins del alcance y versionarlo junto a las migraciones actuales. La documentación permite `getMigrations` para SQLite/D1 con el adaptador integrado; es una posibilidad de tooling, no motivo para migrar automáticamente en cada request o publicar una ruta de migraciones. Aplicar local y remoto separadamente y ensayar copia/recuperación antes de datos reales. [Base de datos](https://better-auth.com/docs/concepts/database) (acceso: 01-10-2026).

Persistir sesiones en D1 y empezar sin cache adicional de sesión en cookie ni almacenamiento secundario: evita otra fuente de consistencia al comprobar revocación. Better Auth documenta sesión de siete días por defecto y renovación; fijar y probar los valores elegidos. Sus cookies son `HttpOnly`, `Secure` en producción y `SameSite=Lax` por defecto. Mantener app y API en **un origen HTTPS público**, sin cookies compartidas entre subdominios salvo necesidad demostrada. [Sesiones](https://better-auth.com/docs/concepts/session-management), [cookies](https://better-auth.com/docs/concepts/cookies), [seguridad](https://better-auth.com/docs/reference/security) (acceso: 01-10-2026).

**Versión y mantenimiento:** el sitio publica **1.7.7 del 30-09-2026**, que corrige un problema crítico al combinar magic link y OAuth en determinadas configuraciones. La 1.7.6 del memo anterior ya no es la base propuesta. Elegir 1.7.7 o una versión posterior corregida tras revisar el estado en la fecha del spike; fijar paquetes compatibles y lockfile. No copiar APIs antiguas de blogs como si fueran las actuales. La política oficial soporta la última versión. [Changelog](https://better-auth.com/changelog), [aviso GHSA-965c-763c-88jm](https://github.com/better-auth/better-auth/security/advisories/GHSA-965c-763c-88jm), [política de seguridad](https://github.com/better-auth/better-auth/security) (acceso: 01-10-2026).

### Login inicial y posterior

Habilitar email/contraseña con email verificado antes de usar la biblioteca; sumar magic link y recuperación. Los callbacks oficiales reciben el destino y enlace para enviarlos. Magic link permite alta por defecto, vence por defecto a los cinco minutos y la documentación actual consume el token en el primer intento. **Caso a cubrir:** si verifica una cuenta existente cuyo email no estaba confirmado, elimina la contraseña previa y revoca sus sesiones; el dueño del email puede establecer otra mediante recuperación. Diseñar el mensaje de UI y probar esta transición. [Contraseña](https://better-auth.com/docs/authentication/email-password), [magic link](https://better-auth.com/docs/plugins/magic-link) (acceso: 01-10-2026).

Google y GitHub tienen proveedores oficiales, con credenciales y callbacks distintos para local/producción; quedan para una segunda etapa. Propuesta de vinculación: misma cuenta interna, vinculación explícita desde sesión y email verificado, sin confiar ciegamente en coincidencia de email ni marcar proveedores como confiables para saltar verificación. Better Auth documenta `disableImplicitLinking` y `linkSocial`; añadir contraseña desde una cuenta creada por magic link requiere un flujo autenticado/recuperación, no una escritura de password desde el cliente. [Google](https://better-auth.com/docs/authentication/google), [GitHub](https://better-auth.com/docs/authentication/github), [cuentas y vinculación](https://better-auth.com/docs/concepts/users-accounts) (acceso: 01-10-2026).

### Envío de correo de Cloudflare

**Sí existe envío transaccional nativo:** Email Sending de Cloudflare Email Service, actualmente **beta**, con binding `send_email` y API `env.EMAIL.send({ to, from, subject, html, text })`. Cloudflare recomienda el constructor estructurado para código nuevo y muestra un ejemplo de magic link. Conectar los callbacks Better Auth a ese binding es **composición de APIs documentadas**, no un adaptador conjunto Better Auth/Cloudflare probado aquí. [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [ejemplo magic link](https://developers.cloudflare.com/email-service/examples/email-sending/magic-link/) (acceso: 01-10-2026).

Enviar a destinatarios arbitrarios exige **Workers Paid**; el envío gratis a destinos previamente verificados no resuelve altas públicas. La tarifa actual incluye 3.000 emails/mes por cuenta y luego USD 0,35 por mil; hay cuota diaria inicial variable. Es costo de infraestructura, separado de que Linklog sea gratis. Hace falta habilitar el servicio, incorporar dominio emisor en Cloudflare y verificar DNS/autenticación de correo y cuota efectiva de la cuenta. [Precio](https://developers.cloudflare.com/email-service/platform/pricing/), [límites](https://developers.cloudflare.com/email-service/platform/limits/), [dominio](https://developers.cloudflare.com/email-service/configuration/domains/) (acceso: 01-10-2026).

Crear una única abstracción de envío para magic link, verificación y reset; plantillas escapadas, URLs generadas por auth y fallo observable sin registrar token/cuerpo. Si se difiere con `ctx.waitUntil`, registrar resultado saneado y ofrecer reenvío controlado: aceptar la petición no garantiza entrega. Cloudflare permite previews del cuerpo/raw y las activa en dominios nuevos; **por inferencia, allí quedarían URLs de login/reset**. Propuesta: desactivar previews en el dominio de auth y limitar acceso operativo a logs. [Logs de email](https://developers.cloudflare.com/email-service/observability/logs/) (acceso: 01-10-2026). Disponibilidad en la cuenta, dominio y entregabilidad no están comprobados.

El catálogo `better-auth-cloudflare` es **comunitario, no oficial ni verificado**. No es necesario para D1 nativo o envío por binding. El plugin oficial Captcha admite Turnstile y puede proteger endpoints seleccionados; no reemplaza autenticación, autorización ni rate limit. [Catálogo](https://better-auth.com/docs/plugins/community-plugins), [Captcha](https://better-auth.com/docs/plugins/captcha) (acceso: 01-10-2026).

### Qué es una passkey

Una passkey permite acceder usando una credencial criptográfica del dispositivo o gestor de credenciales. **Puede desbloquearse con huella, rostro o PIN**; la huella no se envía a Linklog. El autenticador firma un desafío con la clave privada y el servidor verifica con la pública. El vínculo con el sitio reduce el phishing; no es un password guardado ni exige necesariamente un lector de huellas. Puede sincronizarse entre dispositivos o vivir en una llave física, según el autenticador. [FIDO Alliance](https://fidoalliance.org/passkeys/) (acceso: 01-10-2026).

Better Auth ofrece `@better-auth/passkey`, registro desde una sesión, login y gestión de credenciales. Exige `rpID`/`origin` coherentes con el dominio; documenta `localhost` para desarrollo. Su `userVerification` predeterminado es `preferred`; si se exige verificación local, evaluar `required`. Antes de incluirlo hay que probar dispositivos, pérdida/recuperación, eliminación y dominio definitivo. **Propuesta:** incorporarlo después del login inicial como opción, manteniendo recuperación por email; el interés del dueño todavía no aprueba su inclusión en el primer release. [Plugin passkey](https://better-auth.com/docs/plugins/passkey) (acceso: 01-10-2026).

## 5. Desarrollo cómodo sin perder la frontera de seguridad

**Propuesta para desarrollo cotidiano:** preparar dos cuentas ficticias en una D1 local separada, con un comando de seed idempotente y login normal precompletado o asistido en la UI local. Una sesión persistente evita repetir login mientras se desarrolla y la segunda cuenta facilita FAC-41. El seed debe crear también la credencial mediante APIs de auth, nunca inventar el hash. Usar correo simulado y datos de prueba; no adjudicarle automáticamente los links locales reales. Es una recomendación para Linklog, **no un modo oficial de bypass de Better Auth**.

Better Auth sí documenta **Test Utils** para integración/E2E: crea usuarios y sesiones con headers/cookies, mediante una instancia separada como `auth.test.ts`. No agrega rutas públicas, pero expone helpers privilegiados; su recomendación es excluirlo de producción. Es útil para entrar directo en pruebas de UI/aislamiento; `test.login()` no prueba contraseña ni magic link, por lo que esos flujos necesitan pruebas separadas. [Test Utils](https://better-auth.com/docs/plugins/test-utils) (acceso: 01-10-2026).

Evitar un fallback de “usuario por defecto” en el guardia API. El helper/seed sólo debe existir para bindings locales explícitos, sin credenciales de producción y sin endpoint HTTP de auto-login expuesto. Un fixture automatizado puede preparar cookies con Test Utils sin pedir login interactivo. Verificar que producción y previews no importan esa instancia ni ejecutan seed, y rechazan configuraciones de desarrollo; `NODE_ENV` solo no demuestra aislamiento.

Cloudflare documenta que `wrangler dev` simula envío y escribe mensajes en archivos locales; con binding `remote: true` envía correo real. El modo de auth local debe usar la simulación por defecto y mantener esos archivos fuera de Git y logs compartidos. Probar magic links localmente no requiere enviar correo real. [Email local](https://developers.cloudflare.com/email-service/local-development/sending/) (acceso: 01-10-2026).

## 6. Rutas, parámetros y abstracciones de seguridad

Esta sección es una **propuesta de arquitectura**, no APIs ya presentes ni funcionalidades automáticas de Better Auth. Sigue separación de autenticación y autorización, menor privilegio, denegación por defecto y comprobación de cada request. [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) (acceso: 01-10-2026).

### Orden de routing y políticas explícitas

1. Despachar `/api/auth/*` al handler Better Auth con el `Request` sin consumir, **antes** del parser JSON y guardias genéricos de la biblioteca. Auth tiene callbacks GET y endpoints con formatos/métodos propios. Mantener `run_worker_first` para `/api/*` y no devolver SPA ante errores API.
2. Resolver método/ruta de aplicación y política declarada: `public`, `session` o `apiKey` con capacidades requeridas. Una ruta API no declarada no recibe acceso por defecto. No aplicar `requireSession` a todo `/api/auth/*`: impediría login, aunque las operaciones sensibles del handler sí deben conservar sus controles.
3. Crear un contexto autenticado, por ejemplo `Principal { kind: 'session' | 'apiKey', userId, capabilities, credentialId }`. Resolverlo en servidor; nunca aceptar `userId`, rol o capacidades enviados por el cliente. Cada ruta declara qué credencial admite; una API key no habilita automáticamente UI o gestión de cuenta.
4. Validar payload/query/path y ejecutar funciones acotadas al dueño: por ejemplo `getOwnedLink(userId, linkId)`, `libraryForUser(userId)`, `enqueueForUser(userId, input)`. La autorización incluye relaciones y contenido derivados, no sólo verificar que exista sesión.

| Superficie propuesta | Acceso |
| --- | --- |
| Assets públicos, pantalla de login/alta/recuperación | Públicos; sin datos de biblioteca en HTML, estado inicial o cache. |
| Protocolos `/api/auth/*` | Handler Better Auth; controles por endpoint, CSRF/origen y límites. |
| Biblioteca, detalle/contenido, tags/lenses, jobs/batches, uso y preferencias personales | Sesión válida **y** comprobación de dueño. |
| Gestión de API keys | Sesión del dueño; reautenticación para operaciones sensibles según flujo definido. |
| Endpoint FAC-44 para carga URL/batch | API key válida, configuración de usuario y permiso explícito de crear links. |
| Cron, Queue y Workflow | Entradas internas del runtime; resuelven dueño desde D1, sin cookie humana ni credencial de máquina en navegador. |

Devolver `401` sin credencial, `403` para capacidad insuficiente y una respuesta que no revele existencia de IDs ajenos —por ejemplo `404`—. La navegación/visibilidad en React mejora UX; la API protege los datos. Una shell SPA pública no vuelve públicos los recursos. No habrá escritura anónima en bibliotecas reales ni cuenta compartida implícita.

### Cookies, proxy, dominios y abuso

El proxy local necesita validación específica: conservar todas las cookies de respuesta, `Location`, métodos y estados; usar redirecciones manuales para no consumir callbacks en el fetch del proxy. Establecer `baseURL` con el origen visible y lista exacta de `trustedOrigins`; normalizar el hostname local, porque `localhost` y `127.0.0.1` no son el mismo origen. Revisar cómo conserva/transforma `Origin` en lugar de quitarlo para eludir controles. **No desactivar CSRF/origin checks para hacer funcionar local.** La recomendación de proxy surge de inspección del código; aún no se probó. [Seguridad Better Auth](https://better-auth.com/docs/reference/security) (acceso: 01-10-2026).

En producción, secretos sólo del Worker, separación local/preview/producción, dominio canónico y política uniforme para `workers.dev`/previews/dominios alternativos. Custom Domains necesita zona y configuración reales; dominio web y emisor de email son configuraciones distintas. Los links de login deben apuntar al origen permitido. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) (acceso: 01-10-2026), [secretos Workers](https://developers.cloudflare.com/workers/configuration/secrets/) (acceso original: 28-09-2026).

Better Auth usa contadores en memoria por defecto: no asumir que limitan globalmente Workers. Probar `storage: 'database'` y tabla de rate limit en D1, incluyendo concurrencia; si no cumple la protección requerida, evaluar almacenamiento con consumo atómico sin improvisar un adaptador KV. Agregar límites de email, alta/login/reset, carga de URLs y jobs, respuestas saneadas y logs sin tokens/passwords/cookies. Un producto gratuito necesita controles de abuso/costo sin convertirlos en planes pagos. [Rate limit](https://better-auth.com/docs/concepts/rate-limit) (acceso: 01-10-2026).

### nuqs

nuqs encaja como opción para filtros/búsqueda/orden/paginación en la URL y tiene adaptador **React SPA**; no exige migrar a Next.js. No autentica ni autoriza rutas. Sus loaders pueden compartir parsers cliente/servidor, pero no validan reglas de dominio; `strict: true` rechaza errores de parseo y todavía se necesitan límites y esquemas de entrada. Un `linkId` bien formado sigue requiriendo `getOwnedLink`. **Uso propuesto y separable del login**, sin dependencia de seguridad ni instalación aquí. [Adaptadores](https://nuqs.dev/docs/adapters), [uso servidor](https://nuqs.dev/docs/server-side) (acceso: 01-10-2026).

## 7. Identidad, propiedad y clientes

### FAC-41 y migración de datos

- Definir `app_user_id` como el `user.id` estable de Better Auth para este lanzamiento; no hace falta duplicar tablas de personas. Email, login provider y token son atributos/credenciales, no claves de propiedad. Mantener el mismo ID al agregar contraseña, social o passkey.
- Agregar dueño a entidades raíz y registros que sobreviven a borrados. Cambiar unicidad a `(user_id, original_url)` y `(user_id, name)` en tags/lenses. Deduplicar y resolver aliases por usuario. Relaciones `link_tags`, evaluaciones, resultados y media deben unir recursos del mismo dueño; settings personales tampoco pueden quedar globales accidentalmente.
- Reemplazar lecturas globales y operaciones por ID con consultas por dueño, incluyendo uso, snapshots, cancelaciones y reintentos. Validar propiedad antes de crear jobs; Queue/Workflow/cron recuperan identidad del job/batch almacenado, no del cuerpo HTTP. Conservar dueño directamente en `usage_events`: referencias a link/job pueden quedar nulas tras borrar recursos.
- R2 no autoriza mediante su prefijo: comprobar dueño antes de leer/escribir/borrar Markdown y archivos derivados. No exponer bucket ni URLs compartidas por defecto. Recuperación de jobs no debe mezclar tags/lenses o resultados de dos usuarios.
- Migración operativa: inventario y backup D1 local/R2 —incluyendo contenido social y links relacionados ocultos—, cuenta destinataria explícita, cambios de esquema/unicidad revisados, importación con IDs/relaciones conservados, conteos e historial verificados y rollback. **No asignar biblioteca al primer signup ni al fixture de desarrollo.** Falta que el dueño indique la cuenta destinataria.

FAC-40 puede instalar identidad antes de completar FAC-41, pero **la publicación multiusuario debe esperar ambas fronteras**. Login exitoso no prueba aislamiento.

### FAC-44: API keys personales

El plugin oficial `@better-auth/api-key` documenta claves de usuario, hash en almacenamiento, creación/listado y borrado con comprobación de dueño. La clave completa se devuelve al crearla y se omite después. Desactivar con `enabled: false` es una operación de servidor: comprobar propiedad antes de invocarla. **Por defecto no vencen**; fijar caducidad y límites explícitos. [API Key](https://better-auth.com/docs/plugins/api-key) (acceso: 01-10-2026).

Propuesta: mantener `references: 'user'`, almacenamiento D1, hashing habilitado y `enableSessionForAPIKeys: false`. Usar `x-api-key`, verificar una vez por request con `configId` esperado y permiso `links: ['create']`; sólo tras resultado válido tomar `result.key.referenceId` como dueño. Verificar validez sin `permissions` no impone el alcance requerido. La conversión a sesión ampliaría la suplantación a más endpoints y la documentación la desaconseja. [Referencia](https://better-auth.com/docs/plugins/api-key/reference), [funciones avanzadas](https://better-auth.com/docs/plugins/api-key/advanced) (acceso: 01-10-2026).

La UI mostrará secreto una sola vez, nombre, identificador parcial y fechas; revocar/borrar debe invalidar el siguiente request, pendiente de probar consistencia D1. No guardar la key en query strings, logs ni enlaces. Sólo aceptar URLs y tamaño/batch acotados; reutilizar dedupe por dueño y enqueue del mismo servicio que la UI. No otorgar lectura, borrado, creación de otras keys o permisos de cuenta. Respuestas por lote, idempotencia y estado asíncrono se especificarán en FAC-44; webhooks quedan aparte. Conservar validación de destinos/redirecciones para evitar abuso del fetch/extracción, además de auth.

Soporte documentado del plugin y adaptador no prueba aún hash/verificación/revocación/límites bajo **D1 + este Worker**. No habilitar FAC-44 antes de su prueba. El rate limit del plugin se aplica al verificar: no suponer cuotas a partir de ejemplos ni contarlas dos veces con verificaciones duplicadas.

### Browser, extensión, MCP y FAC-49

`windowId`, origen, permisos de host y conexión al Browser no prueban usuario. La extensión futura deberá vincularse a una cuenta y mantener credenciales con revocación; sus acciones usan la misma comprobación de dueño. La guía oficial Better Auth muestra orígenes `chrome-extension://<ID>` específicos y permisos de host; no usar wildcard de todas las extensiones. El ejemplo Plasmo no demuestra compatibilidad con la extensión de otra rama. [Guía de extensión](https://better-auth.com/docs/guides/browser-extension-guide) (acceso: 01-10-2026).

Un MCP futuro que lea links necesitará una capacidad de lectura separada; una API key de carga no la concede. Para delegación a terceros, investigar protocolo OAuth del cliente y soporte vigente del plugin MCP; no convertir hoy Linklog en servidor OAuth ni dar una key universal a un agente. [MCP Better Auth](https://better-auth.com/docs/plugins/mcp) (acceso: 01-10-2026). FAC-49 se difiere: sin SDK de pagos, planes ni tablas de entitlements iniciales. Cuando se retome, mapear cliente/suscripción externa al mismo `app_user_id`.

## 8. Spike mínimo y secuencia para el próximo ticket

**Recomendación técnica:** Better Auth con **D1 nativo + sesiones D1 + correo por binding Cloudflare**, login inicial magic link/contraseña y políticas pequeñas por ruta/recurso. **Confianza alta en soporte D1 documentado; media en la composición completa para Linklog.** Falta evidencia ejecutada del proxy, plugins, límites y entorno desplegado. Drizzle queda como alternativa ante un bloqueo concreto; Access conserva utilidad para administración privada.

El próximo trabajo comienza con un spike local en datos descartables; ningún paso de este checklist se ejecutó aquí:

1. **Compatibilidad y esquema:** revisar versión corregida actual, fijar core/CLI/plugins compatibles; generar SQL y aplicarlo en D1 local vacía con el runtime actual. Probar arranque, build y esquema. No migrar por request ni sustituir datos existentes.
2. **Frontera HTTP:** montar handler crudo y probar UI Bun → proxy → Wrangler y Worker directo. Login, `Set-Cookie` múltiple, redirects, sesión tras reinicio, expiración/logout y rechazo de origen no confiable. Sin bypass ni CSRF desactivado.
3. **Métodos iniciales:** alta/verificación email/contraseña, magic link nuevo/existente, consumo repetido/expirado, cuenta sin verificar con contraseña previa, reset y fallo/reenvío de email simulado. Probar login real además de Test Utils.
4. **Desarrollo:** seed repetible A/B, acceso preparado y cambio de cuenta; separar fixtures/datos reales. Comprobar que producción no importa helpers ni habilita cuentas por defecto.
5. **Dos usuarios/FAC-41:** ambos guardan misma URL/tag/lens; no comparten datos. IDs ajenos fallan en lecturas, mutaciones, R2, batches/jobs y uso; repetir tras procesamiento/retry/cron y borrado. Ensayar backfill con conteos/relaciones y dueño explícito en copia.
6. **FAC-44:** key A carga uno/batch sólo para A; inválida, expirada, revocada, permiso incorrecto o configuración distinta se rechazan. B no lista/revoca keys A; key de carga no abre biblioteca ni cuenta. Probar límites concurrentes D1 y duplicados.
7. **Antes de publicación, en un entorno autorizado:** provisionar D1/R2, dominio canónico, secretos y Email Sending. Probar entrega real, DNS, cookies HTTPS, aislamiento A/B y todos los hostnames/previews. Mantener loopback cerrado hasta completar autorización; no retirar el guardia sólo porque auth inicializa.

**Entrega sugerida del ticket de implementación:** fábrica auth y cliente React; servicio de correo; políticas/contexto autenticado; consultas por dueño y migraciones; UX alta/login/logout/recuperación; tooling local; pruebas y runbook de provisionamiento/rollback. Coordinar FAC-41 para que la entrega pública no quede con identidad nueva y biblioteca global. FAC-44 continúa sobre esas abstracciones. Google/GitHub, passkeys, MCP y pagos serán incrementos posteriores.

## 9. Inputs pendientes y límites

Quedan decisiones operativas, sin volver a abrir proveedor, tipo de lanzamiento o gratuidad:

- ¿Cuál será el dominio público y dominio/dirección remitente? ¿Qué cuenta Cloudflare operará D1/R2 y Workers Paid/Email Sending, y cuál es su cuota habilitada?
- ¿A qué cuenta verificada se importan los links locales existentes? Mantener copia hasta validar propiedad, conteos y contenido.
- ¿Se desea adelantar passkeys o mantener la segunda etapa propuesta? Google/GitHub quedan posteriores según el alcance inicial comentado.
- Para FAC-44: concretar TTL de keys, límites antiabuso y contrato de respuesta por lote. Para extensión/MCP: clientes reales y mecanismo de conexión/delegación, sin ampliar permisos de carga por anticipado.

**Evidencia:** se inspeccionó este worktree y se refrescaron fuentes principales el 01-10-2026; referencias históricas conservadas indican 28-09-2026. Decisiones aprobadas vienen de comentarios del dueño, no de documentación externa. No se configuraron proveedores, secretos, dominio, Email Sending ni D1 remoto; no se implementó ni ejecutó login, envío real, API key, passkey, migración o aislamiento entre usuarios. La elección está aprobada; seguridad y compatibilidad operativa siguen pendientes de las pruebas concretas anteriores.
