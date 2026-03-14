# obsearch — Obsidian Multimodal Vault Search

Monorepo for indexing an Obsidian vault and searching across text, images, and PDFs using Gemini embeddings + local SQLite vector search.

## Current Status (2026-03-11)

### Fase 1 — MVP
1. [x] Monorepo (Bun workspaces + Turborepo)
2. [x] `@obsearch/core` Gemini embedding + SQLite/sqlite-vec schema
3. [x] Vault crawler (`.md`, images, `.pdf`)
4. [x] TaskType embedding API (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`)
5. [x] Image indexing pipeline (`indexImage`)
6. [x] Markdown indexing pipeline (`indexMarkdown`)
7. [x] Retry + exponential backoff (`retryWithBackoff`)
8. [x] Incremental indexing by `mtime` + `size` (`indexVaultFile`)
9. [x] CLI `index <vault-path>` (`apps/cli`)
10. [x] oRPC `search(query, limit)` endpoint
11. [x] Web UI with thumbnails + Obsidian deep links

### Fase 2
- [ ] Semantic chunking for long markdown
- [ ] PDF text extraction + chunking pipeline
- [ ] Snippet highlight in search results

## Implemented Core APIs (`@obsearch/core`)

- `crawlVault({ vaultPath })`
- `createEmbeddingClient({ expectedDimension: 3072 })`
- `initDb({ dbPath, embeddingDimension })`
- `indexImage(...)`
- `indexMarkdown(...)`
- `indexVaultFile(...)` (incremental: `indexed` / `skipped` with reason)
- `retryWithBackoff(...)`
- `search(query, limit)` on `CoreDb`

## CLI (`apps/cli`)

### Run index command

```bash
bun run apps/cli/src/index.ts index /absolute/path/to/vault
```

or from the CLI package:

```bash
bun run --cwd apps/cli index -- /absolute/path/to/vault
```

### CLI behavior

- Crawls supported files from vault
- Initializes DB at `<vault>/.obsearch/index.db`
- Indexes per file with progress output `[i/total]`
- Uses incremental skip logic (`mtime` + `size`)
- Prints summary: `indexed`, `skipped`, `errors`, duration
- Prints heuristic API cost estimate

Cost estimate formula:

`embedding_call_count * OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL`

If `OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL` is unset, default is `0`.

## API + Web Status

- API route implemented: `search({ query, limit? })` in `@obsearch/api`.
- Server now wires a real `coreDb.search(...)` dependency into API context.
- Web home route includes:
  - Search form (`query`, optional `limit`)
  - Result cards with type + score
  - Real image thumbnails via server route `/vault-file/<relative-path>`
  - Obsidian deep links per result

## Environment Variables

```bash
CORS_ORIGIN=http://localhost:3001
GEMINI_API_KEY=your_key_here
GEMINI_EMBEDDING_MODEL=gemini-embedding-2-preview
OBSEARCH_DB_PATH=/absolute/path/to/vault/.obsearch/index.db
OBSEARCH_VAULT_PATH=/absolute/path/to/vault
OBSEARCH_THUMBNAIL_TOKEN=change_me
VITE_OBSIDIAN_VAULT_NAME=YourVaultName
VITE_OBSEARCH_THUMBNAIL_TOKEN=change_me
OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL=0.00010
```

## Development

```bash
bun install
bun run dev
```

Useful checks:

- `bun run --cwd packages/core test`
- `bun run --cwd packages/core check-types`
- `bun test apps/cli/src/index.test.ts`
- `bun run --cwd apps/cli check-types`

