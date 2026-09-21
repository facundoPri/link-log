# Linklog

Biblioteca personal de links: capturar rápido, encontrar después. Creada con `bun init --react`, React **18.3.1**, Bun y Cloudflare Workers + D1.

## Usar localmente

```sh
bun install
bun run dev
```

Abrir http://localhost:3000. El comando compila los assets, aplica las migraciones **locales**, inicia Wrangler en 127.0.0.1:8787 y Bun con HMR en 127.0.0.1:3000. Los datos persisten en `.wrangler/state`; no se guardan en localStorage ni se envían a una base remota.

- Botón **Agregar link** o `⌘/Ctrl K`: URL + etiquetas opcionales.
- Pegar una URL o una lista fuera de un campo: guarda directamente.
- Arrastrar un enlace del navegador a la página: guarda directamente.
- `/`: enfoca búsqueda. Busca título, descripción, URL, dominio y etiquetas.
- Filtros de dominio y múltiples etiquetas (AND).
- Menú `…`: editar etiquetas o eliminar (segundo clic confirma).
- `+` junto a Etiquetas: crear, renombrar o eliminar una etiqueta globalmente.

## Metadata y URLs

Guarda inmediatamente en D1; el workflow de extracción enriquece título, descripción, Open Graph y favicon. Sigue hasta seis solicitudes HTTP con redirecciones manuales, timeout de 10s y lectura máxima de 1MiB. Valida protocolo, credenciales, puertos, host y direcciones DNS públicas por salto. La vista previa no ejecuta JavaScript remoto ni accede a páginas autenticadas; la extracción Markdown posterior usa un navegador de Cloudflare. Decodifica entidades HTML; renderiza todo como texto React.

Los aliases `youtu.be`, `www.youtube.com`, `m.youtube.com` y `music.youtube.com` se agrupan como `youtube.com`. Se eliminan parámetros de tracking conocidos; se conservan parámetros funcionales y fragmentos. Duplicados normalizados exactos o contra un destino ya resuelto devuelven el existente y suman etiquetas, incluso con guardados simultáneos. Dos acortadores diferentes que llegan al mismo destino después del guardado aún pueden coexistir; no se fusionan automáticamente.

Una página bloqueada, lenta o sin HTML conserva el link y permite reintentar. Si el Worker se reinicia durante una extracción, el estado pendiente caduca a los 30s para permitir recuperación. Imágenes remotas tienen fallback; su disponibilidad depende del sitio. No hay archivo de imágenes ni oEmbed. R2 guarda el Markdown y las transcripciones.

## Cloudflare: frontera actual

La API ya corre en el runtime de Workers y usa el binding D1 real emulado localmente. **No está desplegada ni conectada a una base remota.** Bun se usa para desarrollo/build; no es el runtime de producción de Workers.

`wrangler.jsonc` contiene un ID explícitamente local. La API rechaza hosts remotos mientras no haya autenticación. Para la siguiente etapa: decidir personal vs multiusuario, incorporar Cloudflare Access o sesiones verificadas, provisionar D1 remoto, reemplazar ese ID, aplicar migraciones remotas y desplegar los assets + Worker. No quitar la protección de hosts sin implementar el control de acceso. Para exposición remota también corresponde endurecer egress/DNS contra rebinding, limitar abuso y paginar la biblioteca.

