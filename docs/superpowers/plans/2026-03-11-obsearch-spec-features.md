# obsearch SPEC Features Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all unchecked product features from `SPEC.md` that can be delivered in-repo, with explicit review gates per task.

**Architecture:** Extend `@obsearch/core` with an indexing pipeline (markdown, image, pdf), retry/backoff, incremental rules, and chunk metadata; expose search through API/server; ship a CLI index command and web UI that renders multimodal results with thumbnails and Obsidian deep links.

**Tech Stack:** Bun, TypeScript, Hono + oRPC, React + TanStack Router, SQLite + sqlite-vec, Gemini Embedding 2.

---

## Execution Update (2026-03-11)

- Done: Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7.
- Pending: Task 8, Task 9, Task 10, Task 11, Task 12.
- Stop condition applied: implementation paused after Task 7 per user instruction; docs updated to reflect current state.

## Chunk 1: Core Indexing Foundation

### Task 1: Image Indexing Pipeline (SPEC #6)

**Files:**
- Create: `packages/core/src/indexing.ts`
- Create: `packages/core/src/file-types.ts`
- Modify: `packages/core/src/db.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/indexing.test.ts`

- [ ] **Step 1: Write failing tests for `indexImage(...)`**
- [ ] **Step 2: Verify tests fail for missing implementation**
- [ ] **Step 3: Implement `path -> mimeType -> base64 -> embedDocument(parts) -> upsert`**
- [ ] **Step 4: Verify tests pass**
- [ ] **Step 5: Self-review and commit**

**Acceptance criteria:**
- Uses `RETRIEVAL_DOCUMENT` via `embedDocument(...)`.
- Uses correct image mime types (`png/jpg/jpeg/webp`).
- Persists vector + item metadata into sqlite.

### Task 2: Markdown Indexing Pipeline (SPEC #7)

**Files:**
- Modify: `packages/core/src/indexing.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/indexing.test.ts`

- [ ] **Step 1: Write failing tests for `indexMarkdown(...)`**
- [ ] **Step 2: Verify tests fail**
- [ ] **Step 3: Implement markdown read, chunk prep hook, embedding, and upsert**
- [ ] **Step 4: Verify tests pass**
- [ ] **Step 5: Self-review and commit**

**Acceptance criteria:**
- Uses `embedDocument(...)` with markdown text.
- Stores document metadata and embedding.

### Task 3: API Retry + Exponential Backoff (SPEC #8)

**Files:**
- Create: `packages/core/src/retry.ts`
- Modify: `packages/core/src/indexing.ts`
- Test: `packages/core/src/retry.test.ts`
- Test: `packages/core/src/indexing.test.ts`

- [ ] **Step 1: Write failing tests for retry/backoff behavior (429 + transient failures)**
- [ ] **Step 2: Verify tests fail**
- [ ] **Step 3: Implement bounded retries with exponential backoff + jitter-safe delay**
- [ ] **Step 4: Wire retry into indexing embedding calls**
- [ ] **Step 5: Verify tests pass and commit**

**Acceptance criteria:**
- 429 and transient errors retry automatically.
- Retries are bounded and surfaced on final failure.

### Task 4: Incremental Indexing by mtime + size (SPEC #9)

**Files:**
- Modify: `packages/core/src/db.ts`
- Modify: `packages/core/src/indexing.ts`
- Test: `packages/core/src/db.test.ts`
- Test: `packages/core/src/indexing.test.ts`

- [ ] **Step 1: Write failing tests for skip logic**
- [ ] **Step 2: Verify tests fail**
- [ ] **Step 3: Add DB read helpers and skip unchanged files**
- [ ] **Step 4: Verify tests pass**
- [ ] **Step 5: Self-review and commit**

**Acceptance criteria:**
- If `mtime` and `size` unchanged, item is skipped.
- Changed files are re-embedded and upserted.

---

## Chunk 2: Product Surfaces

