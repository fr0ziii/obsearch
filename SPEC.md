# obsearch — Obsidian Multimodal Vault Search

## Idea
Un CLI para indexar el vault + una web UI para buscar, en el mismo monorepo. Permite buscar en texto, imágenes y PDFs desde una sola query. El motor de embeddings es Gemini Embedding 2, que mete todos los tipos de archivo en el mismo espacio vectorial — lo que hace posible buscar con texto y recibir resultados de cualquier modalidad ordenados por similitud semántica.

Ejemplo: escribes "arquitectura de microservicios" y aparecen notas `.md` sobre el tema, diagramas guardados como imagen y PDFs relevantes — todo junto, rankeado.

## Contexto y referencia
- Anuncio: https://x.com/OfficialLoganK/status/2031411916489298156
- Autor: Logan Kilpatrick (Google DeepMind)
- Fecha: 2026-03-10
- Modelo: Gemini Embedding 2 — SOTA multimodal embeddings (texto, imagen, vídeo, audio, docs en el mismo espacio vectorial)

## Scope

**Fase 1 — MVP**
- Indexar archivos `.md` e imágenes del vault
- Embeddings con Gemini Embedding 2 API
- Almacenamiento local en SQLite
- Búsqueda por texto desde CLI con resultados rankeados

**Fase 2 — Demo completa**
- Soporte para PDFs
- Reindexado incremental (solo archivos nuevos/modificados)
- Web UI para buscar con resultados visuales (preview de fragmento, thumbnail de imagen, link al archivo)

## Estructura del repo
```
obsearch/
├── apps/
│   ├── cli/        # indexar el vault
│   └── web/        # UI para buscar
└── packages/
    ├── core/       # lógica de embeddings + SQLite compartida
    └── ...         # packages generados por better-t-stack (api, config, env, ui)
```

## Stack
- Runtime: Bun
- Lenguaje: TypeScript
- Embeddings: Gemini Embedding 2 (Google AI SDK)
- Base de datos: SQLite + sqlite-vec (vector search)
- Backend: Hono + oRPC
- Frontend: React + TanStack Router
- Monorepo: Turborepo + Bun workspaces
- Linting: Biome
- Interface: CLI (indexar) + Web UI (buscar)
- Target: macOS, vault local de Obsidian

## Tareas

**Prerequisito**
0. [x] Verificar dimensión real de `gemini-embedding-2-preview` y soporte de `taskType` → *`GEMINI_EMBEDDING_DIMENSION = 3072` documentado en `packages/core/src/constants.ts`; taskType soportado; imagen embedding confirmado (3072 dims)*

**Completado**
1. [x] Inicializar monorepo con Bun workspaces y Turborepo → *repo con estructura `apps/` y `packages/` funcional*
2. [x] Crear `packages/core` con cliente Gemini Embedding 2 y schema SQLite + sqlite-vec → *cliente de embeddings y base de datos inicializada con tabla de vectores*
3. [x] Implementar crawler de archivos `.md` e imágenes en el vault → *lista de paths con tipo y metadatos (mtime, tamaño)*
4. [x] Implementar búsqueda vectorial en `core` → *función `search(query)` que devuelve los N archivos más similares con score*

**Fase 1 — MVP**
5. [x] Añadir `taskType` al embedding client → *API explícita `embedDocument(...)`/`embedQuery(...)`; `RETRIEVAL_DOCUMENT` en documentos y `RETRIEVAL_QUERY` en búsqueda*
6. [x] Pipeline de imagen: archivo → base64 → embed → store → *`indexImage(...)` en `packages/core/src/indexing.ts` (mimeType correcto, base64, embedding + persistencia)*
7. [x] Pipeline de texto: `.md` → embed → store → *`indexMarkdown(...)` en `packages/core/src/indexing.ts` con `RETRIEVAL_DOCUMENT`*
8. [x] Rate limiting + exponential backoff en llamadas a la API → *`retryWithBackoff(...)` + clasificación de errores transitorios (`429`/`5xx`/red) integrados en pipelines de indexado*
9. [x] Indexado incremental por mtime → *`indexVaultFile(...)` aplica skip cuando `mtime` y `size` no cambian; resultado explícito `indexed|skipped` con `reason`*
10. [x] CLI `index <vault-path>` en `apps/cli` → *progreso por archivo, resumen final (indexados / skipped / errores), estimación heurística de coste por sesión (`OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL`)*
11. [x] Endpoint oRPC `search(query, limit)` en `packages/api` → *ruta tipada implementada, validación de input y delegación a `core.search(...)`*
12. [x] Web UI con thumbnails y Obsidian deep links → *search UI implementada, thumbnails reales vía `/vault-file/*`, deep links `obsidian://open?...` por resultado*
13. [ ] README con demo GIF multimodal → *muestra el momento clave: query de texto → resultados mixtos .md + imagen rankeados juntos*

**Fase 2 — Demo completa**
14. [ ] Chunking semántico para `.md` largos → *schema extendido con `chunk_index` y `offset`; resultados muestran el chunk relevante, no el archivo entero*
15. [ ] Soporte PDF → *extracción de texto + pipeline de chunking idéntico al de `.md`*
16. [ ] Highlight de snippet en resultados → *web UI muestra el fragmento del chunk que matcheó*

**Producción**
17. [ ] Grabar demo y publicar en GitHub → *repo público + vídeo/post con el proyecto funcionando sobre un vault real*

## Notas de producción
- Proyecto open-source en GitHub
- Demo grabada sobre vault real
- Contenido: post LinkedIn + hilo X + posible vídeo YouTube
