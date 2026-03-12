import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb } from "./db";
import type { EmbeddingClient, EmbedInput } from "./embedding";
import { indexImage, indexMarkdown, indexVaultFile } from "./indexing";

const tempDirectories: string[] = [];
const sqliteVecSupport = probeSqliteVecSupport();
if (!sqliteVecSupport.available) {
	console.warn(
		`Skipping sqlite-backed indexing tests: ${sqliteVecSupport.reason}`,
	);
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

describe("indexImage", () => {
	itWithSqliteVec("persists image metadata and embedding vectors", async () => {
		const vaultPath = createTempVault();
		const relativeImagePath = "images/cover.JPG";
		const absoluteImagePath = join(vaultPath, "images", "cover.JPG");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		const fileContents = Buffer.from("jpeg-binary");
		writeFileSync(absoluteImagePath, fileContents);

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		const embedCalls: EmbedInput[] = [];
		const embeddingClient = createStubEmbeddingClient(async (input) => {
			embedCalls.push(input);
			return [0.1, 0.2, 0.3];
		});

		try {
			const result = await indexImage({
				db: coreDb,
				embeddingClient,
				vaultPath,
				imagePath: absoluteImagePath,
			});

			expect(result.path).toBe(relativeImagePath);
			expect(result.mimeType).toBe("image/jpeg");
			expect(result.sizeBytes).toBe(fileContents.length);
			expect(result.itemId).toBeGreaterThan(0);

			const row = coreDb.db
				.prepare(
					"SELECT path, kind, mtime_ms, size_bytes FROM items WHERE id = ?",
				)
				.get(result.itemId) as {
				path: string;
				kind: string;
				mtime_ms: number;
				size_bytes: number;
			} | null;
			expect(row?.path).toBe(relativeImagePath);
			expect(row?.kind).toBe("image");
			expect(row?.mtime_ms).toBeGreaterThan(0);
			expect(row?.size_bytes).toBe(fileContents.length);

			const embeddingRow = coreDb.db
				.prepare(
					"SELECT vec_length(embedding) AS length FROM item_embeddings WHERE rowid = ?",
				)
				.get(result.itemId) as { length: number } | null;
			expect(embeddingRow?.length).toBe(3);

			expect(embedCalls).toHaveLength(1);
			const call = embedCalls[0];
			if (!call || typeof call === "string" || call.type !== "parts") {
				throw new Error("Expected embedDocument to receive parts input.");
			}
			expect(call.parts).toHaveLength(1);
			const firstPart = call.parts[0];
			if (!firstPart || !("inlineData" in firstPart)) {
				throw new Error("Expected inlineData part in embedDocument call.");
			}
			expect(firstPart.inlineData.mimeType).toBe("image/jpeg");
			expect(firstPart.inlineData.data).toBe(fileContents.toString("base64"));
		} finally {
			coreDb.close();
		}
	});

	itWithSqliteVec("throws for unsupported image extensions", async () => {
		const vaultPath = createTempVault();
		const relativeImagePath = "images/cover.gif";
		const absoluteImagePath = join(vaultPath, "images", "cover.gif");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		writeFileSync(absoluteImagePath, "gif-bytes");

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		try {
			await expect(
				indexImage({
					db: coreDb,
					embeddingClient,
					vaultPath,
					imagePath: relativeImagePath,
				}),
			).rejects.toThrow("Unsupported image extension");
			expect(embedCalls).toBe(0);

			const row = coreDb.db
				.prepare("SELECT COUNT(*) AS count FROM items")
				.get() as { count: number };
			expect(row.count).toBe(0);
		} finally {
			coreDb.close();
		}
	});

	itWithSqliteVec(
		"stores vault-relative paths for both relative and absolute image inputs",
		async () => {
			const vaultPath = createTempVault();
			const relativeImagePath = "assets/diagram.webp";
			const absoluteImagePath = join(vaultPath, "assets", "diagram.webp");
			mkdirSync(join(vaultPath, "assets"), { recursive: true });
			writeFileSync(absoluteImagePath, "webp-bytes");

			const coreDb = initTestDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
			});

			const embeddingClient = createStubEmbeddingClient(async () => [
				0.1, 0.2, 0.3,
			]);

			try {
				const relativeResult = await indexImage({
					db: coreDb,
					embeddingClient,
					vaultPath,
					imagePath: relativeImagePath,
				});
				const absoluteResult = await indexImage({
					db: coreDb,
					embeddingClient,
					vaultPath,
					imagePath: absoluteImagePath,
				});

				expect(relativeResult.path).toBe(relativeImagePath);
				expect(absoluteResult.path).toBe(relativeImagePath);

				const rows = coreDb.db
					.prepare("SELECT path FROM items ORDER BY path")
					.all() as Array<{ path: string }>;
				expect(rows).toEqual([{ path: relativeImagePath }]);
			} finally {
				coreDb.close();
			}
		},
	);

	itWithSqliteVec(
		"accepts in-vault names that begin with dots but are not parent traversal",
		async () => {
			const vaultPath = createTempVault();
			const relativeImagePath = ".../img.png";
			const absoluteImagePath = join(vaultPath, "...", "img.png");
			mkdirSync(join(vaultPath, "..."), { recursive: true });
			writeFileSync(absoluteImagePath, "png-bytes");

			const coreDb = initTestDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
			});
			const embeddingClient = createStubEmbeddingClient(async () => [
				0.1, 0.2, 0.3,
			]);

			try {
				const result = await indexImage({
					db: coreDb,
					embeddingClient,
					vaultPath,
					imagePath: relativeImagePath,
				});
				expect(result.path).toBe(relativeImagePath);
			} finally {
				coreDb.close();
			}
		},
	);

	itWithSqliteVec(
		"rejects image paths outside the vault boundary",
		async () => {
			const vaultPath = createTempVault();
			const outsidePath = createTempVault();
			const absoluteImagePath = join(outsidePath, "...", "image.png");
			mkdirSync(join(outsidePath, "..."), { recursive: true });
			writeFileSync(absoluteImagePath, "outside-image");

			const coreDb = initTestDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
			});
			const embeddingClient = createStubEmbeddingClient(async () => [
				0.1, 0.2, 0.3,
			]);

			try {
				await expect(
					indexImage({
						db: coreDb,
						embeddingClient,
						vaultPath,
						imagePath: absoluteImagePath,
					}),
				).rejects.toThrow("Image path must be inside the vault");
			} finally {
				coreDb.close();
			}
		},
	);

	itWithSqliteVec("throws when the image file is missing", async () => {
		const vaultPath = createTempVault();
		mkdirSync(join(vaultPath, "images"), { recursive: true });

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		try {
			await expect(
				indexImage({
					db: coreDb,
					embeddingClient,
					vaultPath,
					imagePath: "images/missing.png",
				}),
			).rejects.toThrow("Image file does not exist");
			expect(embedCalls).toBe(0);
		} finally {
			coreDb.close();
		}
	});

	itWithSqliteVec("throws when the image file is empty", async () => {
		const vaultPath = createTempVault();
		const imagePath = join(vaultPath, "images", "empty.png");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		writeFileSync(imagePath, "");

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		try {
			await expect(
				indexImage({
					db: coreDb,
					embeddingClient,
					vaultPath,
					imagePath: "images/empty.png",
				}),
			).rejects.toThrow("Image file is empty");
			expect(embedCalls).toBe(0);
		} finally {
			coreDb.close();
		}
	});

	it("validates invalid options shape and path value types", async () => {
		await expect(indexImage(undefined as never)).rejects.toThrow(
			"indexImage requires options.",
		);
		await expect(indexImage({} as never)).rejects.toThrow(
			"indexImage requires a db with upsertItemWithEmbedding(...).",
		);

		const optionsBase = {
			db: {
				upsertItemWithEmbedding() {
					return 1;
				},
			},
			embeddingClient: {
				async embedDocument() {
					return Float32Array.from([0.1, 0.2, 0.3]);
				},
			},
		};

		await expect(
			indexImage({
				...optionsBase,
				vaultPath: 123 as never,
				imagePath: "images/file.png",
			} as never),
		).rejects.toThrow("indexImage requires vaultPath to be a string.");

		await expect(
			indexImage({
				...optionsBase,
				vaultPath: createTempVault(),
				imagePath: 456 as never,
			} as never),
		).rejects.toThrow("indexImage requires imagePath to be a string.");
	});
});

