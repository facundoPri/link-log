# Browser: plan de la funcionalidad

Especificación de producto acordada para la vista Browser. La implementación y sus
decisiones están en [`browser-implementation-handoff.md`](browser-implementation-handoff.md);
la evidencia en [`browser-validation.md`](browser-validation.md).

## 1. Resultado esperado y límites

Browser muestra las pestañas y grupos de **la ventana de Chrome que contiene la página de Linklog**. Permite guardar links, cerrar pestañas, gestionar grupos y activar varios lenses con filtros combinables. Reutiliza resultados por pestaña y procesa únicamente los que faltan.

- La sincronización ocurre localmente entre extensión y página, mediante eventos y reconciliación con Chrome. No hay inventario remoto ni control desde otros dispositivos.
- Jev sigue siendo remoto y utiliza los procesos actuales del backend. Clasificar una pestaña nunca crea implícitamente un link guardado.
- No se agrega un Durable Object en esta versión: la extensión posee el estado local; los jobs actuales resuelven la ejecución recuperable. Tampoco se introduce otro scheduler o framework de monorepo.
- Chrome de escritorio es el primer conector. La vista permanece en Browser al activar lentes; no abre la vista de lentes de la biblioteca.
- Se conservan la lista compacta, selección, componentes y convenciones de la interfaz existente. Browser no necesita preview de página.
- Sin extensión se muestra conexión/instalación y reintento; en un navegador incompatible, compatibilidad. Una conexión perdida no equivale a una ventana vacía.
- La app actual es local y bloquea acceso remoto. Las definiciones pineadas se comparten entre navegadores conectados a **la misma biblioteca/backend**. Esta entrega no agrega cuentas, despliegue ni sincronización entre computadoras.
- Las fuentes de producto son esta especificación y la UI existente; no hace falta pedir nuevas referencias visuales.

## 2. Monorepo y comandos

Usar Bun workspaces con un único lockfile. Conservar la app/Worker existentes en la raíz como paquete anfitrión; los paquetes nuevos tienen manifiesto, dependencias y tsconfig propios. Esto evita trasladar `.wrangler`, migraciones, secretos y rutas de datos al implementar Browser.

```text
package.json                     # app actual + workspaces apps/*, packages/*
bun.lock
src/                             # React existente + Browser
worker/                          # backend, jobs y Jev existentes
migrations/
scripts/                         # comandos raíz y herramientas locales
apps/extension/
  package.json
  tsconfig.json
  manifest.json                  # MV3, o plantilla generada de forma determinista
  src/background/                # sync, caché, grupos, permisos, comandos
  src/bridge/                    # mensajes únicamente con Linklog autorizado
  src/extract/                   # lectura de documentos, sin privilegios de gestión
  scripts/                       # build/watch/package si corresponde
  tests/
  dist/                          # extensión unpacked, ignorada por Git
packages/browser-protocol/
  package.json
  tsconfig.json
  src/                           # mensajes versionados, DTOs, validación y claves
tests/browser/                   # pruebas de integración con extensión real
docs/browser-feature-plan.md
docs/browser-implementation-handoff.md
```

La extensión no importa React, módulos Worker, secretos ni archivos internos de `src/`. Mover únicamente los tipos puros que deban compartirse al paquete de contrato y reexportarlos donde sea necesario; evitar una biblioteca genérica de utilidades. Usar dependencias `workspace:*`. Delimitar cada tsconfig para no mezclar tipos de Chrome, Bun y Cloudflare.

| Comando raíz | Contrato |
| --- | --- |
| `bun run dev` | Mantiene la experiencia actual de web + API y migraciones locales |
| `bun run build` | Mantiene el build web existente |
| `bun run extension:build` | Genera extensión unpacked y manifiesto verificable |
| `bun run extension:dev` | Watch; explica cuándo recargar la extensión en Chrome |
| `bun run extension:package` | Produce zip sin secretos, perfiles ni fixtures de pruebas |
| `bun run extension:chrome` | Abre navegador compatible con perfil aislado y extensión cargada; imprime ruta, versión y URL |
| `bun run build:all` | Construye app y extensión |
| `bun run typecheck` | Comprueba app, protocolo y extensión sin recursión de scripts |
| `bun test` | Mantiene tests existentes y agrega pruebas unitarias apropiadas |
| `bun run test:browser` | Ejecuta integración de extensión en perfil y base de pruebas aislados |

