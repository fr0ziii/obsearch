import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

export type VaultFileType = "md" | "image" | "pdf";

export interface CrawlVaultFile {
	path: string;
	type: VaultFileType;
	size: number;
	mtime: number;
}

export interface CrawlVaultError {
	path: string;
	message: string;
}

export interface CrawlVaultOptions {
	vaultPath: string;
}

export interface CrawlVaultResult {
	files: CrawlVaultFile[];
	errors: CrawlVaultError[];
}

const extensionToType: Record<string, VaultFileType> = {
	".jpeg": "image",
	".jpg": "image",
	".md": "md",
	".pdf": "pdf",
	".png": "image",
	".webp": "image",
};

export async function crawlVault(
	options: CrawlVaultOptions,
): Promise<CrawlVaultResult> {
	const rootPath = parseVaultPath(options.vaultPath);
	await assertDirectory(rootPath);

	const files: CrawlVaultFile[] = [];
	const errors: CrawlVaultError[] = [];

	await walkDirectory({
		rootPath,
		directoryPath: rootPath,
		files,
		errors,
	});

	files.sort((a, b) => a.path.localeCompare(b.path));
	errors.sort((a, b) => {
		const pathComparison = a.path.localeCompare(b.path);
		if (pathComparison !== 0) {
			return pathComparison;
		}

		return a.message.localeCompare(b.message);
	});

	return { files, errors };
}

async function walkDirectory(params: {
	rootPath: string;
	directoryPath: string;
	files: CrawlVaultFile[];
	errors: CrawlVaultError[];
}): Promise<void> {
	const { rootPath, directoryPath, files, errors } = params;

	let entries: Dirent<string>[];
	try {
		entries = await readdir(directoryPath, {
			withFileTypes: true,
			encoding: "utf8",
		});
	} catch (error) {
		errors.push({
			path: toRelativePath(rootPath, directoryPath),
			message: toErrorMessage(error),
		});
		return;
	}

	for (const entry of entries) {
		if (isHidden(entry.name)) {
			continue;
		}

		const absolutePath = join(directoryPath, entry.name);

		if (entry.isSymbolicLink()) {
			continue;
		}

		if (entry.isDirectory()) {
			await walkDirectory({
				rootPath,
				directoryPath: absolutePath,
				files,
				errors,
			});
			continue;
		}

		if (!entry.isFile()) {
			continue;
		}

		const type = resolveVaultFileType(entry.name);
		if (!type) {
			continue;
		}

		try {
			const metadata = await readFileMetadata(absolutePath);
			files.push({
				path: toRelativePath(rootPath, absolutePath),
				type,
				size: metadata.size,
				mtime: metadata.mtime,
			});
		} catch (error) {
			errors.push({
				path: toRelativePath(rootPath, absolutePath),
				message: toErrorMessage(error),
			});
		}
	}
}

async function assertDirectory(path: string): Promise<void> {
	let stats: Awaited<ReturnType<typeof stat>>;
	try {
		stats = await stat(path);
	} catch (error) {
		throw new Error(
			`Vault path is not accessible: ${path}. ${toErrorMessage(error)}`,
		);
	}

	if (!stats.isDirectory()) {
		throw new Error(`Vault path must be a directory: ${path}`);
	}
}

function parseVaultPath(inputPath: string): string {
	const trimmedPath = inputPath.trim();
	if (trimmedPath.length === 0) {
		throw new Error("crawlVault requires a non-empty vaultPath.");
	}

	return resolve(trimmedPath);
}

function resolveVaultFileType(fileName: string): VaultFileType | undefined {
	const extension = extname(fileName).toLowerCase();
	return extensionToType[extension];
}

async function readFileMetadata(
	path: string,
): Promise<{ size: number; mtime: number }> {
	const file = Bun.file(path);
	const exists = await file.exists();
	if (!exists) {
		throw new Error(`File no longer exists: ${path}`);
	}

	const size = file.size;
	const mtime = file.lastModified;

	if (!Number.isFinite(size) || size < 0) {
		throw new Error(`Invalid file size for path: ${path}`);
	}

	if (!Number.isFinite(mtime) || mtime < 0) {
		throw new Error(`Invalid file mtime for path: ${path}`);
	}

	return {
		size,
		mtime,
	};
}

function toRelativePath(rootPath: string, absolutePath: string): string {
	const relativePath = relative(rootPath, absolutePath);
	if (relativePath.length === 0) {
		return ".";
	}

	if (relativePath.startsWith("..")) {
		return toPosixPath(absolutePath);
	}

	return toPosixPath(relativePath);
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function isHidden(name: string): boolean {
	return name.startsWith(".");
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
