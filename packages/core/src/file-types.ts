import { extname } from "node:path";

const imageMimeTypeByExtension = {
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
} as const;

export type SupportedImageExtension = keyof typeof imageMimeTypeByExtension;

export const supportedImageExtensions = Object.freeze(
	Object.keys(imageMimeTypeByExtension),
) as readonly SupportedImageExtension[];

export function resolveImageMimeType(path: string): string | undefined {
	const extension = extname(path).toLowerCase() as SupportedImageExtension;
	return imageMimeTypeByExtension[extension];
}
