# packages/api — AGENTS.md

## OVERVIEW
oRPC-based API layer: defines the router, input/output schemas, and context wiring consumed by `apps/server`.

## STRUCTURE
```
src/
  index.ts          # oRPC base instance (os.$context<Context>()) + publicProcedure export
  context.ts        # createContext() — injects searchCore dependency; returns { session, core }
  routers/
    index.ts        # appRouter definition, schemas, runSearch helper; AppRouter + AppRouterClient types
```

Key exports from `routers/index.ts`:
- `appRouter` — flat object of oRPC procedures (no nesting currently)
- `AppRouter` / `AppRouterClient` — types consumed by the web client
- `searchInputSchema` — Zod shape for search input; re-used by the web app for client-side validation
- `runSearch(core, input)` — pure function; can be unit-tested without HTTP

## CONTEXT / DEPENDENCY INJECTION
- `createContext({ context, searchCore })` is called per-request in `apps/server`.
- `searchCore` is typed as `Pick<CoreDb, "search">` — only the `search` method is required.
- The resolved context (`{ session: null, core }`) is passed to every procedure via `{ context }`.
- No auth today; `session` is always `null`. Auth goes here when needed.
- If `searchCore` is missing at runtime, `createContext` throws immediately with a descriptive message.

## HOW TO ADD PROCEDURES
1. Add a new procedure to `appRouter` in `src/routers/index.ts`:
   ```ts
   myProcedure: publicProcedure
     .input(myInputSchema)
     .output(myOutputSchema)
     .handler(async ({ context, input }) => { ... })
   ```
2. Access `context.core` for DB operations; add new methods to `SearchCore` type in `context.ts` if needed.
3. No router registration elsewhere — `appRouter` is the single export consumed by `apps/server`.
4. Export any shared types/schemas from `routers/index.ts` so `apps/web` can import them directly.

## GOTCHAS
- `publicProcedure` is created from `os.$context<Context>()` — always import it from `../index`, not re-instantiated.
- `searchInputSchema` enforces `query` trim + min(1) and `limit` max(100). Validate on the client too — the schema is exported for that purpose.
- `DEFAULT_SEARCH_LIMIT = 20`, `MAX_SEARCH_LIMIT = 100` — use these constants, don't hardcode numbers.
- `itemKindSchema` comes from `@obsearch/core`; result `type` field must match that union.
- No nested routers: keep `appRouter` flat unless complexity genuinely demands nesting.
