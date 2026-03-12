#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	type CrawlVaultResult,
	crawlVault,
	createEmbeddingClient,
	type EmbedDocumentOptions,
	type EmbedInput,
	GEMINI_EMBEDDING_DIMENSION,
	type IndexVaultFileOptions,
	type IndexVaultFileResult,
	indexVaultFile,
	initDb,
} from "@obsearch/core";

const COST_ENV_VAR = "OBSEARCH_ESTIMATED_USD_PER_EMBED_CALL";
const DEFAULT_USD_PER_EMBED_CALL = 0;
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;

const USAGE = [
	"Usage: obsearch index <vault-path>",
	"",
	"Commands:",
	"  index <vault-path>    Crawl vault files and index supported content.",
].join("\n");

export interface ParsedArgs {
	command: "index";
	vaultPath: string;
}

export type ParseArgsResult =
	| {
			ok: true;
			value: ParsedArgs;
	  }
	| {
			ok: false;
			error: string;
			usage: string;
	  };

export interface SummaryCounts {
	indexed: number;
	skipped: number;
	errors: number;
	embeddingCallCount: number;
	usdPerCall: number;
	durationMs: number;
}

interface RunCliDependencies {
	readonly env: Record<string, string | undefined>;
	readonly now: () => number;
	readonly info: (message: string) => void;
	readonly error: (message: string) => void;
	readonly coreApi?: CoreApi;
}

type IndexDb = Pick<
	ReturnType<typeof initDb>,
	"close" | "getItemMetadataByPath" | "upsertItemWithEmbedding"
>;

type IndexEmbeddingClient = Pick<
	ReturnType<typeof createEmbeddingClient>,
	"embedDocument"
>;

interface CoreApi {
	readonly crawlVault: (options: {
		vaultPath: string;
	}) => Promise<CrawlVaultResult>;
	readonly initDb: (options: {
		dbPath: string;
		embeddingDimension: number;
	}) => IndexDb;
	readonly createEmbeddingClient: (options: {
		expectedDimension: number;
		outputDimensionality: number;
	}) => IndexEmbeddingClient;
	readonly indexVaultFile: (
		options: Pick<IndexVaultFileOptions, "vaultPath" | "file"> & {
			db: IndexDb;
			embeddingClient: IndexEmbeddingClient;
		},
	) => Promise<IndexVaultFileResult>;
}

const defaultCoreApi: CoreApi = {
	crawlVault,
	initDb,
	createEmbeddingClient,
	indexVaultFile,
};

const defaultDependencies: RunCliDependencies = {
	env: process.env,
	now: Date.now,
	info: console.log,
	error: console.error,
};

export function parseArgs(args: readonly string[]): ParseArgsResult {
	if (args.length === 0) {
		return toUsageError("Missing command.");
	}

	const [command, vaultPath, ...restArgs] = args;
	if (command !== "index") {
		return toUsageError(`Unknown command: "${command}".`);
	}

	if (vaultPath === undefined) {
		return toUsageError("Missing required argument: <vault-path>.");
	}

	if (restArgs.length > 0) {
		return toUsageError(`Unexpected arguments: ${restArgs.join(" ")}`);
	}

	const normalizedVaultPath = vaultPath.trim();
	if (normalizedVaultPath.length === 0) {
		return toUsageError("Vault path cannot be empty.");
	}

	return {
		ok: true,
		value: {
			command,
			vaultPath,
		},
	};
}

export function resolveUsdPerCall(
	env: Record<string, string | undefined>,
): number {
	const rawValue = env[COST_ENV_VAR];
	if (rawValue === undefined || rawValue.trim().length === 0) {
		return DEFAULT_USD_PER_EMBED_CALL;
	}

	const value = Number(rawValue);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(
			`${COST_ENV_VAR} must be a non-negative number. Received "${rawValue}".`,
		);
	}

	return value;
}

export function estimateApiCostUsd(
	embeddingCallCount: number,
	usdPerCall: number,
): number {
	if (!Number.isInteger(embeddingCallCount) || embeddingCallCount < 0) {
		throw new Error(
			`embeddingCallCount must be a non-negative integer. Received ${embeddingCallCount}.`,
		);
	}

	if (!Number.isFinite(usdPerCall) || usdPerCall < 0) {
		throw new Error(
			`usdPerCall must be a non-negative number. Received ${usdPerCall}.`,
		);
	}

	return embeddingCallCount * usdPerCall;
}

export function determineExitCode(errorCount: number): number {
	if (!Number.isInteger(errorCount) || errorCount < 0) {
		throw new Error(
			`errorCount must be a non-negative integer. Received ${errorCount}.`,
		);
	}

	return errorCount > 0 ? FAILURE_EXIT_CODE : SUCCESS_EXIT_CODE;
}

