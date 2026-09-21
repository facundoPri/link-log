# Linklog — primera versión

Biblioteca personal; capturar primero, organizar después. Referencia: concept.png.

## Sistema visual

Blanco #fff, rail #f8faf9, tinta #17212b, verde #245c46, borde #e7ece9.
Tipografía system sans, títulos 30/36 semibold; controles 14/20; metadatos 12/18.
Sidebar 232px, contenido máximo 1120px, lista abierta con separadores y thumbnails 112×76.
Radios 8px controles y previews, 6px etiquetas. Iconos Lucide 18px, stroke 1.7.
Hover suave 150ms; reducir movimiento según preferencia. Mobile: rail convertido en barra de filtros.

## Flujo

Cmd/Ctrl+K abre captura. Pegar una URL fuera de campos o arrastrarla guarda directamente.
Botón Agregar link abre el mismo diálogo: URL y etiquetas opcionales.
Guardado primero en D1, enriquecimiento después. Estados pendiente/listo/sin metadata; reintentar.
Búsqueda por título, descripción, URL, dominio y tags. Filtros de etiquetas combinados con AND.
YouTube agrupa www/m/youtu.be. Conservar URL original y resuelta; redirecciones HTTP limitadas.
Duplicados exactos normalizados devuelven el existente. Dos acortadores distintos que resuelven al mismo destino pueden coexistir; no se fusionan automáticamente.
Tags: crear al capturar/editar, renombrar globalmente, quitar de un link y borrar globalmente.

## Límites intencionales

Sin IA de relevancia, scraping autenticado, transcripción ni archivo completo de páginas.
Sin datos ficticios en biblioteca real. Estado vacío diseñado; muestras solo mediante acción explícita.
Miniaturas/favicon dependen del sitio, con fallback claro. URLs de imagen remotas, sin R2 por ahora.
Desarrollo con D1 local persistente. No despliegue remoto ni multiusuario en esta etapa.
