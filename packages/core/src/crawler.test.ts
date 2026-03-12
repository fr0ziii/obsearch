import { afterEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crawlVault } from "./crawler";

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

describe("crawlVault", () => {
	it("recursively scans supported files and returns deterministic metadata", async () => {
		const vaultPath = createTempVault();

		mkdirSync(join(vaultPath, "docs", "nested"), { recursive: true });
		mkdirSync(join(vaultPath, "images"), { recursive: true });
		mkdirSync(join(vaultPath, ".hidden"), { recursive: true });

		writeFileSync(join(vaultPath, "docs", "nested", "note.md"), "# note");
		writeFileSync(
			join(vaultPath, "docs", "nested", "paper.PDF"),
			"pdf-content",
		);
		writeFileSync(join(vaultPath, "images", "cover.JPG"), "img-content");
		writeFileSync(join(vaultPath, "images", "diagram.webp"), "img-content-2");
		writeFileSync(join(vaultPath, "images", "skip.txt"), "ignore");
		writeFileSync(join(vaultPath, ".hidden", "hidden.md"), "hidden");
		writeFileSync(join(vaultPath, ".hidden-note.md"), "hidden");

		const result = await crawlVault({ vaultPath });

		expect(result.errors).toHaveLength(0);
		expect(
			result.files.map((file) => ({ path: file.path, type: file.type })),
		).toEqual([
			{ path: "docs/nested/note.md", type: "md" },
			{ path: "docs/nested/paper.PDF", type: "pdf" },
			{ path: "images/cover.JPG", type: "image" },
			{ path: "images/diagram.webp", type: "image" },
		]);

		for (const file of result.files) {
			expect(file.size).toBeGreaterThan(0);
			expect(file.mtime).toBeGreaterThan(0);
		}
	});

	it("skips symlinked files and directories", async () => {
		const vaultPath = createTempVault();

		mkdirSync(join(vaultPath, "real", "nested"), { recursive: true });
		writeFileSync(join(vaultPath, "real", "note.md"), "real");
		writeFileSync(join(vaultPath, "real", "nested", "image.png"), "img");

		const fileSymlinkPath = join(vaultPath, "linked-note.md");
		const dirSymlinkPath = join(vaultPath, "linked-dir");

		try {
			symlinkSync(join(vaultPath, "real", "note.md"), fileSymlinkPath);
			symlinkSync(join(vaultPath, "real", "nested"), dirSymlinkPath);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "EPERM"
			) {
				return;
			}

			throw error;
		}

		const result = await crawlVault({ vaultPath });
		expect(result.errors).toHaveLength(0);
		expect(result.files.map((file) => file.path)).toEqual([
			"real/nested/image.png",
			"real/note.md",
		]);
	});

	it("continues scanning and reports read errors", async () => {
		const vaultPath = createTempVault();

		writeFileSync(join(vaultPath, "root-note.md"), "ok");
		const lockedDirectoryPath = join(vaultPath, "locked");
		mkdirSync(lockedDirectoryPath, { recursive: true });
		writeFileSync(join(lockedDirectoryPath, "secret.md"), "secret");

		let result: Awaited<ReturnType<typeof crawlVault>>;
		try {
			chmodSync(lockedDirectoryPath, 0o000);
			result = await crawlVault({ vaultPath });
		} finally {
			chmodSync(lockedDirectoryPath, 0o755);
		}

		expect(result.files.map((file) => file.path)).toEqual(["root-note.md"]);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors.some((error) => error.path === "locked")).toBeTrue();
	});

	it("throws on invalid vault paths", async () => {
		const vaultPath = createTempVault();
		const notDirectoryPath = join(vaultPath, "single.md");
		writeFileSync(notDirectoryPath, "content");

		await expect(crawlVault({ vaultPath: "" })).rejects.toThrow(
			"crawlVault requires a non-empty vaultPath",
		);
		await expect(crawlVault({ vaultPath: notDirectoryPath })).rejects.toThrow(
			"Vault path must be a directory",
		);
	});
});

function createTempVault(): string {
	const directoryPath = mkdtempSync(join(tmpdir(), "obsearch-crawler-test-"));
	tempDirectories.push(directoryPath);
	return directoryPath;
}
