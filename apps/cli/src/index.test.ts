import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CrawlVaultResult, IndexVaultFileResult } from "@obsearch/core";

import {
	determineExitCode,
	estimateApiCostUsd,
	formatSummaryLines,
	parseArgs,
	resolveUsdPerCall,
	runCli,
} from "./index";

const tempDirectories: string[] = [];

afterEach(() => {
	while (tempDirectories.length > 0) {
		const path = tempDirectories.pop();
		if (!path) {
			continue;
		}

		rmSync(path, { force: true, recursive: true });
	}
});

describe("parseArgs", () => {
	it("parses index command with vault path", () => {
		const result = parseArgs(["index", "/vault"]);

		expect(result).toEqual({
			ok: true,
			value: {
				command: "index",
				vaultPath: "/vault",
			},
		});
	});

	it("preserves vault path input while validating non-empty content", () => {
		const result = parseArgs(["index", "  /vault with spaces  "]);

		expect(result).toEqual({
			ok: true,
			value: {
				command: "index",
				vaultPath: "  /vault with spaces  ",
			},
		});
	});

	it("returns usage details for invalid command", () => {
		const result = parseArgs(["search", "/vault"]);

		expect(result.ok).toBeFalse();
		if (result.ok) {
			throw new Error("expected an invalid parse result");
		}
		expect(result.error).toContain("Unknown command");
		expect(result.usage).toContain("Usage:");
	});
});

describe("resolveUsdPerCall", () => {
	it("defaults to zero when env var is missing", () => {
		expect(resolveUsdPerCall({})).toBe(0);
	});

	it("parses the explicit env var value", () => {
		expect(
			resolveUsdPerCall({
				OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL: "0.00013",
			}),
		).toBe(0.00013);
	});
});

describe("estimateApiCostUsd", () => {
	it("multiplies embedding call count by per-call USD", () => {
		expect(estimateApiCostUsd(25, 0.00012)).toBe(0.003);
	});
});

describe("determineExitCode", () => {
	it("returns non-zero when there are errors", () => {
		expect(determineExitCode(1)).toBe(1);
	});

	it("returns zero when there are no errors", () => {
		expect(determineExitCode(0)).toBe(0);
	});
});

describe("formatSummaryLines", () => {
	it("includes counts and estimate disclaimer", () => {
		const lines = formatSummaryLines({
			indexed: 8,
			skipped: 3,
			errors: 2,
			embeddingCallCount: 9,
			usdPerCall: 0.00015,
			durationMs: 1_230,
		}).join("\n");

		expect(lines).toContain("indexed");
		expect(lines).toContain("skipped");
		expect(lines).toContain("errors");
		expect(lines).toContain("estimate");
		expect(lines).toContain("OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL");
	});
});

