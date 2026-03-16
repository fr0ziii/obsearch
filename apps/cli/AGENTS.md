# AGENTS.md — apps/cli

## OVERVIEW
Entry point for vault indexing: parses args, wires core functions, streams per-file progress, prints summary, and exits with an appropriate code.

## USAGE
```
obsearch index <vault-path>
bun run src/index.ts index <vault-path>
```
Only one command exists: `index`. Extra args or missing vault-path → exit 1 + usage text.

## KEY FUNCTIONS
- `parseArgs(args)` — validates `process.argv.slice(2)`; returns `{ ok, value }` or `{ ok, error, usage }`.
- `runCli(args, deps?)` — orchestrator; calls `parseArgs` then `runIndexCommand`; catches fatal throws.
- `runIndexCommand(vaultPath, deps)` — resolves vault path, creates `.obsearch/index.db`, crawls, loops files, calls `indexVaultFile` per file, closes DB in `finally`.
- `meteredEmbeddingClient` — lazy wrapper around `createEmbeddingClient`; increments `embeddingCallCount` on every `embedDocument` call for cost tracking.
- `formatSummaryLines(params)` — pure; returns string array; printed via `deps.info`.
- `determineExitCode(errorCount)` — returns 0 if `errorCount === 0`, else 1.
- `resolveUsdPerCall(env)` — reads `OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL`; throws if value is non-numeric or negative.
- `estimateApiCostUsd(callCount, usdPerCall)` — pure multiply; throws on bad inputs.

## ENV VARS
| Var | Default | Purpose |
|-----|---------|---------|
| `GEMINI_API_KEY` | required | passed through to `createEmbeddingClient` via `@obsearch/core` |
| `OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL` | `0` | multiplied by embedding call count for cost estimate in summary |

## OUTPUT FORMAT
Per-file lines (stdout via `deps.info`):
```
[N/TOTAL] indexed (new_file) notes/foo.md
[N/TOTAL] skipped (up_to_date) notes/bar.md
[N/TOTAL] error notes/bad.pdf: <message>        ← stderr via deps.error
```

Summary block (stdout):
```
Summary
  indexed: N
  skipped: N
  errors: N
  duration: X.XXs

API cost estimate (heuristic)
  estimated cost: $0.000000 USD
  formula: N embedding call(s) x $0.000000 per call
  env: OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL (default 0)
  note: this is an estimate, not exact provider billing.
```

## EXIT CODES
- `0` — no errors (parse errors, crawl errors, and per-file throws all increment `errors`)
- `1` — any error count > 0, or fatal uncaught throw

## ANTI-PATTERNS
- Do not add new commands without updating `parseArgs` and the `USAGE` string.
- Do not instantiate `createEmbeddingClient` directly in `runIndexCommand` — always go through `meteredEmbeddingClient` so call count stays accurate.
- Do not call `db.close()` outside the `finally` block; the DB must close even on partial failures.
- Do not add side effects to `formatSummaryLines`, `determineExitCode`, or `estimateApiCostUsd` — they are pure and unit-tested.
- Dependency injection via `RunCliDependencies` (`env`, `now`, `info`, `error`, `coreApi`) exists for testability — keep all I/O going through those hooks.