export function formatSummaryLines(params: SummaryCounts): string[] {
	const estimatedUsd = estimateApiCostUsd(
		params.embeddingCallCount,
		params.usdPerCall,
	);

	return [
		"",
		"Summary",
		`  indexed: ${params.indexed}`,
		`  skipped: ${params.skipped}`,
		`  errors: ${params.errors}`,
		`  duration: ${(params.durationMs / 1000).toFixed(2)}s`,
		"",
		"API cost estimate (heuristic)",
		`  estimated cost: $${estimatedUsd.toFixed(6)} USD`,
		`  formula: ${params.embeddingCallCount} embedding call(s) x $${params.usdPerCall.toFixed(6)} per call`,
		`  env: ${COST_ENV_VAR} (default ${DEFAULT_USD_PER_EMBED_CALL})`,
		"  note: this is an estimate, not exact provider billing.",
	];
}

export async function runCli(
	args: readonly string[],
	deps: RunCliDependencies = defaultDependencies,
): Promise<number> {
	const parsed = parseArgs(args);
	if (!parsed.ok) {
		deps.error(parsed.error);
		deps.error(parsed.usage);
		return FAILURE_EXIT_CODE;
	}

	try {
		if (parsed.value.command === "index") {
			return await runIndexCommand(parsed.value.vaultPath, deps);
		}

		deps.error(`Unsupported command: ${parsed.value.command}`);
		return FAILURE_EXIT_CODE;
	} catch (error) {
		deps.error(`Fatal error: ${toErrorMessage(error)}`);
		return FAILURE_EXIT_CODE;
	}
}

async function runIndexCommand(
	vaultPathArg: string,
	deps: RunCliDependencies,
): Promise<number> {
	const coreApi = deps.coreApi ?? defaultCoreApi;
	const vaultPath = resolve(vaultPathArg);
	const dbPath = join(vaultPath, ".obsearch", "index.db");
	const startedAtMs = deps.now();
	const usdPerCall = resolveUsdPerCall(deps.env);

	await mkdir(dirname(dbPath), { recursive: true });

	deps.info(`Indexing vault: ${vaultPath}`);
	deps.info(`Database path: ${dbPath}`);

	let baseEmbeddingClient: IndexEmbeddingClient | undefined;

	let embeddingCallCount = 0;
	const meteredEmbeddingClient = {
		embedDocument: async (
			input: EmbedInput,
			options?: EmbedDocumentOptions,
		): Promise<Float32Array> => {
			if (!baseEmbeddingClient) {
				baseEmbeddingClient = coreApi.createEmbeddingClient({
					expectedDimension: GEMINI_EMBEDDING_DIMENSION,
					outputDimensionality: GEMINI_EMBEDDING_DIMENSION,
				});
			}
			embeddingCallCount += 1;
			return baseEmbeddingClient.embedDocument(input, options);
		},
	};

	const db = coreApi.initDb({
		dbPath,
		embeddingDimension: GEMINI_EMBEDDING_DIMENSION,
	});

	let indexed = 0;
	let skipped = 0;
	let errors = 0;

	try {
		const crawlResult = await coreApi.crawlVault({ vaultPath });
		deps.info(`Discovered ${crawlResult.files.length} supported file(s).`);

		if (crawlResult.errors.length > 0) {
			deps.error(
				`Crawler reported ${crawlResult.errors.length} file-level error(s):`,
			);
			for (const crawlError of crawlResult.errors) {
				deps.error(`  [crawl-error] ${crawlError.path}: ${crawlError.message}`);
			}
			errors += crawlResult.errors.length;
		}

		for (let index = 0; index < crawlResult.files.length; index += 1) {
			const file = crawlResult.files[index];
			if (!file) {
				throw new Error(`Missing crawled file at index ${index}.`);
			}
			const progress = `[${index + 1}/${crawlResult.files.length}]`;

			try {
				const result = await coreApi.indexVaultFile({
					db,
					embeddingClient: meteredEmbeddingClient,
					vaultPath,
					file: {
						path: file.path,
						type: file.type,
						size: file.size,
						mtime: file.mtime,
					},
				});

				if (result.status === "indexed") {
					indexed += 1;
					deps.info(`${progress} indexed (${result.reason}) ${result.path}`);
					continue;
				}

				skipped += 1;
				deps.info(`${progress} skipped (${result.reason}) ${result.path}`);
			} catch (error) {
				errors += 1;
				deps.error(`${progress} error ${file.path}: ${toErrorMessage(error)}`);
			}
		}
	} finally {
		db.close();
	}

	const summaryLines = formatSummaryLines({
		indexed,
		skipped,
		errors,
		embeddingCallCount,
		usdPerCall,
		durationMs: deps.now() - startedAtMs,
	});

	for (const line of summaryLines) {
		deps.info(line);
	}

	return determineExitCode(errors);
}

function toUsageError(error: string): ParseArgsResult {
	return {
		ok: false,
		error,
		usage: USAGE,
	};
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

if (import.meta.main) {
	const exitCode = await runCli(Bun.argv.slice(2));
	process.exitCode = exitCode;
}
