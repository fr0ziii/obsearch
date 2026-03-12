import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initDb } from "./db";
import type { EmbeddingClient } from "./embedding";

const tempDirectories: string[] = [];
const sqliteVecSupport = probeSqliteVecSupport();
if (!sqliteVecSupport.available) {
	console.warn(`Skipping sqlite-backed db tests: ${sqliteVecSupport.reason}`);
}
const itWithSqliteVec = sqliteVecSupport.available ? it : it.skip;

afterEach(() => {
	while (tempDirectories.length > 0) {
		const path = tempDirectories.pop();
		if (!path) {
			continue;
		}

		rmSync(path, { recursive: true, force: true });
	}
});

describe("initDb", () => {
	itWithSqliteVec("loads sqlite-vec and supports vec_length()", () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 4,
		});

		const row = coreDb.db
			.prepare("SELECT vec_length(?) AS length")
			.get("[0.1,0.2,0.3,0.4]") as { length: number };

		expect(row.length).toBe(4);
		coreDb.close();
	});

	itWithSqliteVec("creates schema idempotently for file-backed databases", () => {
		const tempDirectory = mkdtempSync(join(tmpdir(), "obsearch-core-test-"));
		tempDirectories.push(tempDirectory);
		const dbPath = join(tempDirectory, "core.db");

		{
			const coreDb = initDb({
				dbPath,
				embeddingDimension: 4,
			});
			coreDb.close();
		}

		{
			const coreDb = initDb({
				dbPath,
				embeddingDimension: 4,
			});
			const itemsTable = coreDb.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
				)
				.get() as { name: string } | null;
			const vecTable = coreDb.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_embeddings'",
				)
				.get() as { name: string } | null;

			expect(itemsTable?.name).toBe("items");
			expect(vecTable?.name).toBe("item_embeddings");
			coreDb.close();
		}
	});

	itWithSqliteVec("rejects embeddings with wrong dimensions", () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		expect(() =>
			coreDb.upsertItemWithEmbedding({
				path: "/tmp/a.md",
				kind: "md",
				mtimeMs: 1,
				sizeBytes: 100,
				embedding: [1, 2],
			}),
		).toThrow("Embedding dimension mismatch");
		coreDb.close();
	});

	itWithSqliteVec(
		"searches nearest neighbors ordered by ascending distance",
		async () => {
			const coreDb = initDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
				embeddingClient: createStubEmbeddingClient({
					architecture: [1, 0, 0],
				}),
			});

			coreDb.upsertItemWithEmbedding({
				path: "/tmp/notes/architecture.md",
				kind: "md",
				mtimeMs: 1,
				sizeBytes: 100,
				embedding: [1, 0, 0],
			});
			coreDb.upsertItemWithEmbedding({
				path: "/tmp/images/diagram.png",
				kind: "image",
				mtimeMs: 2,
				sizeBytes: 110,
				embedding: [0.9, 0.1, 0],
			});
			coreDb.upsertItemWithEmbedding({
				path: "/tmp/notes/cooking.md",
				kind: "md",
				mtimeMs: 3,
				sizeBytes: 120,
				embedding: [0, 1, 0],
			});

			const results = await coreDb.search("architecture", 2);

			expect(results).toHaveLength(2);
			expect(results[0]?.path).toBe("/tmp/notes/architecture.md");
			expect(results[0]?.type).toBe("md");
			expect(results[0]?.score).toBeCloseTo(0, 6);
			expect(results[1]?.path).toBe("/tmp/images/diagram.png");
			expect(results[1]?.type).toBe("image");
			expect(results[1]?.score).toBeGreaterThan(
				results[0]?.score ?? Number.POSITIVE_INFINITY,
			);
			coreDb.close();
		},
	);

	itWithSqliteVec("search rejects invalid query values", async () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
			embeddingClient: createStubEmbeddingClient({
				query: [1, 0, 0],
			}),
		});

		await expect(coreDb.search("", 1)).rejects.toThrow(
			"Search query cannot be empty",
		);
		await expect(coreDb.search("   ", 1)).rejects.toThrow(
			"Search query cannot be empty",
		);
		coreDb.close();
	});

	itWithSqliteVec("search rejects invalid limits", async () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
			embeddingClient: createStubEmbeddingClient({
				query: [1, 0, 0],
			}),
		});

		await expect(coreDb.search("query", 0)).rejects.toThrow();
		await expect(coreDb.search("query", -1)).rejects.toThrow();
		await expect(coreDb.search("query", 1.5)).rejects.toThrow();
		coreDb.close();
	});

	itWithSqliteVec("search requires embeddingClient in initDb options", async () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		await expect(coreDb.search("query", 1)).rejects.toThrow(
			"embeddingClient is required for search",
		);
		coreDb.close();
	});

	itWithSqliteVec(
		"search rejects query embeddings with unexpected dimensions",
		async () => {
			const coreDb = initDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
				embeddingClient: createStubEmbeddingClient({
					query: [1, 0],
				}),
			});

			await expect(coreDb.search("query", 1)).rejects.toThrow(
				"Query embedding dimension mismatch: expected 3, got 2.",
			);
			coreDb.close();
		},
	);

	itWithSqliteVec("returns null metadata for unknown item path", () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		const metadata = coreDb.getItemMetadataByPath("notes/missing.md");
		expect(metadata).toBeNull();
		coreDb.close();
	});

	itWithSqliteVec("returns indexed mtime and size metadata by path", () => {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		coreDb.upsertItemWithEmbedding({
			path: "notes/architecture.md",
			kind: "md",
			mtimeMs: 12345,
			sizeBytes: 678,
			embedding: [0.1, 0.2, 0.3],
		});

		const metadata = coreDb.getItemMetadataByPath("notes/architecture.md");

		expect(metadata).toEqual({
			path: "notes/architecture.md",
			mtimeMs: 12345,
			sizeBytes: 678,
		});
		coreDb.close();
	});
});

function probeSqliteVecSupport():
	| { available: true }
	| { available: false; reason: string } {
	try {
		const coreDb = initDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});
		coreDb.close();
		return { available: true };
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("Failed to load sqlite-vec extension")
		) {
			return { available: false, reason: error.message };
		}

		throw error;
	}
}

function createStubEmbeddingClient(
	vectorsByQuery: Record<string, readonly number[]>,
): EmbeddingClient {
	return {
		model: "stub",
		async embedDocument(): Promise<Float32Array> {
			throw new Error("Unexpected call to embedDocument in db.search tests.");
		},
		async embedQuery(query: string): Promise<Float32Array> {
			const vector = vectorsByQuery[query];
			if (!vector) {
				throw new Error(`Missing test embedding for query: ${query}`);
			}

			return Float32Array.from(vector);
		},
	};
}