describe("indexImage retry integration (sqlite-independent)", () => {
	it("retries transient embedding failures before persisting image", async () => {
		const vaultPath = createTempVault();
		const relativeImagePath = "images/retry.png";
		const absoluteImagePath = join(vaultPath, "images", "retry.png");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		writeFileSync(absoluteImagePath, "retry-image-bytes");

		const indexDb = createStubIndexDb();
		const retryDelays: number[] = [];
		let embedAttempts = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedAttempts += 1;
			if (embedAttempts < 3) {
				throw createHttpError(429, "rate limit");
			}
			return [0.1, 0.2, 0.3];
		});

		const result = await indexImage({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			imagePath: relativeImagePath,
			retry: {
				maxAttempts: 3,
				initialDelayMs: 1,
				backoffMultiplier: 2,
				maxDelayMs: 5,
				jitterRatio: 0,
				sleep: async (delayMs) => {
					retryDelays.push(delayMs);
				},
			},
		});

		expect(result.path).toBe(relativeImagePath);
		expect(embedAttempts).toBe(3);
		expect(retryDelays).toEqual([1, 2]);
		expect(indexDb.calls).toHaveLength(1);
		expect(indexDb.calls[0]?.kind).toBe("image");
	});
});

describe("indexImage validation (sqlite-independent)", () => {
	it("rejects unsupported image extension before embedding", async () => {
		const vaultPath = createTempVault();
		const absoluteImagePath = join(vaultPath, "images", "diagram.gif");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		writeFileSync(absoluteImagePath, "gif-content");

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexImage({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				imagePath: "images/diagram.gif",
			}),
		).rejects.toThrow("Unsupported image extension");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects missing image file", async () => {
		const vaultPath = createTempVault();
		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexImage({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				imagePath: "images/missing.png",
			}),
		).rejects.toThrow("Image file does not exist");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects empty image files before embedding", async () => {
		const vaultPath = createTempVault();
		const absoluteImagePath = join(vaultPath, "images", "empty.png");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		writeFileSync(absoluteImagePath, "");

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexImage({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				imagePath: "images/empty.png",
			}),
		).rejects.toThrow("Image file is empty");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects out-of-vault image paths", async () => {
		const vaultPath = createTempVault();
		const outsidePath = createTempVault();
		const absoluteImagePath = join(outsidePath, "outside.png");
		writeFileSync(absoluteImagePath, "outside-image");

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexImage({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				imagePath: absoluteImagePath,
			}),
		).rejects.toThrow("Image path must be inside the vault");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects symlinked image inputs explicitly", async () => {
		if (process.platform === "win32") {
			return;
		}

		const vaultPath = createTempVault();
		const outsidePath = createTempVault();
		const outsideImagePath = join(outsidePath, "outside.png");
		writeFileSync(outsideImagePath, "outside symlink target");

		mkdirSync(join(vaultPath, "images"), { recursive: true });
		const symlinkPath = join(vaultPath, "images", "linked.png");
		symlinkSync(outsideImagePath, symlinkPath);

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexImage({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				imagePath: "images/linked.png",
			}),
		).rejects.toThrow("Image path cannot include symlinks");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("supports symlinked vault root paths for non-symlinked image files", async () => {
		if (process.platform === "win32") {
			return;
		}

		const realVaultPath = createTempVault();
		const linkContainer = createTempVault();
		const symlinkedVaultPath = join(linkContainer, "vault-link");
		symlinkSync(realVaultPath, symlinkedVaultPath);

		const absoluteImagePath = join(realVaultPath, "images", "inside.png");
		mkdirSync(join(realVaultPath, "images"), { recursive: true });
		writeFileSync(absoluteImagePath, "inside-image");

		const indexDb = createStubIndexDb();
		const embeddingClient = createStubEmbeddingClient(async () => [
			0.1, 0.2, 0.3,
		]);

		const result = await indexImage({
			db: indexDb.db,
			embeddingClient,
			vaultPath: symlinkedVaultPath,
			imagePath: "images/inside.png",
		});

		expect(result.path).toBe("images/inside.png");
		expect(indexDb.calls).toHaveLength(1);
		expect(indexDb.calls[0]?.path).toBe("images/inside.png");
		expect(indexDb.calls[0]?.kind).toBe("image");
	});
});

