# Publicar la extensión de Linklog en la Chrome Web Store

Investigación para FAC-172 (decisión de canal), FAC-43 (entrega) y FAC-173 (presentación y first-run). No implementa nada.
Todas las fuentes se consultaron el **2026-11-25**. Los links a developer.chrome.com apuntan a la versión inglesa (`?hl=en`; sin ese parámetro algunas páginas salen en otro idioma). Lo que no pude confirmar está en [No verificado](#no-verificado).

## Resumen y recomendación

1. **Ir a la Chrome Web Store, con visibilidad "Unlisted" primero**, y usar GitHub como respaldo. La complejidad es acotada: cuenta con pago único, un listing, una política de privacidad y justificaciones de permisos. No hay requisitos que no podamos cumplir hoy (ver [Tareas](#tareas-para-llegar-a-publicar)).
2. **El riesgo real es el tiempo de revisión, no la complejidad.** La revisión suele tardar "unos días, hasta unas semanas", y desarrollador nuevo, extensión nueva y permisos peligrosos la alargan ([review-process](https://developer.chrome.com/docs/webstore/review-process)). Nuestro manifest suma `tabs` y un `optional_host_permissions` de `http://*/*` y `https://*/*`. Hay que arrancar la cuenta y el primer envío cuanto antes.
3. **Caemos a GitHub** si el primer envío no está publicado a tiempo para la fecha de lanzamiento (el dueño la fija), o si la revisión rechaza `tabs` o el acceso opcional a todos los sitios y no podemos reducirlos sin romper el producto. Ambos canales pueden coexistir: la Web Store como CTA principal y el ZIP de GitHub como alternativa documentada.
4. **Arc cambia la conversación.** Arc deja de funcionar el **2026-12-22** ([arc.net](https://arc.net/)); FAC-161 ya difirió Arc a Post-release. Arc instala desde la Web Store, pero no expone `tabGroups`. Conviene no gastar esfuerzo de lanzamiento en Arc y apuntar el soporte a Chrome.
5. **Los updates se pueden automatizar** con la API v2 y una service account (o OAuth con refresh token), pero **el primer envío es manual** (la API no crea items). Cada update pasa por revisión, y el flujo actual de GitHub Releases puede seguir como está.

## 1. Estado actual (repo)

| Hecho | Fuente |
| --- | --- |
| MV3, `name: Linklog`, versión `0.2.0`, `minimum_chrome_version: 116` | `apps/extension/scripts/build.ts` (`manifest()`) |
| Permisos: `storage`, `scripting`, `tabGroups`, `tabs` | ídem |
| `host_permissions` vacío en el build empaquetado (solo se llena con `LINKLOG_EXTRA_HOSTS`, prohibido al empaquetar) | ídem, `zip()` |
| `optional_host_permissions: ["http://*/*", "https://*/*"]`, pedido en runtime desde `connect.html` con el botón "Allow page content" | ídem; `apps/extension/src/pages/connect.html` |
| Content script `bridge.js` en `http://localhost/*`, `http://127.0.0.1/*` y los orígenes de `EXTENSION_ORIGINS` | ídem; `LOCAL_BRIDGE_MATCHES` en `packages/browser-protocol/src/keys.ts` |
| Íconos 16/32/48/128 generados por código (cuadrado verde redondeado que llena todo el lienzo) | `build.ts`, `icon()` |
| El código no fija el ID de la extensión: usa `chrome.runtime.id` | `apps/extension/src/background/index.ts:162,205` |
| Release en GitHub: `extension-v0.2.0` con un asset `linklog-extension-0.2.0.zip` (58 692 bytes), publicado 2026-11-25 | `gh release view extension-v0.2.0` |
| La web compara su versión esperada con la instalada y linkea a `https://github.com/facundoPri/link-log/releases/latest` | `src/browser/extensionVersion.ts` |
| CI de release: push a `main` con cambios en la extensión publica `extension-v<version>` una sola vez; `check.yml` obliga a subir la versión | `.github/workflows/extension-release.yml` |

La página Connect ya explica qué lee la extensión, que el texto de las páginas solo sale del navegador cuando un lens lo evalúa y que guardar una pestaña envía solo su URL. Es la base de la divulgación que la Web Store exige (ver §3).

## 2. Requisitos y costo

| Tema | Qué dice la fuente | Fuente |
| --- | --- | --- |
| Cuenta | Hay que registrarse como desarrollador CWS, aceptar el acuerdo y pagar una **tarifa única** de registro desde el [Developer Dashboard](https://chrome.google.com/webstore/devconsole). El email de la cuenta no se puede cambiar después (hay que crear otra cuenta y transferir los items). | [register](https://developer.chrome.com/docs/webstore/register) |
| Monto | **US$5.00**, según el anuncio de Google de 2020. La página actual de registro no repite el monto. | [Chromium Blog, 2020-03](https://blog.chromium.org/2020/03/new-developer-dashboard-and.html) |
| Países | Solo se puede registrar desde los países listados en la página de registro. | [register](https://developer.chrome.com/docs/webstore/register) |
| 2-step verification | Para publicar o actualizar una extensión existente, la cuenta de Google debe tener verificación en 2 pasos. | [using-api](https://developer.chrome.com/docs/webstore/using-api#prerequisites) |
| Perfil de cuenta | Obligatorios: nombre de publisher y email de contacto verificado (llega un link). La dirección física solo se pide si hay compras o suscripciones. | [set-up-account](https://developer.chrome.com/docs/webstore/set-up-account) |
| Trader / non-trader | Los desarrolladores se identifican como trader o non-trader (regla de la UE sobre consumidores) y la declaración es responsabilidad del desarrollador. Si se declara non-trader, los consumidores ven que sus derechos de consumo no aplican. Para traders, la tienda recoge y publica nombre legal y contacto y puede pedir documentos. | [trader-disclosure](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure) |
| Visibilidad | `Public` (listado), `Unlisted` (sin página en el store, instala quien tenga la URL) y `Private` (solo trusted testers por cuenta de Google o Google Groups). | [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution) |
| Beta paralela | Se puede publicar un item "BETA"/"TESTING" en paralelo al de producción, como privado, unlisted o público. Debe llevar "DEVELOPMENT BUILD" o "BETA" al final del nombre y "THIS EXTENSION IS FOR BETA TESTING" en la descripción. | [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution#publish-a-test-version) |
| Cambiar de visibilidad | La guía documenta pasar de **Private** a Public o Unlisted: se cambia la visibilidad y se republica. No describe el paso de Unlisted a Public (ver [No verificado](#no-verificado)). Volver hacia atrás (publicado a privado) exige despublicar, cambiar a Private y republicar; volver a hacerla pública exige enviar una versión nueva, que pasa otra vez por revisión. | [update](https://developer.chrome.com/docs/webstore/update#upgrade-your-item) |

**Se puede empezar unlisted o privado:** sí, con las salvedades de arriba. Publicar unlisted evita el listing de búsqueda pero **no está documentado que evite o acorte la revisión** (ver [No verificado](#no-verificado)); el documento de revisión dice que todos los envíos pasan por el mismo sistema.

## 3. Revisión: tiempos y permisos

### Tiempos

- "Para la mayoría de las extensiones, la revisión termina en unos días, pero puede tardar hasta unas semanas" ([review-process](https://developer.chrome.com/docs/webstore/review-process#review-times)).
- Señales que hacen que el revisor mire más de cerca: **desarrolladores nuevos, extensiones nuevas, permisos peligrosos y cambios de código grandes** (misma fuente). Nuestro primer envío tiene las tres primeras.
- También alargan la revisión los host permissions amplios (`*://*/*`, `https://*/*`, `<all_urls>`), los permisos de ejecución sensibles (la guía nombra `tabs`), mucho código y el código difícil de revisar. La ofuscación está prohibida; la minificación se permite pero dificulta la revisión (misma fuente). Nuestro build usa `minify: false` (`build.ts`), lo que ayuda.
- Tras un rechazo o advertencia, la siguiente revisión puede tardar más (misma fuente).
- Las imágenes promocionales se revisan por separado, "dentro de una semana" ([images](https://developer.chrome.com/docs/webstore/images)).
- Un rechazo llega por email al publisher con la política violada y cómo apelar. Un update en revisión no afecta a la versión publicada ([update](https://developer.chrome.com/docs/webstore/update#submit-the-update)), pero una violación hallada en un envío puede disparar una revisión de la versión publicada y otras medidas si la violación también está ahí ([review-process](https://developer.chrome.com/docs/webstore/review-process#rejection)).

### Permisos de nuestro manifest

| Permiso | Qué muestra Chrome al instalar | Qué hacer | Fuentes |
| --- | --- | --- | --- |
| `tabs` | "Read your browsing history" | **Justificar.** Sin `tabs` ni host permission no se leen `url`, `title` ni `favIconUrl` de las pestañas, y Browser view los necesita. La guía lo cita como permiso que "debe verificarse como necesario". | [permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list), [declare-permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [review-process](https://developer.chrome.com/docs/webstore/review-process#notable-factors-that-increase-review-time) |
| `tabGroups` | "View and manage your tab groups" | **Justificar.** Es la función de agrupar. En Arc la API no existe (ver §6). | [permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list) |
| `scripting` | Sin advertencia en la lista. `executeScript` solo actúa en pestañas con host permission concedida. | **Justificar:** se usa `chrome.scripting.executeScript` para extraer contenido (previews y lenses) en pestañas donde el usuario concedió acceso. | [permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list) |
| `storage` | Sin advertencia | Justificar en una línea: `chrome.storage.session` para resultados de lenses y `chrome.storage.local` para el aspecto de los grupos enlazados y la concurrencia elegida (`background/index.ts`, `groups.ts`, `loader.ts`). | [permissions-list](https://developer.chrome.com/docs/extensions/reference/permissions-list) |
| `optional_host_permissions` `http://*/*`, `https://*/*` | No se muestra al instalar. Al concederse, Chrome lo describe como "read and change all your data on all websites" (así lo anticipa la página Connect). | **Mantener opcional.** Es el patrón que la guía recomienda ("pedir permisos en runtime"). **Es lo que más probablemente alargue o complique la revisión**: la guía lista `https://*/*` entre los host permissions amplios, y la política de "minimum permission" **también aplica a los permisos opcionales** ("minimally-scoped optional permissions"). Ojo: hoy "Allow page content" pide **los dos patrones de una vez** (`CONTENT_ORIGINS` en `pages/shared.ts`), no por pestaña ni por sitio; la justificación tiene que explicar por qué previews y lenses necesitan todas las pestañas, o habrá que pedir por sitio. | [permission-warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings), [review-process](https://developer.chrome.com/docs/webstore/review-process#notable-factors-that-increase-review-time), [user-data-faq, Minimum Permission 1–2 y 5](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), `connect.html`, `shared.ts` |
| Content script en `localhost`/`127.0.0.1` y en el origen de producción | Advertencia de acceso a esos orígenes (no verificada) | **Reducir para el build de la tienda:** dejar solo el origen de producción. `localhost` es de desarrollo y regala una línea más para justificar. Decisión de producto: ¿el build de GitHub conserva `localhost`? | `build.ts`, `keys.ts` |

Principios que citar en las justificaciones: pedir "los permisos más estrechos necesarios" y no pedir permisos para funciones futuras ([policies, Use of Permissions](https://developer.chrome.com/docs/webstore/program-policies/policies#use-of-permissions)). Un permiso excesivo "se verá como habilitar funciones no relacionadas, lo que es una violación de política" ([single-purpose FAQ](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)). Si el dashboard lista un permiso que no usamos, hay que quitarlo del manifest y subir otra versión ([privacy tab](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)). La FAQ de datos además recomienda listar los permisos y sus razones en la ficha de la tienda o en una página "about" de la extensión ([user-data-faq, Minimum Permission 4](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)).

**Si agregamos un permiso con advertencia en una versión futura**, Chrome deshabilita la extensión hasta que el usuario lo acepte ([permission-warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)). Conviene decidir el set de permisos antes de publicar y no cambiarlo sin necesidad.

### Single Purpose

La política exige un propósito "estrecho y fácil de entender" ([policies, Quality Guidelines](https://developer.chrome.com/docs/webstore/program-policies/policies#quality-guidelines)). La FAQ acepta dos formas: un área temática estrecha o una **función de navegador estrecha**, y cita "tab management" como ejemplo de la segunda ([FAQ](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)). Propuesta de enunciado para el campo *Single purpose description*:

> Connects Linklog's Browser view to the tabs and tab groups of the user's browser window, so they can review, group and save their open tabs in Linklog.

Riesgo: leer el contenido de las páginas para lenses con IA remota y extracción puede parecer una segunda función. Se defiende como parte de "revisar tus pestañas abiertas en Linklog", pero el texto del listing debe presentarla así y no como un clipper aparte.

## 4. Qué preparar

| Pieza | Requisito | Estado | Fuente |
| --- | --- | --- | --- |
| Manifest | `name`, `version`, `icons`, `description` (máx. 132 caracteres). El manifest no se edita en el dashboard. La versión debe crecer en cada subida. | Cumple (la descripción mide ~77 caracteres). | [prepare](https://developer.chrome.com/docs/webstore/prepare) |
| ZIP | Manifest en la raíz del ZIP. | `extension:package` ya lo hace. | [prepare](https://developer.chrome.com/docs/webstore/prepare#zip-your-extension-files) |
| Ícono de la tienda | PNG 128×128; el arte real debe medir 96×96 (cuadrado) con 16 px transparentes por lado; sin borde. | **Revisar:** nuestro ícono generado llena todo el lienzo, sin el margen de 16 px. | [images](https://developer.chrome.com/docs/webstore/images#extension-icon) |
| Capturas | Mínimo 1, máximo 5; 1280×800 o 640×400; esquinas cuadradas, sin padding; deben mostrar la experiencia real. | Falta. Hay capturas de validación en `docs/browser-validation/` para reutilizar como base. | [images](https://developer.chrome.com/docs/webstore/images#screenshots), [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#graphic-assets) |
| Promo tiles | Pequeño 440×280 y marquee 1400×560 (opcionales; para destacar hace falta el marquee). Evitar texto y no usar solo una captura: deben comunicar la marca. | Opcional. | [images](https://developer.chrome.com/docs/webstore/images#promotional-images) |
| Descripción larga, categoría, idioma | Obligatorios. Empezar con una frase concisa de lo que hace; sin keyword spam. | Falta. | [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#product-details) |
| Homepage URL y Support URL | Opcionales pero recomendados; "Official URL" requiere verificar el sitio en Search Console. | Falta decidir (ver FAC-173). | [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing#additional-fields) |
| Pestaña Privacy: single purpose, justificación por permiso, código remoto, uso de datos | Todos obligatorios. Debemos marcar **"No, no uso código remoto"** (nuestro `extract` va empaquetado). | Falta. | [privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) |
| Política de privacidad | Obligatoria si se manejan datos de usuario; debe decir cómo se recogen, usan y comparten, con todos los destinos, y estar enlazada en el dashboard. | Falta publicarla. | [policies, Privacy Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#privacy-policy) |
| Pestaña Distribution | Visibilidad, regiones, y si hay compras. | Decidir. | [distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution) |

### Datos de usuario y Limited Use

- La FAQ de datos de usuario trata como "datos de usuario" el contenido de sitios web y la **actividad de navegación**, incluidos dominios y URLs; copiar contenido de sitios que visita el usuario exige divulgación. También exige divulgar aunque el dato solo se procese localmente ([user-data-faq](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), preguntas 2–4).
- Limited Use: solo recoger lo necesario para el propósito único; la actividad de navegación solo si es necesaria para una función visible y descrita de forma destacada en la página de la tienda y en la interfaz; no transferir a terceros salvo para prestar la función; no permitir que humanos lean los datos salvo excepciones; sin venta ni publicidad ([limited-use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)).
- Hay que publicar una **declaración afirmativa de Limited Use** en un sitio del producto (por ejemplo en la política de privacidad). El texto de ejemplo que da la política: "The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements." (misma fuente, punto 6).
- **Divulgación destacada con consentimiento dentro de la interfaz**: debe estar en la UI del producto, requerir una acción afirmativa antes de recoger o manejar los datos y no puede estar solo en la descripción de la tienda ni en la política ([user-data-faq, pregunta 10](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)). La política dice además "prior to installation" ([policies, Disclosure Requirements](https://developer.chrome.com/docs/webstore/program-policies/policies#disclosure-requirements)); cómo se compatibiliza con "dentro de la UI" no está claro (ver [No verificado](#no-verificado)). Ojo: `tabs` lee URLs y títulos desde la instalación, antes de pasar por Connect. La página Connect ya hace esto con "Allow page content"; hay que revisar que menciona el envío a IA remota/extracción.
- Los datos deben viajar por conexión segura ([user-data-faq, pregunta 9](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)). El origen de producción es HTTPS; `localhost` no lo es, otra razón para quitarlo del build de tienda.
- La divulgación del dashboard (casillas de tipos de datos y certificaciones) debe coincidir con la política y con el comportamiento real; si se contradicen, la extensión puede retirarse ([policies, Listing Requirements](https://developer.chrome.com/docs/webstore/program-policies/policies#listing-requirements)).

## 5. Updates desde CI

**La API v2 no crea items.** El primer ZIP se sube a mano en el dashboard y se completan las pestañas Store listing y Privacy; después la API sube y publica versiones ([using-api](https://developer.chrome.com/docs/webstore/using-api#prerequisites), [api](https://developer.chrome.com/docs/webstore/api)).

| Paso | Detalle | Fuente |
| --- | --- | --- |
| Autenticación | OAuth 2.0 con refresh token, o una **service account** (que se agrega por email en el dashboard, sección Account). La service account no necesita roles en Google Cloud. | [using-api](https://developer.chrome.com/docs/webstore/using-api), [service-accounts](https://developer.chrome.com/docs/webstore/service-accounts) |
| Scope | `https://www.googleapis.com/auth/chromewebstore` para subir y publicar. | [using-api](https://developer.chrome.com/docs/webstore/using-api#authorization) |
| Identificadores | Publisher ID (Publisher > Settings) e item ID (32 caracteres, igual al ID de la extensión). | [using-api](https://developer.chrome.com/docs/webstore/using-api#obtain-your-publisher-id) |
| Flujo | Subir versión en el manifest → `upload` del ZIP → consultar `fetchStatus` si `IN_PROGRESS` → `publish` (envía a revisión) → `fetchStatus` para el estado de la revisión. | [using-api](https://developer.chrome.com/docs/webstore/using-api#publishing-workflow) |
| Endpoints | `https://chromewebstore.googleapis.com/v2/publishers/PUBLISHER_ID/items/EXTENSION_ID:fetchStatus` y `:publish`; también `:cancelSubmission`. | [using-api](https://developer.chrome.com/docs/webstore/using-api#example-http-requests) |
| Visibilidad | `publish` usa la visibilidad vigente; si se cambió a mano en el dashboard, hay que publicar una vez a mano antes de que la API vuelva a funcionar. | [using-api](https://developer.chrome.com/docs/webstore/using-api#publish-an-item) |
| Tamaño y versión | Paquete máximo 2 GB; `upload` falla si no subimos la versión. | [using-api](https://developer.chrome.com/docs/webstore/using-api#upload-a-package-to-update-an-existing-store-item) |
| Revisión por update | Es "esencialmente la misma revisión" que para items nuevos; el tiempo depende de la naturaleza del item y del alcance de los cambios. Un envío en revisión no afecta a los usuarios actuales. | [update](https://developer.chrome.com/docs/webstore/update#review-process) |
| Publicación diferida | Se puede enviar sin publicar al aprobarse; hay hasta **30 días** para publicar, luego vuelve a borrador. | [update](https://developer.chrome.com/docs/webstore/update#deferred-publishing-option) |
| Rollback | Re-publica la versión anterior bajo un número nuevo, vigente "en menos de un minuto" y sin revisión. | [rollback](https://developer.chrome.com/docs/webstore/rollback) |
| Rollout por porcentaje | Solo con más de 10 000 usuarios activos a 7 días. No aplica por ahora. | [update](https://developer.chrome.com/docs/webstore/update#set-partial-rollout-percentage) |
| Verified CRX uploads | Opcional: exige firmar cada update con una clave propia; mitiga una cuenta comprometida. | [update](https://developer.chrome.com/docs/webstore/update#protect-your-package-updates) |
| Cliente OAuth no verificado | Google puede no dar estado "verified" a apps con el scope de escritura; no bloquea el uso personal. | [api](https://developer.chrome.com/docs/webstore/api#client-verification) |

### Cómo encaja con el release actual

El workflow `extension-release.yml` ya es idempotente por versión, valida con `tsc` y tests, genera el ZIP y crea el GitHub Release; `check.yml` obliga a subir `version` en cada PR que toque la extensión. Esto es compatible con la tienda, que también exige una versión estrictamente mayor. Propuesta de integración (no implementada):

- Un job adicional, **después** de crear el release de GitHub, que suba ese mismo ZIP con `upload` + `publish` si existen los secretos de la tienda; así GitHub sigue siendo el origen de verdad del artefacto.
- Cuidado: el release de GitHub y la publicación en la tienda dejan de ser atómicos. Un update rechazado en la revisión no deja la tienda en la versión del release de GitHub. La web avisa "extensión vieja" comparando contra la versión del repo (`EXPECTED_EXTENSION_VERSION`); con la tienda hay un desfase de días mientras se revisa. Hay que decidir qué ve el usuario con la versión "esperada" aún en revisión.
- El ZIP de la tienda no debe incluir lo que el paquete ya excluye (`.map`, tests, fixtures, env); el `zip()` actual lo comprueba.
- Un reintento de `publish` sobre una versión ya enviada no está documentado (ver [No verificado](#no-verificado)); el job debe consultar `fetchStatus` antes de publicar para ser idempotente, como ya hace el chequeo de release de GitHub.

## 6. Arc

| Hecho | Fuente |
| --- | --- |
| Arc está basado en Chromium y "soporta el 100 % de las extensiones que soporta Chrome". | [arc.net/faq](https://arc.net/faq) |
| **Arc deja de funcionar el 2026-12-22**: ese día se desactivan las cuentas y la app deja de abrir; desde el 2026-10-22 no se crean cuentas nuevas. Lo reemplaza Dia, que importa extensiones. | [arc.net](https://arc.net/) |
| Instalar en Arc desde la Web Store: el comando "Add Extension…" de la command bar "abre la Chrome Web Store para agregar una extensión a Arc". | [start.arc.net/command-bar-actions](https://start.arc.net/command-bar-actions) |
| Arc y Dia no exponen `chrome.tabGroups`; en nuestro background `chrome.tabGroups.onMoved` rompe el service worker al cargar. | FAC-161 (comentario del 2026-11-04, con el aviso "No verificado en una instalación de Arc"), [reporte citado](https://claudeissues.com/issue/19268-support-chromium-browsers-without-tabgroups-api-dia-arc-etc) |
| El dueño difirió Arc a Post-release: "ahora usa Chrome". | FAC-161, comentario del 2026-11-04 |

Consecuencias:

- Publicar en la tienda **no resuelve** Arc: el bloqueo es de la API, no del canal de instalación.
- Con Arc apagándose en cuatro semanas, el costo de soportarlo (FAC-161) rinde poco. Lo que sí importa es que la ficha de la tienda no prometa Arc, y que FAC-173 no sugiera funciones de grupos donde no funcionan.
- FAC-172 todavía dice "Chrome and Arc remain supported targets" y FAC-43 pide verificar ambos; FAC-161 lo reemplazó el 2026-11-04. Conviene que el dueño confirme el alcance en la sesión de FAC-172.
- Dia (el reemplazo) es otro destino posible; no lo investigué (ver [No verificado](#no-verificado)).

## 7. Alternativa GitHub (ZIP sin empaquetar)

Pasos que hoy exige el release (del texto del workflow): bajar el ZIP, descomprimirlo en una carpeta fija, abrir `chrome://extensions`, activar **Developer mode**, **Load unpacked**, elegir la carpeta, conceder acceso desde la página Connect. Para actualizar: descomprimir encima y pulsar ↻.

| Fricción | Detalle | Fuente |
| --- | --- | --- |
| Pasos manuales | Developer mode y *Load unpacked* son el flujo documentado para extensiones sin empaquetar. | [Chrome extensions: hello world](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) |
| Sin actualización automática | Hay que repetir el proceso por cada versión; la web ya avisa si la versión instalada es vieja. | `extensionVersion.ts`, release notes |
| Carpeta que no se puede borrar | La extensión vive donde se descomprimió. | Workflow `extension-release.yml` |
| Aviso en cada arranque ("Disable developer mode extensions") | Lo reportan foros y artículos; **no encontré fuente oficial** de Google. | Ver [No verificado](#no-verificado) |
| Exposición | Una extensión de la Web Store pasó revisión; la de GitHub no. Pero la "confianza" de Enhanced protection no llega enseguida: con "Enhanced protection" de Safe Browsing, Chrome muestra "This extension is not trusted by Enhanced Safe Browsing" al instalar una extensión de un desarrollador no confiable, y **a un desarrollador nuevo le lleva en general unos meses** volverse confiable. Nuestros primeros usuarios con Enhanced protection verán ese aviso (con "Continue to install"). | [Chrome Help](https://support.google.com/chrome/answer/2664769) |

**¿Conviene tener las dos?** Sí, con un solo origen de verdad: el release de GitHub sigue produciendo el ZIP (útil para desarrollo, beta y respaldo), y la tienda recibe ese mismo ZIP. Costo: mantener dos instrucciones de instalación y dos IDs de extensión. El ID de la tienda es distinto del ID de una carga sin empaquetar; el código no lo fija (`chrome.runtime.id`), así que las dos instalaciones funcionan, pero si el usuario instala ambas tendrá dos extensiones Linklog. La página de descarga debe decir cuál elegir.

## 8. Recomendación

**Camino:** Chrome Web Store como canal principal, `Unlisted` en el primer envío (pasar a `Public` después implica cambiar la visibilidad y republicar; si eso pasa por otra revisión no está documentado), GitHub Releases como alternativa y artefacto de origen. Chrome es el único target comprometido; Arc/Dia quedan fuera del lanzamiento (FAC-161).

**Condiciones para caer a GitHub** (propuestas para FAC-172; el dueño decide el plazo):

1. El primer envío no está publicado N días antes del lanzamiento (N lo fija el dueño; la fuente solo promete "unos días, hasta unas semanas").
2. La revisión rechaza `tabs` o el acceso opcional a todos los sitios y no podemos justificarlos ni reducirlos sin perder Browser view.
3. La cuenta no se puede crear (país no soportado o falla de verificación o pago).

Si ocurre cualquiera, el CTA apunta a `releases/latest` (como hoy) y se completa la guía de instalación; la solicitud a la tienda sigue en paralelo.

### Tareas para llegar a publicar

| # | Tarea | Quién |
| --- | --- | --- |
| 1 | Crear cuenta de desarrollador CWS con un email dedicado, pagar la tarifa y activar 2-step verification | Dueño |
| 2 | Completar publisher name, verificar el email de contacto y declarar trader / non-trader | Dueño |
| 3 | Redactar y publicar la política de privacidad (incluye la declaración de Limited Use) en el dominio de Linklog | Agente + dueño (revisa) |
| 4 | Decidir qué orígenes lleva el build de la tienda (solo producción, sin `localhost`) y confirmar `EXTENSION_ORIGINS` | Dueño decide, agente implementa |
| 5 | Rehacer el ícono de 128 px con el margen transparente de 16 px | Agente |
| 6 | Producir 1–5 capturas de 1280×800 (y opcionalmente promo tiles) | Agente (FAC-173) |
| 7 | Escribir descripción corta (≤132), larga, single purpose y justificación de cada permiso (§3) | Agente + dueño |
| 8 | Verificar con el *Extension Update Testing Tool* o *Pack Extension* las advertencias que ve el usuario | Agente |
| 9 | Subir el primer ZIP a mano, completar listing/privacy/distribution y enviar a revisión como Unlisted, **con publicación diferida** | Dueño |
| 10 | Probar la instalación desde la URL de la tienda hasta una extensión conectada a producción | Agente (FAC-43) |
| 11 | Crear proyecto de Cloud, habilitar la Chrome Web Store API, crear la service account y agregarla en el dashboard | Dueño |
| 12 | Agregar al workflow un job de `upload` + `publish` con secretos del repositorio, idempotente vía `fetchStatus` | Agente |
| 13 | Cambiar el CTA y `LATEST_EXTENSION_URL` a la tienda y actualizar el aviso de versión vieja | Agente |
| 14 | Decidir si pasar a `Public`, y qué decimos de Arc en la ficha | Dueño |

### Lo que solo puede hacer el dueño

Crear la cuenta y pagar (1), verificar el email y declarar trader / non-trader (2), subir y enviar el primer ZIP desde el dashboard (9), crear la service account y vincularla (11). La API de la tienda no sustituye ninguno: no crea items ([api](https://developer.chrome.com/docs/webstore/api)).

## 9. Qué cambia en FAC-173 (presentación y first-run)

- La tienda exige capturas reales, descripción, política de privacidad y soporte; son las mismas piezas que FAC-173 quiere coordinar con la landing. Conviene producirlas una sola vez.
- La divulgación destacada **dentro de la interfaz** (§4) hace de la página Connect parte del requisito de aprobación, no solo de la experiencia; los estados "permiso denegado" o "no soportado" ya son parte del first-run.
- El listing no puede describir funciones que no existen: nada de grupos en Arc, y no sugerir que "evaluar una pestaña" guarda un link (la propia página Connect distingue ambos).
- Las capturas se tomarían con el build empaquetado, sin fixtures ni perfiles de prueba (FAC-43 lo exige).
- Los primeros meses, quien tenga Enhanced protection verá "This extension is not trusted by Enhanced Safe Browsing" al instalar (§7). La guía de instalación debería anticiparlo.

## No verificado

| Tema | Qué falta |
| --- | --- |
| Monto actual de la tarifa | El monto (US$5.00) es de un post de 2020; la página actual de registro solo dice "tarifa única". Confirmarlo en el dashboard antes de pagar. |
| País del dueño | La lista de países soportados está en la página de registro; no comprobé el caso concreto del dueño. |
| Revisión de items unlisted/privados | No hay texto que diga que se saltan o aceleran la revisión. El documento dice que todos los envíos pasan por el mismo sistema. |
| Si `optional_host_permissions` amplios alargan la revisión como los host permissions amplios | La política de minimum permission sí aplica a los opcionales y pide que sean "minimally-scoped"; la guía de tiempos de revisión no dice si los opcionales pesan igual. Es la mayor incertidumbre de la revisión. |
| Pasar de Unlisted a Public | La guía de update solo documenta Private → Public/Unlisted y la vuelta atrás. No dice si Unlisted → Public exige otra revisión. |
| "Prior to installation" frente a "dentro de la UI" | La política pide divulgar y obtener consentimiento "prior to installation"; la FAQ exige que sea en la UI del producto y no en la ficha. No encontré cómo se aplica a datos que la extensión lee desde la instalación (URLs y títulos vía `tabs`). |
| Advertencias exactas de instalación para nuestro manifest, en particular por los content scripts en `localhost` y el origen de producción | No las medí; el método está en [permission-warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) (tarea 8). |
| Tiempo real de revisión de un primer envío y de updates | Solo existe el rango oficial "días a semanas"; no hay SLA. |
| Comportamiento de `publish` si ya hay una revisión en curso | La documentación consultada no lo detalla; solo describe `cancelSubmission`. |
| Si Dia expone `tabGroups` | El reporte citado en FAC-161 dice que Dia tampoco; no lo probé. Según un resultado de búsqueda de la ayuda de Arc, Dia instala extensiones de la Web Store; no pude abrir la página (403). |
| Arc soporta "100 % de las extensiones de Chrome" | Lo dice arc.net/faq, pero choca con el reporte de que Arc no expone `chrome.tabGroups` (FAC-161). Ninguna fuente de The Browser Company menciona `tabGroups`. |
| Aviso "Disable developer mode extensions" en cada arranque con extensiones sin empaquetar | Solo foros y artículos de terceros; no hay documento oficial de Google que lo confirme ni lo niegue. |
| Cuánto tarda un update en llegar a los usuarios ya instalados | Las páginas consultadas no lo especifican. |
| Detalles de la verificación de trader para un individuo (documentos exigidos) | La página dice que puede pedir "otros documentos de identificación"; la guía del dashboard (`cws-dashboard-trader`) no pude leerla. |

## Fuentes

Documentación oficial de Chrome (consultada 2026-11-25):

- [Register your developer account](https://developer.chrome.com/docs/webstore/register)
- [Set up your developer account](https://developer.chrome.com/docs/webstore/set-up-account)
- [Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)
- [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)
- [Review process](https://developer.chrome.com/docs/webstore/review-process)
- [Check review status](https://developer.chrome.com/docs/webstore/check-review)
- [Distribution tab](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)
- [Store listing tab](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
- [Privacy practices tab](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [Supplying images](https://developer.chrome.com/docs/webstore/images)
- [Update your item](https://developer.chrome.com/docs/webstore/update)
- [Rollback](https://developer.chrome.com/docs/webstore/rollback)
- [Chrome Web Store API](https://developer.chrome.com/docs/webstore/api) · [Use the API](https://developer.chrome.com/docs/webstore/using-api) · [Service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Single purpose FAQ](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines-faq)
- [Trader / non-trader](https://developer.chrome.com/docs/webstore/program-policies/trader-disclosure)
- [Permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings) · [Permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list) · [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Hello World (Load unpacked)](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
- [Chrome Help: install and manage extensions](https://support.google.com/chrome/answer/2664769)
- [Chromium Blog: new developer dashboard (2020-03)](https://blog.chromium.org/2020/03/new-developer-dashboard-and.html) (US$5.00)

Arc: [arc.net](https://arc.net/) (aviso de cierre y preguntas), [arc.net/faq](https://arc.net/faq). El [Arc Sunset FAQ](https://resources.arc.net/hc/en-us/articles/44413577819159-Arc-Sunset-Frequently-Asked-Questions) del Help Center solo lo vi en un resultado de búsqueda; no pude abrirlo.

Repo y tickets: `apps/extension/scripts/build.ts`, `apps/extension/src/pages/connect.html`, `src/browser/extensionVersion.ts`, `.github/workflows/extension-release.yml`, `gh release view extension-v0.2.0`, y los tickets FAC-172, FAC-43, FAC-173 y FAC-161 de Linear.

## Fact-check (Opus)

Revisión del 2026-11-25 contra las páginas citadas (versión inglesa de developer.chrome.com), arc.net, start.arc.net, la ayuda de Chrome y el repo en esta rama.

**Confirmado:**

- Cuenta: tarifa única, email que no se puede cambiar, lista de países, 2-step verification para publicar o actualizar, perfil (publisher name y email verificado obligatorios; dirección física solo con compras). El monto de US$5.00 está en el post de 2020; la página de registro actual no lo da.
- Trader / non-trader: autodeclaración, aviso al consumidor para non-traders y verificación de traders desde el 2024-02-17.
- Visibilidad Public / Unlisted / Private (trusted testers y Google Groups) y la versión BETA paralela con sus rótulos.
- Tiempos de revisión ("unos días, hasta unas semanas"), las señales (desarrollador nuevo, extensión nueva, permisos peligrosos, cambios grandes), los host permissions amplios, `tabs` como permiso de ejecución sensible, minificación permitida y ofuscación prohibida, imágenes revisadas "dentro de una semana".
- Advertencias de `tabs` ("Read your browsing history") y `tabGroups`; `scripting` y `storage` sin advertencia; la extensión se deshabilita si un update agrega un permiso con advertencia.
- Manifest del repo: permisos, `optional_host_permissions`, `host_permissions` vacío, `minify: false`, descripción de 76 caracteres, `chrome.runtime.id` en `index.ts:162,205`, release `extension-v0.2.0` con 58 692 bytes.
- Política de privacidad, Limited Use (incluido el texto de la declaración afirmativa), datos de usuario (navegación y contenido de sitios, también si solo es local), HTTPS, divulgación en la UI con acción afirmativa, coherencia entre dashboard, política y comportamiento.
- API: v2 no crea items; OAuth 2.0 con el scope `chromewebstore` o service account (agregada por email en Account, sin roles de Cloud; token por impersonación con `gcloud` o JWT con clave JSON); flujo `upload` → `fetchStatus` → `publish` → `fetchStatus`; `cancelSubmission`; visibilidad vigente; 2 GB; revisión por update; 30 días de publicación diferida; rollback sin revisión en menos de un minuto; rollout parcial desde 10 000 usuarios; Verified CRX uploads; cliente OAuth posiblemente no verificado.
- Arc deja de funcionar el **2026-12-22** y no admite cuentas nuevas desde el 2026-10-22 (arc.net, The Browser Company); Dia lo reemplaza e importa extensiones. Arc instala desde la Web Store con "Add Extension…" (start.arc.net).

**Corregido:**

1. **Rechazo:** el doc decía que un rechazo "no toca el listing publicado". La fuente dice que una violación en un envío puede disparar la revisión de la versión publicada. Lo que sí es cierto es que un update en revisión no afecta a los usuarios (página update).
2. **Unlisted → Public:** la guía solo documenta Private → Public/Unlisted. Agregué que volver a hacer pública una extensión despublicada exige una versión nueva con revisión, y moví a No verificado si Unlisted → Public pasa por revisión.
3. **`optional_host_permissions`:** el doc sugería que el usuario lo concede "por pestaña/sitio"; el código pide `http://*/*` y `https://*/*` de una vez (`CONTENT_ORIGINS`). También agregué que la política de minimum permission aplica a los permisos opcionales, lo que refuerza el riesgo.
4. **`scripting`:** la celda de advertencia estaba mal redactada ("con `tabs` se combina con host permissions"); la lista no le da advertencia.
5. **`storage`:** el doc solo citaba `storage.session`; también se usa `storage.local`.
6. **Promo tiles:** la fuente dice "evitar texto" y "no usar solo una captura", no "sin texto, sin capturas".
7. **Enhanced protection:** el doc daba a entender que la tienda trae la confianza de Google. Un desarrollador nuevo tarda en general unos meses en ser confiable, y mientras tanto los usuarios con Enhanced protection ven "This extension is not trusted by Enhanced Safe Browsing". Lo agregué en §7 y §9.
8. **Divulgación:** agregué que la política habla de "prior to installation" y que `tabs` lee URLs desde la instalación, antes de Connect. Lo dejé abierto en No verificado.
9. **Arc instala desde la Web Store:** pasó de No verificado a confirmado (fuente oficial de Arc). Agregué que arc.net/faq dice "100 % de las extensiones", lo que choca con la falta de `tabGroups`.

**No pude confirmar:** el monto actual de la tarifa en el dashboard, si Unlisted → Public o los optional host permissions amplios alargan la revisión, cómo se aplica "prior to installation", la página del Arc Sunset FAQ y la de extensiones de la ayuda de Arc (403), si Dia expone `tabGroups`, el aviso de developer mode y la guía de trader del dashboard (`cws-dashboard-trader` no se pudo extraer).

**¿Cambia la recomendación?** No. Los hechos siguen apoyando la Web Store como canal principal con GitHub de respaldo, Unlisted primero y la API para updates. Cambian dos matices: el permiso opcional de todos los sitios pesa más (la política de mínimos lo alcanza y hoy se pide de una vez), así que conviene preparar su justificación o evaluar pedir por sitio antes del primer envío; y el primer lanzamiento tendrá el aviso de Enhanced protection, que la guía de instalación debe anticipar.