Documentación consultada: [Bun React](https://bun.sh/guides/ecosystem/react), [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/), [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/).

## Verificar

```sh
bun run typecheck
bun test
# Con dev en ejecución: integración contra D1 local; limpia solo sus propios registros.
bun scripts/check-api.ts
# Build y ejecución sin HMR en el runtime de Workers:
bun run preview
```

Diseño y decisiones en `docs/design/decisions.md`. Concepto generado: `docs/design/concept.png`. Comparación y pruebas de interfaz: `docs/design/verification.md`. Las capturas muestran links de prueba reales, retirados de la biblioteca al finalizar.

## Contexto y clasificación

`bun run dev` aplica migraciones y abre la biblioteca en `http://localhost:3000`.
D1, R2, Queues y Workflows funcionan **localmente**. Browser Rendering y, si se
selecciona, Workers AI son bindings **remotos**: sus llamadas usan servicios reales.
No se desplegó la biblioteca ni se habilitó acceso público.

- Guardar un link o pegar una lista fuera de un campo crea un lote de extracción.
  Las listas grandes se dividen en lotes de 100, con deduplicación por URL normalizada.
- El workflow resuelve redirecciones y obtiene metadata; el registro de adaptadores
  en `worker/adapters/index.ts` elige YouTube o el adaptador web.
- Web usa Browser Rendering → Markdown. YouTube usa subtítulos públicos mediante
  `youtube-transcript-plus`; no transcribe audio ni accede a contenido privado.
  YouTube puede bloquear o cambiar su API interna. El panel permite reintentar o
  pegar/cargar `.txt`, `.md`, `.srt` y `.vtt` cuando no haya transcripción disponible.
- «Con contexto» y «Sin etiquetas» ayudan a reducir la selección antes de pagar
  una evaluación. Seleccioná links y usá **Autoetiquetar** o **Consultar**.
- Autoetiquetar agrupa un Noul por etiqueta en una llamada por link. Una respuesta
  completa y válida reemplaza todas sus etiquetas (también las manuales) y scores.
  Los fallos conservan el estado anterior. El umbral inicial es 80%, editable;
  es una configuración de partida, no una calibración garantizada.
- Cada score conserva descripción, umbral, versión de etiqueta y versión del
  contenido de esa ejecución. Cambiar una etiqueta no reevalúa links anteriores.
  Todos los scores se ven en el contexto; los descartados también aparecen en
  el selector de etiquetas. Las etiquetas muestran el porcentaje al pasar el mouse.
- Consultar ofrece Noul o Choice, con resultados por link, sin modificar etiquetas.
  Choice incorpora una opción «Otro». Los resultados y progreso se guardan por lote.

### Credenciales

Para Markdown, autenticá Wrangler con `browser:write`, además de sus permisos de
Worker y cuenta. `bunx wrangler login` abre el flujo de autorización. Esta cuenta
ya fue reconectada durante la implementación.

Para TypeSafe, completá **localmente** `.dev.vars` (ignorado por Git):

```dotenv
JEV_PROVIDER="typesafe"
TYPESAFE_API_KEY="tu-clave"
```

Guardá y reiniciá `bun run dev` si Wrangler no recarga las variables. Las claves no
se envían al navegador. Para Cloudflare, usá `JEV_PROVIDER="cloudflare"`; requiere
permiso `ai:write` y saldo para `typesafe/jev`. La prueba real de esta cuenta devolvió
HTTP 402 por saldo insuficiente. No se cambia de proveedor automáticamente.

### Costos, reintentos y límites actuales

«Uso y costos» registra cada intento de proveedor, tokens informados, modelo,
latencia, tiempo de navegador, link, lote y estado. Las tarifas USD se configuran
manualmente según el contrato del proveedor y se guardan con cada intento; sin
medición o tarifa el costo queda **desconocido**, nunca supuesto cero. Las estimaciones
no representan facturación final ni incluyen infraestructura de almacenamiento,
Workflows, Queue, mínimos, descuentos o concurrencia de Browser Rendering. El panel
muestra las últimas 1.000 operaciones. OCR/Instagram quedan para una etapa posterior.

D1 actúa como outbox, Queue entrega IDs y cada Workflow usa un ID estable para
no duplicar trabajos ante redelivery. Los pasos pagados no se reintentan
silenciosamente; el usuario puede crear un nuevo intento. Hay dos cupos de proveedor
compartidos mediante leases D1 de cinco minutos; los pasos tienen timeout de dos
minutos. El cron recupera trabajos pendientes; `scripts/dev.ts` simula este cron cada
30 segundos porque Wrangler no ejecuta cron automáticamente en local.

El contenido completo se guarda en R2 (máximo 2 MB; carga manual 500.000 caracteres).
La clasificación envía el contenido completo y deja que el tokenizador del proveedor
valide la ventana real, sin confundir bytes con tokens. TypeSafe documenta 32.000
tokens para `state` más la pregunta más larga y 64.000 para la solicitud completa.
Si el proveedor rechaza el tamaño, el trabajo falla con un mensaje claro y conserva
contenido, etiquetas y scores anteriores. No se trunca ni se agregan probabilidades
por fragmentos automáticamente; la estrategia para documentos que realmente superen
la ventana queda pendiente.
El procesamiento usa contexto completo por link, no embeddings ni un índice vectorial.

### Verificación

- `bun test`: URLs, respuestas Noul/Choice, probabilidades completas y transacciones
  SQLite: reemplazo de etiquetas manuales, scores rechazados, snapshots de umbral y
  rollback ante error. Los modelos usados en pruebas unitarias son fixtures explícitos.
- `bun run typecheck` y `bun run build`.
- `bun scripts/check-api.ts`: con el servidor levantado; usa registros propios,
  verifica deduplicación concurrente, D1 y guardas de origen/URL, y limpia sus links.
  Hace una extracción real de ejemplo (puede consumir Browser Rendering).
- Se verificaron realmente Markdown, resolución `youtu.be` y transcripción pública,
  visor móvil, editor de etiquetas, consultas Choice, panel de uso y pegado múltiple.
  Jev por TypeSafe se verificó con llamadas reales a `jev-1.13.0`: autotag,
  scores descartados, snapshot y cambio de umbral en una nueva ejecución, consultas
  Noul/Choice sin modificar etiquetas, y registro de tokens. Las credenciales se
  mantienen exclusivamente en `.dev.vars`.
