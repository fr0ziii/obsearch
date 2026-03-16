# packages/core — AGENTS.md

Shared library: embeddings, SQLite/vec DB, crawling, and the indexing pipeline. Consumed by CLI, server, and API packages.

## WHERE TO LOOK

| What | File | Lines |
|---|---|---|
| Public exports | `src/index.ts` | 1–61 |
| DB init + schema creation | `src/db.ts` | `initDb` L64, `initializeSchema` L245 |
| KNN search SQL | `src/db.ts` | `searchStatement` L103–117 |
| Embedding upsert (delete+insert pattern) | `src/db.ts` | `upsertEmbedding` L131–141 |
| Atomic upsert transaction | `src/db.ts` | `upsertItemWithEmbeddingTransaction` L143–153 |
| Embedding client factory | `src/embedding.ts` | `createEmbeddingClient` L80 |
| Image embed (inlineData parts) | `src/embedding.ts` | `normalizeEmbedInput` L170–185 |
| Index image (base64 + vault boundary) | `src/indexing.ts` | `indexImage` L73–140 |
| Index markdown | `src/indexing.ts` | `indexMarkdown` L142–210 |
| Incremental skip logic | `src/indexing.ts` | `indexVaultFile` L212–281 |
| Retry defaults | `src/retry.ts` | L27–31 (4 attempts, 250ms initial, 4s max) |
| Retry-After header parsing | `src/retry.ts` | `computeServerHintDelayMs` L274, `extractRetryAfterHintMs` L283 |
| Crawler walk + hidden/symlink skip | `src/crawler.ts` | `walkDirectory` L66–133 |
| Extension-to-type map | `src/crawler.ts` | `extensionToType` L28–35 |

## KEY TYPES

- `CoreDb` — interface returned by `initDb`; only surface the CLI/server should hold. `db.db` exposes raw `bun:sqlite` `Database` if needed.
- `UpsertItemWithEmbeddingInput` — extends `UpsertItemInput` + `embedding: Float32Array | readonly number[]`. Use this for atomic writes.
- `SearchResult` — `{ path, type: ItemKind, score }`. `score` is L2 distance (lower = more similar).
- `IndexVaultFileResult` — discriminated union on `status` (`"indexed"` | `"skipped"`) and `reason` (`"missing"` | `"changed"` | `"unchanged"` | `"unsupported_pdf"`).
- `EmbedInput` — `string | { type: "text"; text } | { type: "parts"; parts: EmbedPart[] }`. Images must use `"parts"` with `inlineData`.
- `CrawlVaultFile.path` — always vault-relative POSIX. `CrawlVaultFile.mtime` is epoch ms (from `Bun.file().lastModified`).

## DB SCHEMA DETAILS

Two tables only:

```sql
items(id, path UNIQUE, kind, mtime_ms, size_bytes, created_at, updated_at)
item_embeddings USING vec0(embedding float[N])  -- N = embeddingDimension at init time
```

- `item_embeddings.rowid` is the foreign key to `items.id` — no explicit FK constraint (vec0 is virtual).
- KNN syntax: `WHERE embedding MATCH ? AND k = ?` — both params required, order matters. First param is the vector literal string `[f1,f2,...]`, second is the integer limit.
- Upsert for embeddings is delete-then-insert (L139–140), not `ON CONFLICT` — vec0 doesn't support upsert natively.
- `sqliteLibPath` required on macOS because Bun bundles SQLite without extension support. Pass it via `InitDbOptions`; it calls `Database.setCustomSQLite` once per process — calling twice with a different path throws.
- `embeddingDimension` baked into the schema at `CREATE VIRTUAL TABLE` time. Changing it after DB creation silently breaks search (dimension mismatch on insert will throw, but an existing DB opened with wrong dimension won't).

## GOTCHAS

- **Empty markdown throws**: `indexMarkdown` rejects files where `text.trim().length === 0` — the CLI must handle this as a skip, not a crash.
- **PDF is always skipped**: `indexVaultFile` returns `{ status: "skipped", reason: "unsupported_pdf" }` regardless of mtime — PDF pipeline not yet implemented.
- **Symlink rejection is per-segment**: `assertImageInputHasNoSymlinks` / `assertMarkdownInputHasNoSymlinks` walk every path segment with `lstat` — a symlinked parent directory also fails, not just the leaf.
- **Paths stored as vault-relative POSIX**: `indexImage`/`indexMarkdown` call `realpath` then `relative(realVaultPath, realFilePath)` then `toPosixPath`. Do not store absolute paths.
- **`search()` requires `embeddingClient` at `initDb` time**: If omitted, calling `db.search(...)` throws at runtime. The CLI omits it (index only); the server must pass it.
- **Retry `shouldRetry` defaults to `isRetriableEmbeddingError`**: Retries on HTTP 429/5xx and transient network codes. Non-retriable errors (4xx except 429) propagate immediately without exhausting attempts.
- **`configuredSqliteLibraryPath` is module-level state**: Only one `sqliteLibPath` per process. Tests that spin up multiple `initDb` calls with different paths will conflict.