Permitir configurar URL y puertos de desarrollo sin matar procesos existentes. Defaults actuales: UI 3000, API 8787. Si el worktree necesita puertos alternativos, propagarlos al proxy, launcher, allowlist del bridge, polling/recovery y pruebas. No reutilizar ni migrar la base personal desde un worktree. No hacer un cambio de linker/gestor de paquetes innecesario.

## 3. Identidad y sincronización de la ventana

La extensión es la única autoridad sobre pestañas abiertas. La página solicita un handshake; el background obtiene la pestaña emisora validada y resuelve su `windowId`. Nunca usar la ventana global enfocada para decidir el alcance de una página en background.

- `installationId`: UUID generado en almacenamiento local de la extensión, no en `storage.sync` ni derivado del extension ID público. Distingue perfiles, Chrome/Beta y equipos.
- `browserSessionId`: generación de la sesión de la extensión en `chrome.storage.session`. Sobrevive a suspensiones del service worker; cambia tras reinicio completo de Chrome o recarga/actualización de la extensión.
- `tabInstanceId`: identidad local de una apertura concreta, ligada al `tabId` nativo. Reabrir la misma URL crea una instancia nueva. No identificar por URL ni por posición.
- `documentRevision`: cambia ante navegación que cambia el documento/contexto relevante; evita aplicar a una página resultados de la página anterior.
- La ventana es el alcance de la vista, no parte de la identidad del resultado. Mover una pestaña entre ventanas conserva su caché si el contexto sigue vigente.
- El namespace de caché incluye la identidad de la biblioteca/backend; preparar una clave de propietario para una futura cuenta, sin inventar autenticación actual.

Suscribirse a creación/cierre/actualización/movimiento/adjunción/separación de tabs, cambios de grupos y cierre de ventanas. Usar un snapshot completo inicial y al reconectar, volver al foco, despertar o detectar saltos de revisión. Entregar revisiones monotónicas y cambios pequeños; agrupar ráfagas. Resolver la carrera snapshot/eventos mediante revisión y reconciliación, no una secuencia que pueda perder eventos durante el handshake.

Al mover la página de Linklog, cambiar su suscripción a la ventana de destino y limpiar selección/filtros que ya no sean válidos. Excluir las propias páginas de Linklog de la lista clasificable y de Close. Páginas restringidas siguen siendo identificables cuando Chrome lo permita, pero se marca su contenido no disponible. Primera versión: ventanas normales; incógnito fuera de alcance.

El cierre de Linklog no borra el inventario ni los resultados de otras pestañas. Si no hay vistas Browser conectadas, la extensión mantiene reconciliación/limpieza local ligera, sin iniciar evaluaciones de Jev nuevas. Al volver, las lentes restauradas activas completan los faltantes. No enviar cada evento de pestaña a D1.

## 4. Caché de lenses y estado de ejecución

Guardar los resultados compactos y referencias de jobs en `chrome.storage.session`, accesibles mediante el background. No guardarlos exclusivamente en React, localStorage de la web ni variables globales del service worker.

Clave lógica:

```text
libraryScope / browserSessionId / tabInstanceId / documentRevision /
lensDefinitionId / lensVersion / clearGeneration
```

El registro conserva estado, respuesta estructurada, modelo, fecha, referencia de captura y request/job IDs. Estados: `missing`, `submitting`, `queued`, `running`, `done`, `failed`, `unavailable`, `expired`. No representar missing/failed como respuesta No.

Reglas verificables:

1. Activar un lens lo aplica a todas las pestañas elegibles de la ventana actual, independientemente de selección, grupo filtrado o resultados visibles. Antes de llamar a Jev, consultar resultados y trabajos en curso.
2. Desactivar oculta su información y su filtro; conserva resultados. Reactivar un `done` vigente produce cero llamadas nuevas.
3. Sincronizar una vista Browser conectada con lenses activos evalúa automáticamente las pestañas nuevas/faltantes cuando estén listas. Esperar a que termine la carga relevante; no clasificar repetidamente cada cambio de título durante la navegación.
4. Cerrar/reabrir Linklog, suspender su renderer o perder/restaurar localhost conserva resultados `done`. Un backend inaccesible no provoca vaciado de caché.
5. Cerrar una pestaña elimina su asociación. Una respuesta tardía no puede recrearla. Chrome puede reemplazar IDs de tabs: tratar los eventos de reemplazo explícitamente.
6. Editar pregunta/opciones/criterios produce una nueva versión del lens. Un cambio de umbral puramente visual puede reutilizar las probabilidades si no cambia la pregunta; mantenerlo consistente con el contrato existente.
7. Navegar a otra página invalida el contexto anterior. Definir y probar navegaciones SPA; evitar invalidar por cada mutación del DOM. Una actualización del mismo PR sin navegación no ejecuta Jev continuamente: ofrecer reevaluación explícita y fecha de captura.
8. Clean elimina resultados del alcance indicado, incrementa la generación y desactiva los lenses limpiados para evitar recalcularlos inmediatamente. Conserva definiciones y grupos; invalida respuestas tardías.
9. Un error se muestra con retry explícito. Backend desconectado o respuesta perdida no autoriza crear otro job: reconciliar primero usando la misma clave.
10. Dos páginas de Linklog abiertas simultáneamente pueden compartir resultados; coordinar solicitudes en la extensión y deduplicar también en el backend. `storage.session` no es una base transaccional: no asumir que leer seguido de escribir excluye otra llamada.

Límite aprobado de persistencia: `storage.session` se pierde al reiniciar Chrome o recargar/desactivar/actualizar la extensión. No se promete recuperar resultados después de eso. Documentarlo en desarrollo: recargar la extensión durante watch no equivale a recargar Linklog. Respetar la cuota de 10 MB: medir escrituras, guardar respuestas compactas, limitar/evictar capturas separadamente y mostrar errores de cuota. No desalojar silenciosamente resultados para luego cobrarlos de nuevo.

## 5. Lectura local de contenido

El inventario usa APIs de tabs/tabGroups. Cuando un trabajo lo necesita, ejecutar un extractor empaquetado sobre el documento autorizado: título, URL efectiva, descripción/metadata, encabezados, texto principal y enlaces útiles. Mantener evidencia específica de páginas de aplicación, por ejemplo estado del PR y comentarios; un extractor de artículos que borra esos elementos no basta.

- Captura y resultado son cachés distintas. Una captura puede servir para varios lenses. Capturar una vez por documento/revisión para un lote; no guardar texto completo de todo el navegador al instalar.
- Incluir fuente, URL, fecha, revisión, completitud y motivos de parcialidad. No presentar un recorte como contenido íntegro. Reusar límites del backend con errores claros.
- Mantener los extractores dentro de la extensión; no enviar cookies, tokens, inputs/passwords, scripts o almacenamiento del sitio. Tratar el texto de las páginas como datos no confiables.
- Acceder solo a lo cargado y permitido. Contenido virtualizado, iframes sin permiso, PDFs, páginas Chrome, pestañas descartadas o congeladas requieren estados explícitos; no activar, recargar o recorrer páginas automáticamente para simular completitud.
- Sin fallback silencioso a Browser Rendering, OCR o transcripción remota. El usuario quiere aprovechar el DOM cargado. Guardar una captura parcial debe conservar su procedencia y limitaciones.
- Declarar `tabs`, `tabGroups`, `storage`, `scripting` y acceso a hosts acorde a la funcionalidad. Pedir permiso de contenido mediante una acción inicial de conexión/ejecución, con alcance claro; `activeTab` solo no cubre todas las pestañas. La lectura posterior automática usa permisos ya otorgados. Evitar permisos de history/cookies/debugger/nativeMessaging.
- Si metadata basta para una pregunta, soportarlo como fuente explícita; si falta evidencia, distinguir no disponible/insuficiente de un resultado negativo apto para cerrar pestañas.