describe("indexMarkdown", () => {
	itWithSqliteVec(
		"persists markdown metadata and embedding vectors",
		async () => {
			const vaultPath = createTempVault();
			const relativeMarkdownPath = "notes/architecture.md";
			const absoluteMarkdownPath = join(vaultPath, "notes", "architecture.md");
			const markdownContent = "# Architecture\n\nService boundaries.";
			mkdirSync(join(vaultPath, "notes"), { recursive: true });
			writeFileSync(absoluteMarkdownPath, markdownContent);

			const coreDb = initTestDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
			});

			const embedCalls: EmbedInput[] = [];
			const embeddingClient = createStubEmbeddingClient(async (input) => {
				embedCalls.push(input);
				return [0.1, 0.2, 0.3];
			});

			try {
				const result = await indexMarkdown({
					db: coreDb,
					embeddingClient,
					vaultPath,
					markdownPath: absoluteMarkdownPath,
				});

				expect(result.path).toBe(relativeMarkdownPath);
				expect(result.sizeBytes).toBe(Buffer.byteLength(markdownContent));
				expect(result.itemId).toBeGreaterThan(0);

				const row = coreDb.db
					.prepare(
						"SELECT path, kind, mtime_ms, size_bytes FROM items WHERE id = ?",
					)
					.get(result.itemId) as {
					path: string;
					kind: string;
					mtime_ms: number;
					size_bytes: number;
				} | null;
				expect(row?.path).toBe(relativeMarkdownPath);
				expect(row?.kind).toBe("md");
				expect(row?.mtime_ms).toBeGreaterThan(0);
				expect(row?.size_bytes).toBe(Buffer.byteLength(markdownContent));

				const embeddingRow = coreDb.db
					.prepare(
						"SELECT vec_length(embedding) AS length FROM item_embeddings WHERE rowid = ?",
					)
					.get(result.itemId) as { length: number } | null;
				expect(embeddingRow?.length).toBe(3);

				expect(embedCalls).toHaveLength(1);
				expect(embedCalls[0]).toBe(markdownContent);
			} finally {
				coreDb.close();
			}
		},
	);

	itWithSqliteVec("throws for unsupported markdown extensions", async () => {
		const vaultPath = createTempVault();
		const relativeTextPath = "notes/architecture.txt";
		const absoluteTextPath = join(vaultPath, "notes", "architecture.txt");
		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		writeFileSync(absoluteTextPath, "not markdown");

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		try {
			await expect(
				indexMarkdown({
					db: coreDb,
					embeddingClient,
					vaultPath,
					markdownPath: relativeTextPath,
				}),
			).rejects.toThrow("Unsupported markdown extension");
			expect(embedCalls).toBe(0);

			const row = coreDb.db
				.prepare("SELECT COUNT(*) AS count FROM items")
				.get() as { count: number };
			expect(row.count).toBe(0);
		} finally {
			coreDb.close();
		}
	});

	itWithSqliteVec(
		"stores vault-relative paths for both relative and absolute markdown inputs",
		async () => {
			const vaultPath = createTempVault();
			const relativeMarkdownPath = "docs/roadmap.md";
			const absoluteMarkdownPath = join(vaultPath, "docs", "roadmap.md");
			mkdirSync(join(vaultPath, "docs"), { recursive: true });
			writeFileSync(absoluteMarkdownPath, "Roadmap");

			const coreDb = initTestDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
			});
			const embeddingClient = createStubEmbeddingClient(async () => [
				0.1, 0.2, 0.3,
			]);

			try {
				const relativeResult = await indexMarkdown({
					db: coreDb,
					embeddingClient,
					vaultPath,
					markdownPath: relativeMarkdownPath,
				});
				const absoluteResult = await indexMarkdown({
					db: coreDb,
					embeddingClient,
					vaultPath,
					markdownPath: absoluteMarkdownPath,
				});

				expect(relativeResult.path).toBe(relativeMarkdownPath);
				expect(absoluteResult.path).toBe(relativeMarkdownPath);

				const rows = coreDb.db
					.prepare("SELECT path FROM items ORDER BY path")
					.all() as Array<{ path: string }>;
				expect(rows).toEqual([{ path: relativeMarkdownPath }]);
			} finally {
				coreDb.close();
			}
		},
	);

	itWithSqliteVec("throws when markdown content is empty", async () => {
		const vaultPath = createTempVault();
		const absoluteMarkdownPath = join(vaultPath, "notes", "empty.md");
		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		writeFileSync(absoluteMarkdownPath, " \n\t ");

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		try {
			await expect(
				indexMarkdown({
					db: coreDb,
					embeddingClient,
					vaultPath,
					markdownPath: absoluteMarkdownPath,
				}),
			).rejects.toThrow("Markdown file is empty");
			expect(embedCalls).toBe(0);
		} finally {
			coreDb.close();
		}
	});

	itWithSqliteVec(
		"rejects markdown paths outside the vault boundary",
		async () => {
			const vaultPath = createTempVault();
			const outsidePath = createTempVault();
			const absoluteMarkdownPath = join(outsidePath, "notes", "outside.md");
			mkdirSync(join(outsidePath, "notes"), { recursive: true });
			writeFileSync(absoluteMarkdownPath, "Outside");

			const coreDb = initTestDb({
				dbPath: ":memory:",
				embeddingDimension: 3,
			});
			const embeddingClient = createStubEmbeddingClient(async () => [
				0.1, 0.2, 0.3,
			]);

			try {
				await expect(
					indexMarkdown({
						db: coreDb,
						embeddingClient,
						vaultPath,
						markdownPath: absoluteMarkdownPath,
					}),
				).rejects.toThrow("Markdown path must be inside the vault");
			} finally {
				coreDb.close();
			}
		},
	);

	itWithSqliteVec("throws when the markdown file is missing", async () => {
		const vaultPath = createTempVault();

		const coreDb = initTestDb({
			dbPath: ":memory:",
			embeddingDimension: 3,
		});

		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		try {
			await expect(
				indexMarkdown({
					db: coreDb,
					embeddingClient,
					vaultPath,
					markdownPath: "notes/missing.md",
				}),
			).rejects.toThrow("Markdown file does not exist");
			expect(embedCalls).toBe(0);
		} finally {
			coreDb.close();
		}
	});
});

