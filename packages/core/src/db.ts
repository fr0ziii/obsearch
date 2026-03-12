import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { z } from "zod";

import type { EmbeddingClient } from "./embedding";

export const itemKindSchema = z.enum(["md", "image", "pdf", "other"]);

export type ItemKind = z.infer<typeof itemKindSchema>;

const searchResultSchema = z.object({
  path: z.string().min(1),
  type: itemKindSchema,
  score: z.number(),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export interface InitDbOptions {
  dbPath: string;
  embeddingDimension: number;
  sqliteLibPath?: string;
  embeddingClient?: EmbeddingClient;
}

export interface UpsertItemInput {
  path: string;
  kind: ItemKind;
  mtimeMs: number;
  sizeBytes: number;
}

export interface UpsertEmbeddingInput {
  itemId: number;
  embedding: Float32Array | readonly number[];
}

export interface UpsertItemWithEmbeddingInput extends UpsertItemInput {
  embedding: Float32Array | readonly number[];
}

export interface ItemMetadataByPath {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface CoreDb {
  readonly db: Database;
  readonly embeddingDimension: number;
  upsertItem(input: UpsertItemInput): number;
  upsertEmbedding(input: UpsertEmbeddingInput): void;
  upsertItemWithEmbedding(input: UpsertItemWithEmbeddingInput): number;
  getItemMetadataByPath(path: string): ItemMetadataByPath | null;
  search(query: string, limit: number): Promise<SearchResult[]>;
  close(): void;
}

const positiveIntegerSchema = z.number().int().positive();
const nonNegativeIntegerSchema = z.number().int().nonnegative();

let configuredSqliteLibraryPath: string | undefined;

export function initDb(options: InitDbOptions): CoreDb {
  const dbPath = parseDbPath(options.dbPath);
  const embeddingDimension = positiveIntegerSchema.parse(options.embeddingDimension);
  const embeddingClient = options.embeddingClient;

  configureCustomSqliteLibrary(options.sqliteLibPath);
  const db = new Database(dbPath);

  try {
    sqliteVec.load(db);
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load sqlite-vec extension: ${message}. If this is macOS, pass sqliteLibPath to initDb(...) so Bun uses a SQLite build with extension support.`,
    );
  }

  initializeSchema(db, embeddingDimension);

  const upsertItemStatement = db.prepare(`
    INSERT INTO items (path, kind, mtime_ms, size_bytes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      kind = excluded.kind,
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes
  `);
  const selectItemIdStatement = db.prepare("SELECT id FROM items WHERE path = ?");
  const selectItemMetadataByPathStatement = db.prepare(`
    SELECT path, mtime_ms AS mtimeMs, size_bytes AS sizeBytes
    FROM items
    WHERE path = ?
  `);
  const hasItemStatement = db.prepare("SELECT id FROM items WHERE id = ?");
  const deleteEmbeddingStatement = db.prepare("DELETE FROM item_embeddings WHERE rowid = ?");
  const insertEmbeddingStatement = db.prepare(
    "INSERT INTO item_embeddings(rowid, embedding) VALUES (?, ?)",
  );
  const searchStatement = db.prepare(`
    WITH knn_matches AS (
      SELECT rowid AS item_id, distance AS score
      FROM item_embeddings
      WHERE embedding MATCH ?
        AND k = ?
    )
    SELECT
      items.path AS path,
      items.kind AS type,
      knn_matches.score AS score
    FROM knn_matches
    INNER JOIN items ON items.id = knn_matches.item_id
    ORDER BY knn_matches.score ASC
  `);

  const upsertItem = (input: UpsertItemInput): number => {
    const row = parseUpsertItemInput(input);
    upsertItemStatement.run(row.path, row.kind, row.mtimeMs, row.sizeBytes);

    const idResult = selectItemIdStatement.get(row.path) as { id: number } | null;
    if (!idResult) {
      throw new Error(`Failed to load item id after upsert for path: ${row.path}`);
    }

    return idResult.id;
  };

  const upsertEmbedding = (input: UpsertEmbeddingInput): void => {
    const itemId = positiveIntegerSchema.parse(input.itemId);
    const hasItem = hasItemStatement.get(itemId) as { id: number } | null;
    if (!hasItem) {
      throw new Error(`Cannot store embedding: item id ${itemId} does not exist.`);
    }

    const embedding = normalizeEmbeddingVector(input.embedding, embeddingDimension);
    deleteEmbeddingStatement.run(itemId);
    insertEmbeddingStatement.run(itemId, toSqliteVectorLiteral(embedding));
  };

  const upsertItemWithEmbeddingTransaction = db.transaction(
    (input: UpsertItemWithEmbeddingInput): number => {
      const itemId = upsertItem(input);
      upsertEmbedding({
        itemId,
        embedding: input.embedding,
      });

      return itemId;
    },
  );

  const search = async (query: string, limit: number): Promise<SearchResult[]> => {
    const parsedQuery = parseSearchQuery(query);
    const parsedLimit = positiveIntegerSchema.parse(limit);
    if (!embeddingClient) {
      throw new Error("initDb(...): embeddingClient is required for search().");
    }

    const queryVector = await embeddingClient.embedQuery(parsedQuery);
    const validatedQueryVector = normalizeQueryEmbeddingVector(
      queryVector,
      embeddingDimension,
    );
    const rows = searchStatement.all(
      toSqliteVectorLiteral(validatedQueryVector),
      parsedLimit,
    ) as unknown[];

    return z.array(searchResultSchema).parse(rows);
  };

  const getItemMetadataByPath = (path: string): ItemMetadataByPath | null => {
    const parsedPath = parseItemPath(path);
    const row = selectItemMetadataByPathStatement.get(parsedPath) as ItemMetadataByPath | null;
    if (!row) {
      return null;
    }

    return {
      path: parseItemPath(row.path),
      mtimeMs: nonNegativeIntegerSchema.parse(row.mtimeMs),
      sizeBytes: nonNegativeIntegerSchema.parse(row.sizeBytes),
    };
  };

  return {
    db,
    embeddingDimension,
    upsertItem,
    upsertEmbedding,
    upsertItemWithEmbedding(input: UpsertItemWithEmbeddingInput): number {
      return upsertItemWithEmbeddingTransaction(input);
    },
    getItemMetadataByPath,
    search,
    close(): void {
      db.close();
    },
  };
}

function parseDbPath(dbPath: string): string {
  const trimmed = dbPath.trim();
  if (trimmed.length === 0) {
    throw new Error("initDb requires a non-empty dbPath.");
  }

  return trimmed;
}

function parseSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    throw new Error("Search query cannot be empty.");
  }

  return trimmed;
}

function configureCustomSqliteLibrary(sqliteLibPath?: string): void {
  if (!sqliteLibPath) {
    return;
  }

  const trimmedPath = sqliteLibPath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("sqliteLibPath must be a non-empty path when provided.");
  }

  if (configuredSqliteLibraryPath && configuredSqliteLibraryPath !== trimmedPath) {
    throw new Error(
      `Database.setCustomSQLite was already called with "${configuredSqliteLibraryPath}". Use a single sqliteLibPath per process.`,
    );
  }

  if (!configuredSqliteLibraryPath) {
    Database.setCustomSQLite(trimmedPath);
    configuredSqliteLibraryPath = trimmedPath;
  }
}

function initializeSchema(db: Database, embeddingDimension: number): void {
  const migration = db.transaction(() => {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('md', 'image', 'pdf', 'other')),
        mtime_ms INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS items_set_updated_at
      AFTER UPDATE ON items
      FOR EACH ROW
      BEGIN
        UPDATE items
        SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = NEW.id;
      END;
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(
        embedding float[${embeddingDimension}]
      );
    `);
  });

  migration();
}

function parseUpsertItemInput(input: UpsertItemInput): UpsertItemInput {
  return {
    path: parseItemPath(input.path),
    kind: itemKindSchema.parse(input.kind),
    mtimeMs: nonNegativeIntegerSchema.parse(input.mtimeMs),
    sizeBytes: nonNegativeIntegerSchema.parse(input.sizeBytes),
  };
}

function parseItemPath(path: string): string {
  if (typeof path !== "string") {
    throw new Error("Item path must be a string.");
  }

  const trimmed = path.trim();
  if (trimmed.length === 0) {
    throw new Error("Item path cannot be empty.");
  }

  return trimmed;
}

function normalizeEmbeddingVector(
  embedding: Float32Array | readonly number[],
  expectedDimension: number,
): Float32Array {
  const values = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
  if (values.length !== expectedDimension) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expectedDimension}, got ${values.length}.`,
    );
  }

  return values;
}

function normalizeQueryEmbeddingVector(
  embedding: Float32Array | readonly number[],
  expectedDimension: number,
): Float32Array {
  const values = embedding instanceof Float32Array ? embedding : Float32Array.from(embedding);
  if (values.length !== expectedDimension) {
    throw new Error(
      `Query embedding dimension mismatch: expected ${expectedDimension}, got ${values.length}.`,
    );
  }

  return values;
}

function toSqliteVectorLiteral(values: Float32Array): string {
  return `[${Array.from(values).join(",")}]`;
}