## 6. Bridge local y seguridad

Preferencia: content script de enlace únicamente en los orígenes de Linklog configurados, comunicándose con el background. Handshake con versión de protocolo, capacidades y request IDs. Validar tanto mensajes como respuestas en los límites.

Allowlist de desarrollo: orígenes exactos configurados para `127.0.0.1`/`localhost` y puertos de esta app. Los patrones del manifest no sustituyen verificar origen, pestaña emisora y frame principal en runtime. Si se usa `externally_connectable`, mantener el mismo límite explícito. No confiar en `windowId`, tab IDs o URLs aportados por la web sin revalidarlos con Chrome.

Separar comandos privilegiados del bridge de las respuestas del extractor: un content script de un sitio arbitrario no puede ordenar cerrar/agrupar tabs o leer otros orígenes. Proteger acceso a `storage.session` y no exponer credenciales al frontend/extensión. Revalidar pertenencia a la ventana, identidad y existencia antes de aplicar comandos; devolver resultados por elemento cuando Chrome rechace alguno.

Las peticiones de inicio/consulta de jobs salen de la página al backend con su límite same-origin actual. No abrir CORS global ni quitar los checks de `worker/index.ts` o del proxy `src/index.ts`. Guardar el identificador de solicitud en la extensión antes del POST. El backend termina el job aunque la página cierre; al reconectar la página recupera su estado y deposita el resultado en la caché. La extensión no necesita un token de proveedor ni conexión persistente al backend.

## 7. Backend: evaluar sin guardar links

Reutilizar `worker/ai/jev.ts`, validación, colas/Workflows, pool de concurrencia Jev, consumo y Activity. El acoplamiento actual está en `jobs.link_id NOT NULL`, índices/leases, `JobContext.link`, lectura de R2, persistencia y joins de UI/Activity. No insertar links ficticios para satisfacerlo.

Introducir un target discriminado de trabajo: saved link o browser capture. El primero conserva semántica y relaciones actuales. El segundo referencia identidad opaca del contexto, snapshot inmutable de contenido y versión del lens; nunca depende de una fila en `links`.

La implementación elegirá la migración SQL mínima compatible con las FKs existentes. Probar migración desde datos reales de las tablas actuales, rollback/atomicidad donde corresponda, índices de trabajos activos y recuperación. `usage_events.link_id` admite null en SQL, pero los tipos/helpers y las consultas también deben admitirlo. No duplicar el motor de ejecución en un runner nuevo de browser.

Contrato a cubrir con endpoints/DTOs tipados:

- Iniciar lote de evaluaciones con `requestId` estable, scope de biblioteca/sesión, targets, captura y lens versionado. Partir lotes grandes usando límites existentes. Validar tamaño real, opciones, esquema y protocolos; no hacer fetch de URLs recibidas por esta ruta.
- Consultar por request ID tras respuesta perdida, y por job/batch ID tras aceptación. Retornar estado y resultados por target. La misma clave y payload devuelve el mismo trabajo; misma clave con payload distinto es conflicto.
- Registrar idempotencia de forma atómica antes de despachar. Conservar outbox/recovery y workflow ID por job. Una doble entrega de la cola no duplica la evaluación.
- Jev con timeout ambiguo no ofrece garantía universal de exactamente una llamada pagada: mostrar estado incierto/fallido, no reintentar ciegamente. Verificar si el proveedor soporta idempotencia antes de afirmar garantías mayores.
- Clean/cierre/navegación invalidan la aceptación local de resultados por generación. Cancelar trabajo aún no iniciado cuando sea posible; una llamada ya enviada puede consumir igualmente y debe registrarse.
- Para jobs que producen solo evidencia inequívoca de una página (p. ej. badge Merged), permitir extracción determinista antes del juicio; no sustituir preguntas arbitrarias de Jev por reglas inventadas.