describe("indexMarkdown validation (sqlite-independent)", () => {
	it("retries transient embedding failures before persisting markdown", async () => {
		const vaultPath = createTempVault();
		const relativeMarkdownPath = "notes/retry.md";
		const absoluteMarkdownPath = join(vaultPath, "notes", "retry.md");
		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		writeFileSync(absoluteMarkdownPath, "Retry markdown content");

		const indexDb = createStubIndexDb();
		const retryDelays: number[] = [];
		let embedAttempts = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedAttempts += 1;
			if (embedAttempts < 3) {
				throw createHttpError(503, "service unavailable");
			}
			return [0.1, 0.2, 0.3];
		});

		const result = await indexMarkdown({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			markdownPath: relativeMarkdownPath,
			retry: {
				maxAttempts: 3,
				initialDelayMs: 2,
				backoffMultiplier: 2,
				maxDelayMs: 8,
				jitterRatio: 0,
				sleep: async (delayMs) => {
					retryDelays.push(delayMs);
				},
			},
		});

		expect(result.path).toBe(relativeMarkdownPath);
		expect(embedAttempts).toBe(3);
		expect(retryDelays).toEqual([2, 4]);
		expect(indexDb.calls).toHaveLength(1);
		expect(indexDb.calls[0]?.kind).toBe("md");
	});

	it("rejects unsupported markdown extension before embedding", async () => {
		const vaultPath = createTempVault();
		const absoluteTextPath = join(vaultPath, "notes", "architecture.txt");
		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		writeFileSync(absoluteTextPath, "not markdown");

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexMarkdown({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				markdownPath: "notes/architecture.txt",
			}),
		).rejects.toThrow("Unsupported markdown extension");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("stores vault-relative path for both relative and absolute markdown inputs", async () => {
		const vaultPath = createTempVault();
		const relativeMarkdownPath = "docs/roadmap.md";
		const absoluteMarkdownPath = join(vaultPath, "docs", "roadmap.md");
		mkdirSync(join(vaultPath, "docs"), { recursive: true });
		writeFileSync(absoluteMarkdownPath, "Roadmap");

		const indexDb = createStubIndexDb();
		const embeddingClient = createStubEmbeddingClient(async () => [
			0.1, 0.2, 0.3,
		]);

		const relativeResult = await indexMarkdown({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			markdownPath: relativeMarkdownPath,
		});
		const absoluteResult = await indexMarkdown({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			markdownPath: absoluteMarkdownPath,
		});

		expect(relativeResult.path).toBe(relativeMarkdownPath);
		expect(absoluteResult.path).toBe(relativeMarkdownPath);
		expect(indexDb.calls.map((call) => call.path)).toEqual([
			relativeMarkdownPath,
			relativeMarkdownPath,
		]);
	});

	it("accepts in-vault names that begin with dots but are not parent traversal", async () => {
		const vaultPath = createTempVault();
		const relativeMarkdownPath = ".../file.md";
		const absoluteMarkdownPath = join(vaultPath, "...", "file.md");
		mkdirSync(join(vaultPath, "..."), { recursive: true });
		writeFileSync(absoluteMarkdownPath, "Dot-prefixed directory file");

		const indexDb = createStubIndexDb();
		const embeddingClient = createStubEmbeddingClient(async () => [
			0.1, 0.2, 0.3,
		]);

		const result = await indexMarkdown({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			markdownPath: relativeMarkdownPath,
		});

		expect(result.path).toBe(relativeMarkdownPath);
		expect(indexDb.calls).toHaveLength(1);
		expect(indexDb.calls[0]?.path).toBe(relativeMarkdownPath);
		expect(indexDb.calls[0]?.kind).toBe("md");
	});

	it("rejects empty markdown content before embedding", async () => {
		const vaultPath = createTempVault();
		const absoluteMarkdownPath = join(vaultPath, "notes", "empty.md");
		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		writeFileSync(absoluteMarkdownPath, " \n\t ");

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexMarkdown({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				markdownPath: "notes/empty.md",
			}),
		).rejects.toThrow("Markdown file is empty");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects out-of-vault markdown path", async () => {
		const vaultPath = createTempVault();
		const outsidePath = createTempVault();
		const absoluteMarkdownPath = join(outsidePath, "notes", "outside.md");
		mkdirSync(join(outsidePath, "notes"), { recursive: true });
		writeFileSync(absoluteMarkdownPath, "Outside");

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexMarkdown({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				markdownPath: absoluteMarkdownPath,
			}),
		).rejects.toThrow("Markdown path must be inside the vault");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects missing markdown file", async () => {
		const vaultPath = createTempVault();
		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexMarkdown({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				markdownPath: "notes/missing.md",
			}),
		).rejects.toThrow("Markdown file does not exist");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});

	it("rejects symlinked markdown inputs explicitly", async () => {
		if (process.platform === "win32") {
			return;
		}

		const vaultPath = createTempVault();
		const outsidePath = createTempVault();
		const outsideMarkdownPath = join(outsidePath, "outside.md");
		writeFileSync(outsideMarkdownPath, "Outside symlink target");

		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		const symlinkPath = join(vaultPath, "notes", "linked.md");
		symlinkSync(outsideMarkdownPath, symlinkPath);

		const indexDb = createStubIndexDb();
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		await expect(
			indexMarkdown({
				db: indexDb.db,
				embeddingClient,
				vaultPath,
				markdownPath: "notes/linked.md",
			}),
		).rejects.toThrow("Markdown path cannot include symlinks");
		expect(embedCalls).toBe(0);
		expect(indexDb.calls).toHaveLength(0);
	});
});

