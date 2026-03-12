import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CrawlVaultFile, VaultFileType } from "./crawler";
import type { CoreDb } from "./db";
import type { EmbedInput, EmbeddingClient } from "./embedding";
import { resolveImageMimeType, supportedImageExtensions } from "./file-types";
import { retryWithBackoff, type RetryOptions } from "./retry";

export interface IndexImageOptions {
	db: Pick<CoreDb, "upsertItemWithEmbedding">;
	embeddingClient: Pick<EmbeddingClient, "embedDocument">;
	vaultPath: string;
	imagePath: string;
	retry?: RetryOptions;
}

export interface IndexImageResult {
	itemId: number;
	path: string;
	mimeType: string;
	mtimeMs: number;
	sizeBytes: number;
}

export interface IndexMarkdownOptions {
	db: Pick<CoreDb, "upsertItemWithEmbedding">;
	embeddingClient: Pick<EmbeddingClient, "embedDocument">;
	vaultPath: string;
	markdownPath: string;
	retry?: RetryOptions;
}

export interface IndexMarkdownResult {
	itemId: number;
	path: string;
	mtimeMs: number;
	sizeBytes: number;
}

type IncrementalVaultFile = Pick<CrawlVaultFile, "path" | "type" | "size" | "mtime">;

export interface IndexVaultFileOptions {
	db: Pick<CoreDb, "getItemMetadataByPath" | "upsertItemWithEmbedding">;
	embeddingClient: Pick<EmbeddingClient, "embedDocument">;
	vaultPath: string;
	file: IncrementalVaultFile;
	retry?: RetryOptions;
}

export interface IndexVaultFileSkippedResult {
	status: "skipped";
	reason: "unchanged" | "unsupported_pdf";
	path: string;
	type: VaultFileType;
	mtimeMs: number;
	sizeBytes: number;
}

export type IndexVaultFileResult =
	| (IndexVaultFileSkippedResult & { type: "md" | "image" | "pdf" })
	| (IndexMarkdownResult & {
			status: "indexed";
			reason: "missing" | "changed";
			type: "md";
	  })
	| (IndexImageResult & {
			status: "indexed";
			reason: "missing" | "changed";
			type: "image";
	  });

export async function indexImage(
	options: IndexImageOptions,
): Promise<IndexImageResult> {
	assertIndexImageDependencies(options);

	const vaultPath = parseVaultPath(options.vaultPath);
	const realVaultPath = await resolveRealVaultPath(vaultPath);
	const absoluteImagePath = resolveAbsoluteImagePath(
		options.imagePath,
		vaultPath,
	);

	const mimeType = resolveImageMimeType(absoluteImagePath);
	if (!mimeType) {
		throw new Error(
			`Unsupported image extension for path "${options.imagePath}". Supported extensions: ${supportedImageExtensions.join(", ")}.`,
		);
	}

	const imageFile = Bun.file(absoluteImagePath);
	if (!(await imageFile.exists())) {
		throw new Error(`Image file does not exist: ${absoluteImagePath}`);
	}

	await assertImageInputHasNoSymlinks(vaultPath, absoluteImagePath);
	const realImagePath = await resolveRealImagePath(absoluteImagePath);
	const relativeImagePath = toVaultRelativePath(realVaultPath, realImagePath);

	const sizeBytes = parseFileSize(imageFile.size, absoluteImagePath);
	const mtimeMs = parseFileMtime(imageFile.lastModified, absoluteImagePath);
	const data = await toBase64(absoluteImagePath, imageFile);
	const embedInput: EmbedInput = {
		type: "parts",
		parts: [
			{
				inlineData: {
					mimeType,
					data,
				},
			},
		],
	};
	const embedding = await retryWithBackoff(
		() => options.embeddingClient.embedDocument(embedInput),
		{
			...options.retry,
			operationName:
				options.retry?.operationName ??
				`embed image "${relativeImagePath}" for indexing`,
		},
	);

	const itemId = options.db.upsertItemWithEmbedding({
		path: relativeImagePath,
		kind: "image",
		mtimeMs,
		sizeBytes,
		embedding,
	});

	return {
		itemId,
		path: relativeImagePath,
		mimeType,
		mtimeMs,
		sizeBytes,
	};
}

