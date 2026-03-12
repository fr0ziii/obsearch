obsearch is a multimodal semantic search engine for Obsidian vaults — it uses Gemini Embedding 2 to embed text, images, and PDFs into the same vector space so users can search across all file types with a single natural language query.

## Architecture
- Monorepo: Bun workspaces + Turborepo. Run `bun run dev` from root to start all apps.
- Backend lives in `apps/server` (Hono + oRPC), frontend in `apps/web` (React + TanStack Router).
- CLI (`apps/cli`) is the indexing entrypoint — crawl vault, generate embeddings, persist to SQLite.
- Shared logic (embeddings, SQLite, crawler, indexing pipeline) belongs in `packages/core`.
- Database is local SQLite + sqlite-vec for vector search. No ORM. No cloud. Data never leaves the user's machine.

## Embedding model
- Model: `gemini-embedding-2-preview` (default), configurable via `GEMINI_EMBEDDING_MODEL` env var.
- API key via `GEMINI_API_KEY` env var.
- **Task types are mandatory**: use `RETRIEVAL_DOCUMENT` when indexing, `RETRIEVAL_QUERY` when searching. Not using task types degrades search quality measurably.
- **Embedding dimension**: `GEMINI_EMBEDDING_DIMENSION = 3072` (verified 2026-03-11 via live API). Configurable from 128–3072 via `outputDimensionality`. Pass this constant to `initDb` — wrong dimension breaks the sqlite-vec schema silently.
- The model is in preview — do not assume API stability.

## Indexing pipeline
- Images: read file → convert to base64 with correct mimeType → embed via `inlineData` parts → store. This is the core differentiating feature.
- Markdown: read text → embed with `RETRIEVAL_DOCUMENT` task type → store.
- Rate limiting + exponential backoff is required before any real vault usage. The pipeline must handle 429s gracefully.
- Incremental indexing by mtime: skip files whose mtime and size haven't changed since last index. This is part of the MVP, not Phase 2.

## Supported file types
`.md`, `.png`, `.jpg`, `.jpeg`, `.webp`, `.pdf`. Nothing else.

## Crawler contract
`packages/core`: recursive scan, return `files` with `{ path, type, size, mtime }` plus `errors`. `path` must be vault-relative and POSIX (`/`), skip hidden entries and symlinks, sort files by path.

## Web UI requirements
- Image results must show a real thumbnail, not a path string or placeholder icon — this is the visual proof that multimodal works.
- Every result must include an Obsidian deep link: `obsidian://open?vault=VAULT_NAME&file=RELATIVE_PATH`.

## General
- Use Bun APIs (`Bun.file`, `Bun.Glob`) over Node APIs wherever possible.
- Keep it simple: this is a demo/open-source project built in public. Avoid over-engineering.
- See SPEC.md for the full task list, scope, and repo structure.

## Progress Snapshot (2026-03-11)
- Completed through SPEC Task 12 (core indexing + CLI + API search endpoint + web search UI).
- `packages/core/src/indexing.ts` exposes:
  - `indexImage(...)`
  - `indexMarkdown(...)`
  - `indexVaultFile(...)` (`indexed` / `skipped` with explicit `reason`)
- Retry logic is in `packages/core/src/retry.ts` (`retryWithBackoff`, `RetryExhaustedError`, transient error classification).
- CLI lives in `apps/cli` with command `index <vault-path>`, per-file progress, summary counters, and cost estimate using `OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL`.
- API search route exists in `packages/api/src/routers/index.ts` and delegates to `core.search(...)` via context dependency wiring.
- Web results UI exists in `apps/web/src/routes/index.tsx` + `apps/web/src/components/search-results.tsx` with real image thumbnails and Obsidian deep links.
- Current incremental behavior for `pdf` is non-crashing skip (`reason: "unsupported_pdf"`) until Phase 2 PDF pipeline is implemented.
- Thumbnail serving route (`/vault-file/*`) now requires vault-boundary checks and token/loopback gating. Treat current static client token model as demo-level only, not production security.