describe("indexVaultFile incremental behavior", () => {
	it("skips unchanged files when mtime and size match existing metadata", async () => {
		const vaultPath = createTempVault();
		const file = {
			path: "notes/unchanged.md",
			type: "md" as const,
			size: 123,
			mtime: 456,
		};
		const indexDb = createStubIncrementalIndexDb({
			[file.path]: {
				path: file.path,
				mtimeMs: file.mtime,
				sizeBytes: file.size,
			},
		});

		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		const result = await indexVaultFile({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			file,
		});

		expect(result).toEqual({
			status: "skipped",
			reason: "unchanged",
			path: file.path,
			type: file.type,
			mtimeMs: file.mtime,
			sizeBytes: file.size,
		});
		expect(indexDb.getCalls).toEqual([file.path]);
		expect(indexDb.upsertCalls).toHaveLength(0);
		expect(embedCalls).toBe(0);
	});

	it("reindexes when metadata changed", async () => {
		const vaultPath = createTempVault();
		const relativeMarkdownPath = "notes/changed.md";
		const absoluteMarkdownPath = join(vaultPath, "notes", "changed.md");
		mkdirSync(join(vaultPath, "notes"), { recursive: true });
		writeFileSync(absoluteMarkdownPath, "Changed markdown");

		const indexDb = createStubIncrementalIndexDb({
			[relativeMarkdownPath]: {
				path: relativeMarkdownPath,
				mtimeMs: 1,
				sizeBytes: 1,
			},
		});
		const embeddingClient = createStubEmbeddingClient(async () => [
			0.1, 0.2, 0.3,
		]);

		const result = await indexVaultFile({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			file: {
				path: relativeMarkdownPath,
				type: "md",
				size: 9999,
				mtime: 9999,
			},
		});

		expect(result.status).toBe("indexed");
		expect(result.reason).toBe("changed");
		expect(indexDb.getCalls).toEqual([relativeMarkdownPath]);
		expect(indexDb.upsertCalls).toHaveLength(1);
		expect(indexDb.upsertCalls[0]?.path).toBe(relativeMarkdownPath);
		expect(indexDb.upsertCalls[0]?.kind).toBe("md");
	});

	it("indexes when no prior metadata exists", async () => {
		const vaultPath = createTempVault();
		const relativeImagePath = "images/new.png";
		const absoluteImagePath = join(vaultPath, "images", "new.png");
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		writeFileSync(absoluteImagePath, "image-bytes");

		const indexDb = createStubIncrementalIndexDb({});
		const embeddingClient = createStubEmbeddingClient(async () => [
			0.1, 0.2, 0.3,
		]);

		const result = await indexVaultFile({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			file: {
				path: relativeImagePath,
				type: "image",
				size: 1,
				mtime: 1,
			},
		});

		expect(result.status).toBe("indexed");
		expect(result.reason).toBe("missing");
		expect(indexDb.getCalls).toEqual([relativeImagePath]);
		expect(indexDb.upsertCalls).toHaveLength(1);
		expect(indexDb.upsertCalls[0]?.path).toBe(relativeImagePath);
		expect(indexDb.upsertCalls[0]?.kind).toBe("image");
	});

	it("skips pdf when no prior metadata exists", async () => {
		const vaultPath = createTempVault();
		const relativePdfPath = "docs/new.pdf";
		const indexDb = createStubIncrementalIndexDb({});
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		const result = await indexVaultFile({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			file: {
				path: relativePdfPath,
				type: "pdf",
				size: 42,
				mtime: 84,
			},
		});

		expect(result).toEqual({
			status: "skipped",
			reason: "unsupported_pdf",
			path: relativePdfPath,
			type: "pdf",
			mtimeMs: 84,
			sizeBytes: 42,
		});
		expect(indexDb.getCalls).toEqual([relativePdfPath]);
		expect(indexDb.upsertCalls).toHaveLength(0);
		expect(embedCalls).toBe(0);
	});

	it("skips pdf when metadata changed", async () => {
		const vaultPath = createTempVault();
		const relativePdfPath = "docs/changed.pdf";
		const indexDb = createStubIncrementalIndexDb({
			[relativePdfPath]: {
				path: relativePdfPath,
				mtimeMs: 1,
				sizeBytes: 1,
			},
		});
		let embedCalls = 0;
		const embeddingClient = createStubEmbeddingClient(async () => {
			embedCalls += 1;
			return [0.1, 0.2, 0.3];
		});

		const result = await indexVaultFile({
			db: indexDb.db,
			embeddingClient,
			vaultPath,
			file: {
				path: relativePdfPath,
				type: "pdf",
				size: 4200,
				mtime: 8400,
			},
		});

		expect(result).toEqual({
			status: "skipped",
			reason: "unsupported_pdf",
			path: relativePdfPath,
			type: "pdf",
			mtimeMs: 8400,
			sizeBytes: 4200,
		});
		expect(indexDb.getCalls).toEqual([relativePdfPath]);
		expect(indexDb.upsertCalls).toHaveLength(0);
		expect(embedCalls).toBe(0);
	});
});