### Task 5: CLI `index <vault-path>` (SPEC #10)

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/tsconfig.json`
- Create: `apps/cli/src/index.ts`
- Modify: `package.json` (workspace script wiring)
- Modify: `README.md`
- Test: `packages/core/src/indexing.test.ts` (pipeline entry behavior)

- [ ] **Step 1: Add failing/guard tests for pipeline-level counts**
- [ ] **Step 2: Implement CLI index command with progress and summary**
- [ ] **Step 3: Add cost estimate using token/dimension heuristics per session**
- [ ] **Step 4: Verify command behavior and tests**
- [ ] **Step 5: Self-review and commit**

**Acceptance criteria:**
- Command: `obsearch index <vault-path>`
- Prints processed/skipped/errored counts.
- Includes session cost estimate output.

### Task 6: oRPC Search Endpoint (SPEC #11)

**Files:**
- Modify: `packages/api/src/routers/index.ts`
- Modify: `packages/api/src/context.ts`
- Modify: `apps/server/src/index.ts`
- Test: `packages/api/src/routers/index.test.ts`

- [ ] **Step 1: Write failing API tests for `search(query, limit)`**
- [ ] **Step 2: Implement typed endpoint and wire to core search service**
- [ ] **Step 3: Verify tests + typecheck**
- [ ] **Step 4: Self-review and commit**

**Acceptance criteria:**
- Endpoint accepts `query`, optional `limit`.
- Returns typed ranked results.

### Task 7: Web UI Search + Thumbnails + Deep Links (SPEC #12)

**Files:**
- Modify: `apps/web/src/routes/index.tsx`
- Create: `apps/web/src/components/search-results.tsx`
- Modify: `apps/web/src/utils/orpc.ts` (if required by query shape)
- Modify: `apps/web/src/index.css` (minimal visual polish)

- [ ] **Step 1: Implement search form and query call**
- [ ] **Step 2: Render multimodal result cards**
- [ ] **Step 3: Render real `<img>` thumbnail for image matches**
- [ ] **Step 4: Add per-result Obsidian deep link**
- [ ] **Step 5: Verify web build/check-types and commit**

**Acceptance criteria:**
- Image result cards show actual image preview.
- Every result includes `obsidian://open?vault=...&file=...`.

### Task 8: README Demo Documentation (SPEC #13)

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README with full setup + indexing/search workflow**
- [ ] **Step 2: Add demo GIF section/path and reproduction steps**
- [ ] **Step 3: Verify markdown accuracy against repo commands**
- [ ] **Step 4: Commit**

**Acceptance criteria:**
- README clearly demonstrates multimodal query -> mixed results.

---

## Chunk 3: Fase 2 Features

### Task 9: Semantic Chunking for Markdown (SPEC #14)

**Files:**
- Create: `packages/core/src/chunking.ts`
- Modify: `packages/core/src/db.ts`
- Modify: `packages/core/src/indexing.ts`
- Test: `packages/core/src/chunking.test.ts`
- Test: `packages/core/src/indexing.test.ts`

- [ ] **Step 1: Write failing tests for chunk segmentation metadata**
- [ ] **Step 2: Implement chunking with chunk index + offset tracking**
- [ ] **Step 3: Persist chunk metadata in DB rows**
- [ ] **Step 4: Verify tests pass**
- [ ] **Step 5: Commit**

**Acceptance criteria:**
- Long markdown is indexed as chunks.
- Search can return chunk-level metadata.

### Task 10: PDF Text Extraction + Chunking Pipeline (SPEC #15)

**Files:**
- Modify: `packages/core/package.json` (pdf parser dependency if needed)
- Create/Modify: `packages/core/src/pdf.ts`
- Modify: `packages/core/src/indexing.ts`
- Test: `packages/core/src/pdf.test.ts`

- [ ] **Step 1: Write failing tests for PDF extraction and chunk indexing**
- [ ] **Step 2: Implement extraction and reuse markdown chunk pipeline**
- [ ] **Step 3: Verify tests pass**
- [ ] **Step 4: Commit**

**Acceptance criteria:**
- PDF text is extracted and chunk-indexed.
- Pipeline behavior aligns with markdown chunking.

### Task 11: Result Snippet Highlighting (SPEC #16)

**Files:**
- Modify: `packages/core/src/db.ts`
- Modify: `packages/api/src/routers/index.ts`
- Modify: `apps/web/src/components/search-results.tsx`
- Test: `packages/core/src/db.test.ts`

- [ ] **Step 1: Write failing tests for snippet generation/highlight metadata**
- [ ] **Step 2: Implement snippet payload in search results**
- [ ] **Step 3: Render highlighted snippet in web cards**
- [ ] **Step 4: Verify tests/build**
- [ ] **Step 5: Commit**

**Acceptance criteria:**
- Results show chunk snippet and highlighted matched terms.

---

## Non-code External Task

### Task 12: Record Demo + Publish (SPEC #17)

**Status:** Blocked in-repo (requires external recording/publishing actions).

**Deliverable in this repository:**
- [ ] Add release checklist section in README with exact publish steps and assets required.
