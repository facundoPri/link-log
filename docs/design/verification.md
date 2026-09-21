# Verificación — 21 septiembre 2026

## Referencia y decisiones

Referencia visual generada con la herramienta integrada Image Gen: `concept.png`. Brief: biblioteca personal minimalista, blanco + verde, sidebar de etiquetas, lista abierta con previews, búsqueda por título/dominio/tag, captura por comando y drag-and-drop. Prompt completo registrado en la conversación. Se continuó con la dirección propuesta tras dejar las preguntas opcionales; no hubo una aprobación explícita del usuario.

Implementación revisada en Codex IAB; screenshots nativos con `getScreenshot`, inspeccionados con `view_image` junto con la referencia. No se usó Playwright externo. El método fullPage del IAB produjo una captura con escala incorrecta; se reemplazó por captura del viewport.

Desktop comprobado a 1440×1000 y 1505×1045 (dimensiones nativas del concepto); mobile a 390×844, scrollWidth=390, sin overflow horizontal.

## Comparación visual

| Punto       | Referencia                                            | Implementación y resultado                                                                                          |
| ----------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Composición | Rail lateral, búsqueda arriba, lista abierta          | Mismo modelo. Rail de 232px según spec; rows de 104px; ajuste de padding para que el drop zone entre con seis links |
| Tipografía  | Sans, título dominante, metadata subordinada          | DM Sans, título 30px, links 16px y descripción 14px desktop. Se aumentó la escala tras primera captura              |
| Paleta      | Blanco, sidebar gris claro, verde                     | #fff / #f8faf9 / #245c46; mayor contraste en texto secundario                                                       |
| Controles   | Captura arriba, chips de dominio, tags a la izquierda | Botón y comando comparten modal; filtros reales derivados de D1                                                     |
| Miniaturas  | Imagen, favicon y fallback                            | Metadata real de React, Bun, MDN, Cloudflare y YouTube; fallback y reintento visibles para GitHub                   |
| Espaciado   | Separadores finos, sin tarjetas repetidas             | Se preservó la lista abierta y zona de drop discreta                                                                |
| Mobile      | Extensión del sistema visual                          | Sidebar se convierte en navegación y tags horizontales; botón de captura compacto con nombre accesible              |
| Captura     | Comando rápido, tags opcionales                       | Modal con foco en URL, Escape y foco restaurado; estados de guardado y errores                                      |

Desviaciones intencionales: datos y thumbnails reales en vez de muestras inventadas; dominios dinámicos; búsqueda usa `/` y captura `⌘/Ctrl K` para no duplicar el mismo atajo; indicación explícita de D1 local; copy de estado vacío, error y pie añadidos para completar flujos. El diff de copy superior conserva título, subtítulo, búsqueda y acción principal; los labels de dominios y tags cambian con los datos. No se reclama identidad píxel a píxel ni aprobación del usuario.

La implementación se verificó contra la dirección visual y se ajustaron tamaño de texto, contraste y espaciado. No quedaron problemas visuales materiales observados en esos viewports.

## Comportamiento comprobado

- Guardar desde formulario con etiqueta; cerrar modal y aparecer en biblioteca.
- Metadata real asíncrona: título, descripción, imagen y favicon.
- `⌘ K` abre captura y enfoca URL; Escape cierra.
- Pegar URL fuera de campos guarda directamente.
- Arrastrar un enlace real de la lista al drop zone activa el guardado; al existir, muestra aviso de duplicado y no crea otra fila.
- Buscar `react desarrollo` encuentra el link por título + etiqueta; texto inexistente muestra estado vacío filtrado.
- Filtro `youtube.com` reduce a un video.
- Editar tags y renombrar una etiqueta globalmente actualiza los links.
- Recarga conserva los registros en D1.
- `youtu.be/Tn6-PIqc4UM` resuelve a `www.youtube.com/watch?...`, recibe metadata y se agrupa en youtube.com.
- GitHub sin preview conserva el link, mostrando estado recuperable.
- Prueba API contra D1: dos POST concurrentes generan una fila, renombrar/desasignar tags, rechazar esquema no HTTP y origen ajeno; limpieza de sus propios registros.
- 4 tests unitarios, 24 assertions: normalización, aliases YouTube, texto pegado y rangos IP no públicos.
- Typecheck, build y `wrangler deploy --dry-run` exitosos, sin despliegue real.

Se retiraron los siete links creados durante QA y sus etiquetas. Las capturas conservan ejemplos para evaluar la apariencia; no son contenido inicial de la biblioteca.

## Límites

No se comprobó Cloudflare remoto ni autenticación. Metadata HTML sin navegador: sitios con protección o contenido solo dinámico pueden no producir preview. Dos URLs distintas que terminan en el mismo contenido aún pueden coexistir. No hay evaluación de relevancia por IA. La accesibilidad se revisó mediante foco, etiquetas, navegación y ancho; no es una auditoría completa de lector de pantalla.