export async function indexMarkdown(
	options: IndexMarkdownOptions,
): Promise<IndexMarkdownResult> {
	assertIndexMarkdownDependencies(options);

	const vaultPath = parseMarkdownVaultPath(options.vaultPath);
	const realVaultPath = await resolveRealVaultPath(vaultPath);
	const absoluteMarkdownPath = resolveAbsoluteMarkdownPath(
		options.markdownPath,
		vaultPath,
	);

	const markdownExtension = extname(absoluteMarkdownPath).toLowerCase();
	if (markdownExtension !== ".md") {
		throw new Error(
			`Unsupported markdown extension for path "${options.markdownPath}". Supported extensions: .md.`,
		);
	}

	const markdownFile = Bun.file(absoluteMarkdownPath);
	if (!(await markdownFile.exists())) {
		throw new Error(`Markdown file does not exist: ${absoluteMarkdownPath}`);
	}

	await assertMarkdownInputHasNoSymlinks(vaultPath, absoluteMarkdownPath);
	const realMarkdownPath = await resolveRealMarkdownPath(absoluteMarkdownPath);
	const relativeMarkdownPath = toVaultRelativeMarkdownPath(
		realVaultPath,
		realMarkdownPath,
	);

	const markdownText = await markdownFile.text();
	if (markdownText.trim().length === 0) {
		throw new Error(`Markdown file is empty: ${absoluteMarkdownPath}`);
	}

	const sizeBytes = parseMarkdownFileSize(
		markdownFile.size,
		absoluteMarkdownPath,
	);
	const mtimeMs = parseMarkdownFileMtime(
		markdownFile.lastModified,
		absoluteMarkdownPath,
	);
	const embedding = await retryWithBackoff(
		() => options.embeddingClient.embedDocument(markdownText),
		{
			...options.retry,
			operationName:
				options.retry?.operationName ??
				`embed markdown "${relativeMarkdownPath}" for indexing`,
		},
	);

	const itemId = options.db.upsertItemWithEmbedding({
		path: relativeMarkdownPath,
		kind: "md",
		mtimeMs,
		sizeBytes,
		embedding,
	});

	return {
		itemId,
		path: relativeMarkdownPath,
		mtimeMs,
		sizeBytes,
	};
}

export async function indexVaultFile(
	options: IndexVaultFileOptions,
): Promise<IndexVaultFileResult> {
	assertIndexVaultFileDependencies(options);
	const file = parseIncrementalVaultFile(options.file);
	const existing = options.db.getItemMetadataByPath(file.path);

	if (
		existing &&
		existing.mtimeMs === file.mtimeMs &&
		existing.sizeBytes === file.sizeBytes
	) {
		return {
			status: "skipped",
			reason: "unchanged",
			path: file.path,
			type: file.type,
			mtimeMs: file.mtimeMs,
			sizeBytes: file.sizeBytes,
		};
	}

	if (file.type === "pdf") {
		return {
			status: "skipped",
			reason: "unsupported_pdf",
			path: file.path,
			type: "pdf",
			mtimeMs: file.mtimeMs,
			sizeBytes: file.sizeBytes,
		};
	}

	const reason: "missing" | "changed" = existing ? "changed" : "missing";
	if (file.type === "image") {
		const indexedImage = await indexImage({
			db: options.db,
			embeddingClient: options.embeddingClient,
			vaultPath: options.vaultPath,
			imagePath: file.path,
			retry: options.retry,
		});

		return {
			...indexedImage,
			status: "indexed",
			reason,
			type: "image",
		};
	}

	if (file.type === "md") {
		const indexedMarkdown = await indexMarkdown({
			db: options.db,
			embeddingClient: options.embeddingClient,
			vaultPath: options.vaultPath,
			markdownPath: file.path,
			retry: options.retry,
		});

		return {
			...indexedMarkdown,
			status: "indexed",
			reason,
			type: "md",
		};
	}

	throw new Error(`Unexpected file type in indexVaultFile: ${file.type}`);
}

function assertIndexImageDependencies(options: IndexImageOptions): void {
	if (!options || typeof options !== "object") {
		throw new Error("indexImage requires options.");
	}

	if (!options.db || typeof options.db.upsertItemWithEmbedding !== "function") {
		throw new Error(
			"indexImage requires a db with upsertItemWithEmbedding(...).",
		);
	}

	if (
		!options.embeddingClient ||
		typeof options.embeddingClient.embedDocument !== "function"
	) {
		throw new Error(
			"indexImage requires an embeddingClient with embedDocument(...).",
		);
	}
}

function assertIndexMarkdownDependencies(options: IndexMarkdownOptions): void {
	if (!options || typeof options !== "object") {
		throw new Error("indexMarkdown requires options.");
	}

	if (!options.db || typeof options.db.upsertItemWithEmbedding !== "function") {
		throw new Error(
			"indexMarkdown requires a db with upsertItemWithEmbedding(...).",
		);
	}

	if (
		!options.embeddingClient ||
		typeof options.embeddingClient.embedDocument !== "function"
	) {
		throw new Error(
			"indexMarkdown requires an embeddingClient with embedDocument(...).",
		);
	}
}

