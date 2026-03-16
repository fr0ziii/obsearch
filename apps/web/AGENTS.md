# AGENTS.md — apps/web

OVERVIEW: React + Vite SPA for obsearch; file-based routing via TanStack Router, oRPC typed client, Tailwind v4 + shadcn/ui.

---

## ROUTING

- Routes live in `src/routes/`. TanStack Router plugin auto-generates `src/routeTree.gen.ts` — never edit it manually.
- Root route: `src/routes/__root.tsx` — wraps app in `ThemeProvider` + `Toaster`; defines `RouterAppContext` (`orpc`, `queryClient`).
- Index route: `src/routes/index.tsx` — registered via `createFileRoute("/")`.
- Router is instantiated in `src/main.tsx`; context values (`orpc`, `queryClient`) injected there and available in all routes via `Route.useRouteContext()`.
- New routes: create a file under `src/routes/`, export `const Route = createFileRoute("<path>")({ ... })`. No manual registration needed.

---

## STATE & API

- oRPC client setup is in `src/utils/orpc.ts`. Three exports:
  - `client: AppRouterClient` — raw typed client, use for imperative calls (mutations, one-shot fetches).
  - `orpc` — TanStack Query utils (`orpc.<procedure>.queryOptions()`), use for declarative `useQuery`.
  - `queryClient` — singleton `QueryClient` with global error toast via `QueryCache.onError`.
- Transport: `RPCLink` pointing to `${VITE_SERVER_URL}/rpc`.
- `__root.tsx` re-creates its own local `AppRouterClient` + `createTanstackQueryUtils` inside `useState` — this is intentional for SSR-safe isolation; do not merge with the module-level `client`.
- Request deduplication pattern in `index.tsx`: increment `latestSearchRequestId` ref on each submit; discard stale responses by checking `latestSearchRequestId.current !== requestId` before committing state. Do not replace this with React Query for the search call — it is a user-triggered imperative action, not a background query.
- Env vars accessed through `@obsearch/env/web` (typed Zod-validated wrapper). Never read `import.meta.env` directly.

---

## SEARCH RESULTS

- `src/components/search-results.tsx` receives `results`, `serverUrl`, `vaultName`, `thumbnailToken`, `loading` as props — no internal data fetching.
- Validation constraints (enforced in `index.tsx` before any API call):
  - Query: must be non-empty after trim.
  - Limit: optional; if provided must be integer, 1–100 (`MAX_SEARCH_LIMIT = 100`); default is 20.
- Thumbnail URL construction (`buildVaultFileUrl`): segments of the relative path are individually `encodeURIComponent`-encoded, joined with `/`, appended to `serverUrl/vault-file/`, then `?token=<thumbnailToken>` added as a query param. Never build this URL ad hoc — use the helper.
- Obsidian deep link format: `obsidian://open?vault=<encodeURIComponent(vaultName)>&file=<encodeURIComponent(relativePath)>`. Both params must be encoded.
- Path normalization (`normalizeRelativePath`): backslashes → `/`, leading slashes stripped. Always normalize before passing to URL/link builders.
- Image results render a real `<img>` thumbnail (`h-40 w-full object-cover`). Never replace with a path string or icon.
- Card key: `${result.type}:${result.path}` — type-namespaced to avoid collisions across file types sharing names.

---

## DARK MODE

- `ThemeProvider` from `next-themes` wraps the app in `__root.tsx`. `defaultTheme="dark"`, `attribute="class"`, `storageKey="vite-ui-theme"`.
- Tailwind dark mode is class-based. All new UI should use `dark:` variants and semantic tokens from `@obsearch/ui` (e.g., `text-muted-foreground`, `bg-muted`) rather than raw color values.

---

## ANTI-PATTERNS

- Do not call `client.search` inside `useQuery` — it is a user-triggered action, not a background fetch; wrapping it breaks the deduplication ref logic.
- Do not read env vars from `import.meta.env` directly — always use `@obsearch/env/web`.
- Do not edit `routeTree.gen.ts` — it is code-generated on dev/build.
- Do not construct thumbnail URLs inline — always use `buildVaultFileUrl` to ensure per-segment encoding.
- Do not skip path normalization before passing `result.path` to any URL or link builder.
