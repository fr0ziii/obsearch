# apps/server AGENTS.md

## OVERVIEW
Hono HTTP server wiring oRPC handlers and the vault-file thumbnail route; entry point is `src/index.ts`.

## ROUTES
| Method | Path | Handler | Notes |
|--------|------|---------|-------|
| GET | `/vault-file/*` | inline (L46–105) | loopback + token gated; streams raw file |
| ANY | `/rpc/*` | `rpcHandler` (L131) | oRPC binary/JSON-RPC; prefix `/rpc` |
| ANY | `/api-reference/*` | `apiHandler` (L140) | OpenAPI + Scalar UI; prefix `/api-reference` |
| GET | `/` | inline (L152) | health check, returns `"OK"` |

CORS applied globally via `hono/cors` with `env.CORS_ORIGIN` (L38–44); methods: GET, POST, OPTIONS.

## THUMBNAIL SERVING FLOW (`GET /vault-file/*`)
1. **Loopback check** (L47–49): `isLoopbackRequest` validates request URL hostname, `host` header, `origin` header, and `x-forwarded-for` — all must resolve to `localhost`, `127.0.0.1`, or `::1`. Any non-loopback value → 403.
2. **Token check** (L51–54): `extractProvidedThumbnailToken` reads token from `?token=`, `x-obsearch-thumbnail-token` header, or `Authorization: Bearer`. Must equal `env.OBSEARCH_THUMBNAIL_TOKEN` → 403 on mismatch.
3. **Path decode** (L56–61): `extractEncodedVaultPath` strips `/vault-file/` prefix; `parseRequestedVaultPath` decodes URI, rejects null bytes, `.`, `..`, and empty segments → 400 on failure.
4. **MIME check** (L63–66): `resolveImageMimeType` (from `@obsearch/core`) must return a supported type → 415 if not.
5. **Pre-symlink boundary check** (L68–71): `resolve(realVaultRootPath, requestedPath)` then `isInsideBasePath` using `relative()` — must not escape vault root → 403.
6. **Symlink resolution** (L73–82): `realpathSync` resolves symlinks; ENOENT/ENOTDIR → 404.
7. **Post-symlink boundary check** (L84–86): repeat `isInsideBasePath` on the real path → 403 if symlink escapes vault.
8. **File stat** (L88–91): `statSync(...).isFile()` — non-files → 404.
9. **Serve** (L93–104): `Bun.file(realRequestedPath)` streamed as `Response`; `Cache-Control: private, max-age=60`.

## oRPC WIRING
- `appRouter` imported from `@obsearch/api/routers/index` (L2).
- `RPCHandler` (L120–126): handles `/rpc` prefix; binary oRPC protocol used by the web client.
- `OpenAPIHandler` (L107–118): handles `/api-reference` prefix; mounts Scalar UI via `OpenAPIReferencePlugin`; schema via `ZodToJsonSchemaConverter`.
- Both share the same `context` built per-request via `createContext({ context: c, searchCore: coreDb })` (L129); `searchCore` is the SQLite+sqlite-vec handle initialized at startup.
- Catch-all middleware (L128–150) tries RPC first, then OpenAPI, then falls through to `next()`.

## ANTI-PATTERNS
- Do not add new file-serving routes without both the loopback check and token check — the two-stage boundary check (pre- and post-`realpathSync`) is required, not optional.
- Do not pass a plain `vaultPath` string to file operations — always use `realVaultRootPath` (resolved at startup via `resolveVaultRootPath`, L156–176).
- Do not skip the post-symlink `isInsideBasePath` check; symlinks can pass the pre-symlink check and still escape the vault.
- Do not add business logic to this file — it belongs in `packages/core` or `packages/api`.
- Token model is demo-level (static secret); do not promote it as production auth.
