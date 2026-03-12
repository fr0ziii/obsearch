export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-2-preview";

/**
 * Default output dimension for gemini-embedding-2-preview.
 * Verified 2026-03-11 via live API call — the model returns 3072 dimensions
 * by default. Supported range: 128–3072 (configurable via outputDimensionality).
 * Recommended sizes: 768, 1536, 3072.
 */
export const GEMINI_EMBEDDING_DIMENSION = 3072;

export function resolveEmbeddingModel(explicitModel?: string): string {
  const model = explicitModel ?? process.env.GEMINI_EMBEDDING_MODEL;

  if (!model || model.trim().length === 0) {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }

  return model.trim();
}
