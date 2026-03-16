# OBSEARCH KNOWLEDGE BASE

**Commit:** 5870c48 | **Branch:** master

## OVERVIEW

Multimodal semantic search engine for Obsidian vaults — indexes `.md`, images, and PDFs into a single SQLite+sqlite-vec vector space using Gemini Embedding 2.

## STRUCTURE

```
obsearch/
├── apps/
│   ├── cli/        # Indexing entrypoint — `obsearch index <vault-path>`
│   ├── server/     # Hono + oRPC API, thumbnail serving
│   └── web/        # React 19 + Vite + TanStack Router search UI
├── packages/
│   ├── core/       # Embeddings, DB, crawler, indexing pipeline, retry
│   ├── api/        # oRPC router definitions + context
│   ├── env/        # Zod-validated env vars (./server, ./web subpaths)
│   ├── config/     # Shared tsconfig.base.json
│   └── ui/         # Shared React component library
├── AGENTS.md       # This file (loaded into context)
├── SPEC.md         # Task list and scope
└── biome.json      # Formatter + linter (tabs, double quotes)
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Embedding logic | `packages/core/src/embedding.ts` |
| DB schema + vector search | `packages/core/src/db.ts` |
| Indexing pipeline (images/md) | `packages/core/src/indexing.ts` |
| Retry + rate limiting | `packages/core/src/retry.ts` |
| Vault crawler | `packages/core/src/crawler.ts` |
| oRPC router + search endpoint | `packages/api/src/routers/index.ts` |
| Server routes + thumbnail serving | `apps/server/src/index.ts` |
| CLI command + cost estimate | `apps/cli/src/index.ts` |
| Search UI + Obsidian deep links | `apps/web/src/routes/index.tsx` |
| Result cards + image thumbnails | `apps/web/src/components/search-results.tsx` |
| Env var definitions | `packages/env/src/server.ts`, `packages/env/src/web.ts` |

## EMBEDDING MODEL

- Model: `gemini-embedding-2-preview` (default), env: `GEMINI_EMBEDDING_MODEL`
- **Task types are mandatory**: `RETRIEVAL_DOCUMENT` when indexing, `RETRIEVAL_QUERY` when searching. Omitting degrades quality measurably.
- **Dimension**: `GEMINI_EMBEDDING_DIMENSION = 3072`. Pass to `initDb` — wrong dimension breaks sqlite-vec schema silently.
- API key: `GEMINI_API_KEY`. Model is in preview — do not assume API stability.

## INDEXING PIPELINE

- Images: base64-encode → `inlineData` parts → embed → store (multimodal core feature)
- Markdown: text → embed with `RETRIEVAL_DOCUMENT` → store
- PDF: currently skipped with `reason: "unsupported_pdf"` (Phase 2)
- Incremental: skip files where mtime + size unchanged since last index
- Rate limiting: `retryWithBackoff` handles 429s and 5xx with exponential backoff

## SECURITY (THUMBNAIL SERVING)

- `/vault-file/*` requires loopback origin AND static token match
- Path traversal prevented via `relative()` + vault boundary check
- Symlinks rejected at indexing time (`assertImageInputHasNoSymlinks`, etc.)
- Token model is demo-level only — not production security

## ANTI-PATTERNS

- Don't skip task types on embedding calls — silent quality regression
- Don't use wrong embedding dimension — silent schema corruption in sqlite-vec
- Don't add ORM — raw SQL with prepared statements is intentional
- Don't use Node APIs when Bun APIs exist (`Bun.file`, `Bun.Glob`)

## COMMANDS

```bash
bun run dev              # Start all apps (turbo dev)
bun run build            # Build all workspaces
bun run check-types      # Type check all workspaces
bun run check            # Format + lint (biome)
bun run dev:web          # Web only
bun run dev:server       # Server only
```

## WORKSPACE IMPORTS

```typescript
import { initDb, crawlVault } from "@obsearch/core";
import { env } from "@obsearch/env/server";   // server-only
import { env } from "@obsearch/env/web";      // client-only
import { Button } from "@obsearch/ui/components/button";
```

## NOTES

- Supported file types: `.md`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.pdf` only
- `packages/core` is dependency-free from other workspace packages — all shared logic lives here
- See subdirectory `AGENTS.md` files for package-level details
