export {
	DEFAULT_GEMINI_EMBEDDING_MODEL,
	GEMINI_EMBEDDING_DIMENSION,
	resolveEmbeddingModel,
} from "./constants";
export {
	type CrawlVaultError,
	type CrawlVaultFile,
	type CrawlVaultOptions,
	type CrawlVaultResult,
	crawlVault,
	type VaultFileType,
} from "./crawler";
export {
	type CoreDb,
	type InitDbOptions,
	type ItemMetadataByPath,
	type ItemKind,
	initDb,
	itemKindSchema,
	type SearchResult,
	type UpsertEmbeddingInput,
	type UpsertItemInput,
	type UpsertItemWithEmbeddingInput,
} from "./db";
export {
	createEmbeddingClient,
	type EmbedDocumentOptions,
	type Embedder,
	type EmbeddingClient,
	type EmbeddingClientOptions,
	type EmbedInput,
	type EmbedPart,
	type EmbedRequest,
	type EmbedResponse,
	type GeminiTaskType,
} from "./embedding";
export {
	resolveImageMimeType,
	type SupportedImageExtension,
	supportedImageExtensions,
} from "./file-types";
export {
	type IndexImageOptions,
	type IndexImageResult,
	type IndexMarkdownOptions,
	type IndexMarkdownResult,
	type IndexVaultFileOptions,
	type IndexVaultFileResult,
	type IndexVaultFileSkippedResult,
	indexImage,
	indexMarkdown,
	indexVaultFile,
} from "./indexing";
export {
	type RetryOptions,
	type RetrySleep,
	RetryExhaustedError,
	isRetriableEmbeddingError,
	retryWithBackoff,
} from "./retry";