function assertIndexVaultFileDependencies(options: IndexVaultFileOptions): void {
	if (!options || typeof options !== "object") {
		throw new Error("indexVaultFile requires options.");
	}

	if (
		!options.db ||
		typeof options.db.upsertItemWithEmbedding !== "function" ||
		typeof options.db.getItemMetadataByPath !== "function"
	) {
		throw new Error(
			"indexVaultFile requires a db with getItemMetadataByPath(...) and upsertItemWithEmbedding(...).",
		);
	}

	if (
		!options.embeddingClient ||
		typeof options.embeddingClient.embedDocument !== "function"
	) {
		throw new Error(
			"indexVaultFile requires an embeddingClient with embedDocument(...).",
		);
	}
}

function parseIncrementalVaultFile(file: IncrementalVaultFile): {
	path: string;
	type: VaultFileType;
	mtimeMs: number;
	sizeBytes: number;
} {
	if (!file || typeof file !== "object") {
		throw new Error("indexVaultFile requires file metadata.");
	}

	if (typeof file.path !== "string") {
		throw new Error("indexVaultFile requires file.path to be a string.");
	}

	const path = file.path.trim();
	if (path.length === 0) {
		throw new Error("indexVaultFile requires a non-empty file.path.");
	}

	if (file.type !== "md" && file.type !== "image" && file.type !== "pdf") {
		throw new Error(
			`indexVaultFile requires file.type to be one of: md, image, pdf. Received: ${String(file.type)}`,
		);
	}

	return {
		path,
		type: file.type,
		mtimeMs: parseIncrementalFileMtime(file.mtime, path),
		sizeBytes: parseIncrementalFileSize(file.size, path),
	};
}

function parseVaultPath(vaultPath: string): string {
	if (typeof vaultPath !== "string") {
		throw new Error("indexImage requires vaultPath to be a string.");
	}

	const trimmedPath = vaultPath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("indexImage requires a non-empty vaultPath.");
	}

	return resolve(trimmedPath);
}

function parseMarkdownVaultPath(vaultPath: string): string {
	if (typeof vaultPath !== "string") {
		throw new Error("indexMarkdown requires vaultPath to be a string.");
	}

	const trimmedPath = vaultPath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("indexMarkdown requires a non-empty vaultPath.");
	}

	return resolve(trimmedPath);
}

function resolveAbsoluteImagePath(
	imagePath: string,
	vaultPath: string,
): string {
	if (typeof imagePath !== "string") {
		throw new Error("indexImage requires imagePath to be a string.");
	}

	const trimmedPath = imagePath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("indexImage requires a non-empty imagePath.");
	}

	return isAbsolute(trimmedPath)
		? resolve(trimmedPath)
		: resolve(vaultPath, trimmedPath);
}

function resolveAbsoluteMarkdownPath(
	markdownPath: string,
	vaultPath: string,
): string {
	if (typeof markdownPath !== "string") {
		throw new Error("indexMarkdown requires markdownPath to be a string.");
	}

	const trimmedPath = markdownPath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("indexMarkdown requires a non-empty markdownPath.");
	}

	return isAbsolute(trimmedPath)
		? resolve(trimmedPath)
		: resolve(vaultPath, trimmedPath);
}

function toVaultRelativePath(
	vaultPath: string,
	absoluteImagePath: string,
): string {
	const relativePath = relative(vaultPath, absoluteImagePath);
	if (relativePath.length === 0) {
		throw new Error(
			`Image path resolves to the vault root instead of a file: ${absoluteImagePath}`,
		);
	}

	if (isOutsideVaultRelativePath(relativePath) || isAbsolute(relativePath)) {
		throw new Error(
			`Image path must be inside the vault. Vault: ${vaultPath}, image: ${absoluteImagePath}`,
		);
	}

	return toPosixPath(relativePath);
}