Retención propuesta, configurable y visible en documentación: borrar snapshots temporales cuando dejan de ser necesarios; conservar resultados todavía no confirmados por la extensión durante 7 días. Al confirmar cacheado, permitir purga del payload y mantener recibo mínimo de idempotencia/consumo según la sesión. Cleanup idempotente por tareas de recuperación/cron, incluyendo D1, R2 y datos de Workflow bajo las capacidades reales del runtime. No prometer borrado físico inmediato de backups/logs del proveedor. Un job expirado se informa y requiere reevaluación explícita; no repetirlo automáticamente. Los resultados ya cacheados localmente no expiran por ese TTL mientras viva la pestaña/sesión.

## 8. UX de lenses y filtros

Reutilizar el editor y los cuatro tipos: Yes/No, Pick one, Pick many y Score. Browser muestra su catálogo de definiciones; permitir crear una definición de browser y reutilizar explícitamente la pregunta de una definición de biblioteca manteniendo resultados independientes. Implementar un scope claro para que una nueva definición de browser no aparezca accidentalmente como vista estática de All links.

Activar varios lenses añade resultados compactos por fila y controles de filtro visibles para todos los activos. No navegar fuera de Browser. AND entre condiciones de lenses; OR entre opciones elegidas dentro de un mismo lens. Rango/umbral para score, con orden explícito. Permitir respuestas inversas (No/closed); missing/error/insuficiente no se incluye automáticamente en el complemento.

Mostrar avance incremental, pendientes y fallos sin bloquear resultados existentes. Selección siempre por identidad de pestaña, no índice de fila. El alcance de evaluar un lens activo es toda la ventana; el alcance de Save/Close/Move/Autogroup es la selección explícita. La lista de grupos seleccionados es una unión (una tab de Chrome pertenece a un solo grupo).

## 9. Grupos locales y pineados

Al abrir Browser consultar los grupos de la ventana actual. Gestionar nombre, color, descripción de Linklog, movimiento/ungroup y pin. La API de Chrome no tiene descripción; guardarla como metadata propia.

- Grupo local: instancia nativa en una ventana, con descripción en almacenamiento de la extensión. Un grupo sin pin no se vuelve global. Cerrar el grupo descarta la asociación local.
- Grupo pineado: definición persistente en la biblioteca (`id`, nombre, descripción, color, versión), independiente de tags y de la instancia nativa. Puede existir sin pestañas.
- Pin conserva la definición y crea un binding local explícito entre native group y definición. En otras ventanas/perfiles conectados a la misma biblioteca aparece como destino, sin crear un grupo Chrome vacío automáticamente.
- Al asignar pestañas a un destino pineado sin instancia, crear un grupo nativo en la ventana actual y vincularlo. Reutilizar el binding si existe. No fusionar grupos por coincidencia de nombre.
- Editar descripción del grupo pineado actualiza la definición compartida. Nombre/color compartidos son valores para destinos futuros; no mover ni renombrar grupos de otras ventanas automáticamente. Mostrar cambios locales con coherencia y evitar bucles de sync.
- Unpin elimina la definición compartida para futuras opciones, con indicación de su alcance, y conserva grupos reales y su metadata local. Eliminar/cerrar un grupo Chrome tampoco elimina por sí solo una definición pineada.

Autogroup usa las descripciones de grupos locales y destinos pineados para un juicio Pick one, con opción de no asignar. Capturar versión del catálogo para detectar sugerencias antiguas. Jev devuelve IDs validados, nunca instrucciones de ejecución.

Regla acordada: Autogroup conserva las pestañas que ya tienen grupo y procesa las seleccionadas sin grupo. Mostrar asignaciones propuestas, permitir corrección y aplicar en lote; revalidar el grupo actual inmediatamente antes del movimiento porque pudo cambiar mientras corría Jev. Move to group es explícito y sí permite cambiar pestañas ya agrupadas. Ungroup mantiene las pestañas abiertas.

Filtros desde sidebar: un grupo, varios grupos y sin grupo. Evitar otro filtro redundante. Los tags de links ya guardados se muestran como información distinta de los grupos.