describe("runCli orchestration", () => {
	it("returns zero for successful indexing with no crawl/file errors", async () => {
		const vaultPath = createTempVault();
		const infoLogs: string[] = [];
		const errorLogs: string[] = [];

		let nowCall = 0;
		const nowValues = [1_000, 2_000];
		const crawlResult: CrawlVaultResult = {
			files: [
				{ path: "note.md", type: "md", size: 10, mtime: 111 },
				{ path: "paper.pdf", type: "pdf", size: 20, mtime: 222 },
			],
			errors: [],
		};

		const exitCode = await runCli(["index", vaultPath], {
			env: {},
			now: () => {
				const value = nowValues[nowCall];
				nowCall += 1;
				return value ?? 2_000;
			},
			info: (message) => infoLogs.push(message),
			error: (message) => errorLogs.push(message),
			coreApi: {
				crawlVault: async () => crawlResult,
				initDb: () => createMockDb(),
				createEmbeddingClient: () => ({
					embedDocument: async () => Float32Array.from([0.1, 0.2, 0.3]),
				}),
				indexVaultFile: async ({ file }): Promise<IndexVaultFileResult> => {
					if (file.path === "note.md") {
						return {
							status: "indexed",
							reason: "missing",
							type: "md",
							itemId: 1,
							path: file.path,
							mtimeMs: file.mtime,
							sizeBytes: file.size,
						};
					}

					return {
						status: "skipped",
						reason: "unsupported_pdf",
						type: "pdf",
						path: file.path,
						mtimeMs: file.mtime,
						sizeBytes: file.size,
					};
				},
			},
		});

		expect(exitCode).toBe(0);
		expect(errorLogs).toEqual([]);
		expect(infoLogs.some((line) => line.includes("[1/2] indexed"))).toBeTrue();
		expect(infoLogs.some((line) => line.includes("[2/2] skipped"))).toBeTrue();
		expect(infoLogs.some((line) => line.includes("errors: 0"))).toBeTrue();
	});

	it("returns non-zero when crawler or file-level errors occur", async () => {
		const vaultPath = createTempVault();
		const infoLogs: string[] = [];
		const errorLogs: string[] = [];

		const crawlResult: CrawlVaultResult = {
			files: [
				{ path: "broken.md", type: "md", size: 10, mtime: 111 },
				{ path: "ok.md", type: "md", size: 20, mtime: 222 },
			],
			errors: [{ path: "locked", message: "Permission denied" }],
		};

		let indexCallCount = 0;
		const exitCode = await runCli(["index", vaultPath], {
			env: {},
			now: () => 5_000,
			info: (message) => infoLogs.push(message),
			error: (message) => errorLogs.push(message),
			coreApi: {
				crawlVault: async () => crawlResult,
				initDb: () => createMockDb(),
				createEmbeddingClient: () => ({
					embedDocument: async () => Float32Array.from([0.1, 0.2, 0.3]),
				}),
				indexVaultFile: async ({ file }): Promise<IndexVaultFileResult> => {
					indexCallCount += 1;
					if (file.path === "broken.md") {
						throw new Error("embed failed");
					}

					return {
						status: "indexed",
						reason: "missing",
						type: "md",
						itemId: 3,
						path: file.path,
						mtimeMs: file.mtime,
						sizeBytes: file.size,
					};
				},
			},
		});

		expect(exitCode).toBe(1);
		expect(indexCallCount).toBe(2);
		expect(
			errorLogs.some((line) =>
				line.includes("[crawl-error] locked: Permission denied"),
			),
		).toBeTrue();
		expect(
			errorLogs.some((line) =>
				line.includes("[1/2] error broken.md: embed failed"),
			),
		).toBeTrue();
		expect(infoLogs.some((line) => line.includes("errors: 2"))).toBeTrue();
	});

	it("returns non-zero for invalid cost env var and stops before crawling", async () => {
		let crawlCalled = false;
		const errorLogs: string[] = [];
		const exitCode = await runCli(["index", "/vault"], {
			env: { OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL: "bad-value" },
			now: () => 0,
			info: () => {},
			error: (message) => errorLogs.push(message),
			coreApi: {
				crawlVault: async () => {
					crawlCalled = true;
					return { files: [], errors: [] };
				},
				initDb: () => createMockDb(),
				createEmbeddingClient: () => ({
					embedDocument: async () => Float32Array.from([0.1, 0.2, 0.3]),
				}),
				indexVaultFile: async ({ file }): Promise<IndexVaultFileResult> => ({
					status: "skipped",
					reason: "unchanged",
					type: file.type,
					path: file.path,
					mtimeMs: file.mtime,
					sizeBytes: file.size,
				}),
			},
		});

		expect(exitCode).toBe(1);
		expect(crawlCalled).toBeFalse();
		expect(
			errorLogs.some((line) =>
				line.includes("OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL"),
			),
		).toBeTrue();
	});
});

function createTempVault(): string {
	const directoryPath = mkdtempSync(join(tmpdir(), "obsearch-cli-test-"));
	tempDirectories.push(directoryPath);
	return directoryPath;
}

function createMockDb() {
	return {
		close: () => {},
		getItemMetadataByPath: () => null,
		upsertItemWithEmbedding: () => 1,
	};
}