function toVaultRelativeMarkdownPath(
	vaultPath: string,
	absoluteMarkdownPath: string,
): string {
	const relativePath = relative(vaultPath, absoluteMarkdownPath);
	if (relativePath.length === 0) {
		throw new Error(
			`Markdown path resolves to the vault root instead of a file: ${absoluteMarkdownPath}`,
		);
	}

	if (isOutsideVaultRelativePath(relativePath) || isAbsolute(relativePath)) {
		throw new Error(
			`Markdown path must be inside the vault. Vault: ${vaultPath}, markdown: ${absoluteMarkdownPath}`,
		);
	}

	return toPosixPath(relativePath);
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function isOutsideVaultRelativePath(path: string): boolean {
	return path === ".." || path.startsWith(`..${sep}`);
}

function parseFileSize(size: number, imagePath: string): number {
	if (!Number.isFinite(size) || size < 0) {
		throw new Error(`Invalid file size for image: ${imagePath}`);
	}

	return Math.trunc(size);
}

function parseFileMtime(mtime: number, imagePath: string): number {
	if (!Number.isFinite(mtime) || mtime < 0) {
		throw new Error(`Invalid file mtime for image: ${imagePath}`);
	}

	return Math.trunc(mtime);
}

function parseMarkdownFileSize(size: number, markdownPath: string): number {
	if (!Number.isFinite(size) || size < 0) {
		throw new Error(`Invalid file size for markdown: ${markdownPath}`);
	}

	return Math.trunc(size);
}

function parseMarkdownFileMtime(mtime: number, markdownPath: string): number {
	if (!Number.isFinite(mtime) || mtime < 0) {
		throw new Error(`Invalid file mtime for markdown: ${markdownPath}`);
	}

	return Math.trunc(mtime);
}

function parseIncrementalFileSize(size: number, path: string): number {
	if (!Number.isFinite(size) || size < 0) {
		throw new Error(`Invalid file size in incremental metadata: ${path}`);
	}

	return Math.trunc(size);
}

function parseIncrementalFileMtime(mtime: number, path: string): number {
	if (!Number.isFinite(mtime) || mtime < 0) {
		throw new Error(`Invalid file mtime in incremental metadata: ${path}`);
	}

	return Math.trunc(mtime);
}

async function resolveRealVaultPath(vaultPath: string): Promise<string> {
	try {
		return await realpath(vaultPath);
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			throw new Error(`Vault path does not exist: ${vaultPath}`);
		}

		throw error;
	}
}

async function resolveRealMarkdownPath(markdownPath: string): Promise<string> {
	try {
		return await realpath(markdownPath);
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			throw new Error(`Markdown file does not exist: ${markdownPath}`);
		}

		throw error;
	}
}

async function resolveRealImagePath(imagePath: string): Promise<string> {
	try {
		return await realpath(imagePath);
	} catch (error) {
		if (isNodeErrorWithCode(error, "ENOENT")) {
			throw new Error(`Image file does not exist: ${imagePath}`);
		}

		throw error;
	}
}

async function assertImageInputHasNoSymlinks(
	vaultPath: string,
	absoluteImagePath: string,
): Promise<void> {
	const relativeImagePath = relative(vaultPath, absoluteImagePath);
	if (
		relativeImagePath.length === 0 ||
		isOutsideVaultRelativePath(relativeImagePath) ||
		isAbsolute(relativeImagePath)
	) {
		return;
	}

	const pathSegments = relativeImagePath
		.split(sep)
		.filter((segment) => segment.length > 0);
	let currentPath = vaultPath;
	for (const segment of pathSegments) {
		currentPath = resolve(currentPath, segment);

		const stats = await lstat(currentPath);
		if (stats.isSymbolicLink()) {
			throw new Error(`Image path cannot include symlinks: ${absoluteImagePath}`);
		}
	}
}

async function assertMarkdownInputHasNoSymlinks(
	vaultPath: string,
	absoluteMarkdownPath: string,
): Promise<void> {
	const relativeMarkdownPath = relative(vaultPath, absoluteMarkdownPath);
	if (
		relativeMarkdownPath.length === 0 ||
		isOutsideVaultRelativePath(relativeMarkdownPath) ||
		isAbsolute(relativeMarkdownPath)
	) {
		return;
	}

	const pathSegments = relativeMarkdownPath
		.split(sep)
		.filter((segment) => segment.length > 0);
	let currentPath = vaultPath;
	for (const segment of pathSegments) {
		currentPath = resolve(currentPath, segment);

		const stats = await lstat(currentPath);
		if (stats.isSymbolicLink()) {
			throw new Error(
				`Markdown path cannot include symlinks: ${absoluteMarkdownPath}`,
			);
		}
	}
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
	if (!error || typeof error !== "object") {
		return false;
	}

	return "code" in error && error.code === code;
}

async function toBase64(imagePath: string, imageFile: Blob): Promise<string> {
	const bytes = await imageFile.arrayBuffer();
	if (bytes.byteLength === 0) {
		throw new Error(`Image file is empty: ${imagePath}`);
	}

	const base64 = Buffer.from(bytes).toString("base64");
	if (base64.length === 0) {
		throw new Error(`Failed to encode image as base64: ${imagePath}`);
	}

	return base64;
}