function createTempVault(): string {
	const directoryPath = mkdtempSync(join(tmpdir(), "obsearch-indexing-test-"));
	tempDirectories.push(directoryPath);
	return directoryPath;
}

function initTestDb(
	options: Parameters<typeof initDb>[0],
): ReturnType<typeof initDb> {
	try {
		return initDb(options);
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith("Failed to load sqlite-vec extension")
		) {
			throw new Error(
				`sqlite-vec is required for indexing tests: ${error.message}`,
			);
		}

		throw error;
	}
}

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
	embedDocument: (input: EmbedInput) => Promise<readonly number[]>,
): EmbeddingClient {
	return {
		model: "stub",
		async embedDocument(input: EmbedInput): Promise<Float32Array> {
			const vector = await embedDocument(input);
			return Float32Array.from(vector);
		},
		async embedQuery(): Promise<Float32Array> {
			throw new Error("Unexpected call to embedQuery in indexing tests.");
		},
	};
}

function createHttpError(status: number, message: string): Error & { status: number } {
	const error = new Error(message) as Error & { status: number };
	error.status = status;
	return error;
}

function createStubIndexDb(): {
	db: {
		upsertItemWithEmbedding(input: {
			path: string;
			kind: string;
			mtimeMs: number;
			sizeBytes: number;
			embedding: Float32Array | readonly number[];
		}): number;
	};
	calls: Array<{
		path: string;
		kind: string;
		mtimeMs: number;
		sizeBytes: number;
		embedding: Float32Array | readonly number[];
	}>;
} {
	const calls: Array<{
		path: string;
		kind: string;
		mtimeMs: number;
		sizeBytes: number;
		embedding: Float32Array | readonly number[];
	}> = [];

	return {
		db: {
			upsertItemWithEmbedding(input): number {
				calls.push(input);
				return calls.length;
			},
		},
		calls,
	};
}

function createStubIncrementalIndexDb(
	metadataByPath: Record<
		string,
		{
			path: string;
			mtimeMs: number;
			sizeBytes: number;
		}
	>,
): {
	db: {
		getItemMetadataByPath(path: string): {
			path: string;
			mtimeMs: number;
			sizeBytes: number;
		} | null;
		upsertItemWithEmbedding(input: {
			path: string;
			kind: string;
			mtimeMs: number;
			sizeBytes: number;
			embedding: Float32Array | readonly number[];
		}): number;
	};
	getCalls: string[];
	upsertCalls: Array<{
		path: string;
		kind: string;
		mtimeMs: number;
		sizeBytes: number;
		embedding: Float32Array | readonly number[];
	}>;
} {
	const getCalls: string[] = [];
	const upsertCalls: Array<{
		path: string;
		kind: string;
		mtimeMs: number;
		sizeBytes: number;
		embedding: Float32Array | readonly number[];
	}> = [];

	return {
		db: {
			getItemMetadataByPath(path) {
				getCalls.push(path);
				return metadataByPath[path] ?? null;
			},
			upsertItemWithEmbedding(input): number {
				upsertCalls.push(input);
				return upsertCalls.length;
			},
		},
		getCalls,
		upsertCalls,
	};
}