## 10. Save, Close y conflictos

Save normaliza/deduplica mediante la lógica de biblioteca existente. Para capturas válidas crear link con metadata/contenido/procedencia obtenidos localmente, sin iniciar extracción remota adicional. Los endpoints actuales de guardado encolan extracción automáticamente: crear una ruta/variante explícita para browser capture. Reutilizar el link existente sin sobrescribir contenido ni tags silenciosamente. No copiar grupos a tags ni resultados browser a resultados guardados automáticamente.

Conservar restricciones existentes de qué URLs pueden guardarse; Browser puede listar/gestionar una página local o restringida aunque Save no esté permitido. No debilitar la validación SSRF de los extractores remotos. Para capturas parciales conservar los límites y permitir una extracción posterior explícita.

Close significa cerrar únicamente las pestañas seleccionadas, sin guardar ni borrar links de All links. Revalidar ventana, URL/identidad y selección antes de actuar, indicar cuántas se cerraron/fallaron y retirar filas según el estado observado. No cerrar por el mero resultado de Jev. No implementar ni prometer restauración perfecta de formularios/historial con un Undo artificial.

## 11. Secuencia de implementación y salidas comprobables

1. **Baseline y worktree.** Copiar estos docs locales al worktree, inspeccionar instrucciones, registrar checks iniciales y usar base de datos/perfil de prueba aislados. Salida: comandos actuales funcionan o hay fallos previos identificados.
2. **Workspaces y extensión mínima.** Build, protocolo, handshake y listado de ventana actual con dos ventanas. Salida: extensión real cargada, ventanas separadas, manejo sin extensión y reconexión. No avanzar a Jev hasta comprobar esta frontera.
3. **Caché y extractor.** Estados, clave/revisiones, lectura local, permisos y errores. Salida: cache sobrevive al cierre de Linklog y suspensión del worker; extracción útil de página de aplicación y artículo sin backend de rendering.
4. **Jobs de browser.** Migración, captura temporal, dedup/recovery y resultado de un lens real. Salida: evaluar no agrega links; request perdido/duplicado conserva el mismo job; consumo visible.
5. **Lenses simultáneos.** UI, filtros, auto completar faltantes en sync, Clean y errores. Salida: escenario 20+3 conserva 20 resultados y evalúa solo 3; toggle repetido no añade llamadas.
6. **Save/Close y grupos.** Pin, bindings, catálogo, autogroup, movimiento manual y guardado sin extracción redundante. Salida: dos ventanas y dos perfiles comparten solo las definiciones pineadas, y autogroup respeta tabs ya agrupadas.
7. **Validación y entrega.** Checks completos, evidencia de navegador real y documentación de comandos/limitaciones. Salida: matriz abajo completada con evidencia; no sustituir pruebas reales de permisos y lifecycle por mocks.

## 12. Pruebas y evidencia requerida

Automatizar invariantes con fixtures deterministas y proveedor de test sin llamadas pagadas; conservar fuera del artefacto distribuido todo bypass/mock. Hacer una prueba pequeña con Jev real si hay credenciales/crédito; informar explícitamente si no pudo realizarse. Usar Playwright para scripts de prueba de extensión cuando sea la herramienta apropiada y respetar las instrucciones de herramientas de navegador de la sesión para uso interactivo.

Matriz mínima:

- Dos ventanas, otra instalación/perfil, dos páginas Linklog simultáneas, movimiento de una tab y movimiento de la propia página Linklog; ninguna fuga de alcance.
- Abrir/cerrar/navegar/agrupar/reordenar fuera de Linklog se refleja; reconexión con snapshot corrige eventos omitidos.
- 20 tabs + lens A/B: toggle conserva resultados, nueva tab con A activo añade solo el faltante, B apagado espera activación, filtros no reducen el alcance de evaluación.
- Cerrar/reabrir Linklog, suspensión real del service worker sin recargar extensión, caída/reinicio del API con misma base y pérdida de respuesta tras aceptar POST: recuperar sin jobs duplicados.
- Cerrar/reabrir misma URL genera instancia distinta; navegación, edición lens, Clean y respuestas tardías no resucitan resultados antiguos.
- Dos activaciones concurrentes, redelivery de cola, fallo Jev, timeout incierto, expiración de job y cuota de caché se distinguen de resultados negativos.
- Permiso denegado, página interna, contenido parcial y tab descargada/congelada siguen gestionables con estado veraz; no se activan a escondidas.
- Bridge rechaza origen/frame/mensaje indebido y IDs de otra ventana; extractores no pueden invocar comandos privilegiados.
- Save duplicado crea un solo link y no modifica tags/contenido existente; la captura nueva no dispara Browser Rendering; la clasificación sin Save mantiene el número de links.
- Pin disponible en segunda ventana/perfil de misma biblioteca sin compartir tabs; grupo se materializa al usarlo; nombres duplicados no se fusionan; unpin conserva grupos nativos.
- Autogroup conserva grupo existente incluso si cambió durante la evaluación; Move manual sí cambia grupo y Ungroup conserva tabs.
- Migraciones conservan biblioteca, jobs/usage/leases anteriores; tests existentes, typecheck y ambos builds pasan.

El launcher usa perfil exclusivo ignorado por Git. Chrome estable retiró la carga por flags necesaria para sideload automático: preferir Chromium de Playwright o Chrome for Testing. Documentar carga manual unpacked en Chrome estable. No lanzar con el perfil personal ni manipular las pestañas del usuario para pruebas de cierre.

Capturar versión del navegador, manifest/extension ID, comandos ejecutados, screenshots de lista/filtros/grupos y contadores de jobs/proveedor que demuestren reutilización. Los contadores mock prueban la deduplicación del flujo; distinguirlos del smoke con Jev real. Guardar el informe en `docs/browser-validation.md` y enlazarlo en la entrega.

## 13. Referencias de integración inspeccionadas

- `src/components/Sidebar.tsx`: Browser deshabilitado; navegación tags/lenses.
- `src/App.tsx`, `LinkList.tsx`, `LinkRow.tsx`, `SelectionBar.tsx`, `LensDialog.tsx`, `LensHeader.tsx`, `LensVerdict.tsx`: UI reutilizable, actualmente un lens activo.
- `src/types.ts`, `worker/ai/jev.ts`: definiciones y respuestas existentes. `truncateState` puede recortar: representar parcialidad explícitamente en el flujo nuevo.
- `worker/jobs.ts`, `worker/handlers/{index,classify}.ts`, `worker/usage.ts`: ejecución, `link_id`, pool, recovery y consumo.
- `worker/index.ts`: límites same-origin/local, import/save que disparan extracción, lentes y Activity.
- `migrations/0003_context_and_evaluations.sql`, `0004_provider_leases.sql`, `0005_lease_pools.sql`, `0006_lenses.sql`, `0007_lens_types.sql`: relaciones que revisar al admitir browser targets.
- `scripts/{build,dev}.ts`, `src/index.ts`, `wrangler.jsonc`, `tsconfig.json`: builds, proxy, puertos y almacenamiento local.

## 14. Fuentes oficiales verificadas

Consultadas 2026-09-23; verificar de nuevo las firmas al implementar.

- [Bun workspaces](https://bun.sh/docs/pm/workspaces): paquetes separados y dependencias workspace.
- [Chrome tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs): identidad, ventanas, eventos y estados.
- [Chrome tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups): instancias de grupo y metadata nativa.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage): ciclo de vida y cuota de session storage.
- [Service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): suspensiones y recuperación.
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) y [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting): extracción y permisos.
- [Seguridad de extensiones](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure): validación del bridge y alcance de privilegios.
- [Playwright: extensiones](https://playwright.dev/docs/chrome-extensions): contexto persistente aislado y sideload.
- [Cloudflare Queues: delivery](https://developers.cloudflare.com/queues/reference/delivery-guarantees/): deduplicación necesaria ante redelivery.
- [Durable Objects lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/): no son necesarios para la caché local elegida.
