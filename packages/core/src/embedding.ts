import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { resolveEmbeddingModel } from "./constants";

const embeddingValuesSchema = z.array(z.number());

const embedPartsInputSchema = z.object({
  type: z.literal("parts"),
  parts: z.array(
    z.union([
      z.object({ text: z.string().min(1) }),
      z.object({
        inlineData: z.object({
          mimeType: z.string().min(1),
          data: z.string().min(1),
        }),
      }),
      z.object({
        fileData: z.object({
          mimeType: z.string().min(1),
          fileUri: z.string().min(1),
        }),
      }),
    ]),
  ),
});

export type EmbedPart = z.infer<typeof embedPartsInputSchema>["parts"][number];

export type EmbedInput =
  | string
  | {
      type: "text";
      text: string;
    }
  | {
      type: "parts";
      parts: EmbedPart[];
    };

export type GeminiTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface EmbedDocumentOptions {
  title?: string;
}

export interface EmbedRequest {
  model: string;
  taskType: GeminiTaskType;
  contents: string | Array<{ parts: EmbedPart[] }>;
  outputDimensionality?: number;
  title?: string;
}

export interface EmbedResponse {
  embedding?: {
    values?: number[] | Float32Array;
  };
}

export type Embedder = (request: EmbedRequest) => Promise<EmbedResponse>;

export interface EmbeddingClientOptions {
  apiKey?: string;
  model?: string;
  outputDimensionality?: number;
  expectedDimension?: number;
  embedder?: Embedder;
}

export interface EmbeddingClient {
  readonly model: string;
  embedDocument(input: EmbedInput, options?: EmbedDocumentOptions): Promise<Float32Array>;
  embedQuery(query: string): Promise<Float32Array>;
}

const positiveIntegerSchema = z.number().int().positive();

export function createEmbeddingClient(options: EmbeddingClientOptions = {}): EmbeddingClient {
  const model = resolveEmbeddingModel(options.model);
  const outputDimensionality =
    options.outputDimensionality === undefined
      ? undefined
      : positiveIntegerSchema.parse(options.outputDimensionality);
  const expectedDimension =
    options.expectedDimension === undefined
      ? undefined
      : positiveIntegerSchema.parse(options.expectedDimension);
  const embedder = options.embedder ?? createGoogleEmbedder(options.apiKey);
  const parseVector = (response: EmbedResponse): Float32Array => {
    const vector = parseEmbeddingValues(response);
    if (expectedDimension !== undefined && vector.length !== expectedDimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${expectedDimension}, got ${vector.length}.`,
      );
    }

    return vector;
  };

  return {
    model,
    async embedDocument(input: EmbedInput, options?: EmbedDocumentOptions): Promise<Float32Array> {
      const response = await embedder({
        model,
        taskType: "RETRIEVAL_DOCUMENT",
        contents: normalizeEmbedInput(input),
        outputDimensionality,
        title: normalizeOptionalTitle(options?.title),
      });

      return parseVector(response);
    },
    async embedQuery(query: string): Promise<Float32Array> {
      const response = await embedder({
        model,
        taskType: "RETRIEVAL_QUERY",
        contents: normalizeNonEmptyText(query, "Search query cannot be empty."),
        outputDimensionality,
      });

      return parseVector(response);
    },
  };
}

function createGoogleEmbedder(apiKeyOverride?: string): Embedder {
  const apiKey = resolveApiKey(apiKeyOverride);
  const client = new GoogleGenAI({ apiKey });

  return async (request: EmbedRequest): Promise<EmbedResponse> => {
    const config: {
      taskType: GeminiTaskType;
      outputDimensionality?: number;
      title?: string;
    } = {
      taskType: request.taskType,
    };
    if (request.outputDimensionality !== undefined) {
      config.outputDimensionality = request.outputDimensionality;
    }
    if (request.taskType === "RETRIEVAL_DOCUMENT" && request.title !== undefined) {
      config.title = request.title;
    }

    const response = await client.models.embedContent({
      model: request.model,
      contents: request.contents,
      config,
    });

    return {
      embedding: {
        values: response.embeddings?.[0]?.values,
      },
    };
  };
}

function resolveApiKey(apiKeyOverride?: string): string {
  const apiKey = apiKeyOverride ?? process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("GEMINI_API_KEY is required to create the Gemini embedding client.");
  }

  return apiKey.trim();
}

function normalizeEmbedInput(input: EmbedInput): string | Array<{ parts: EmbedPart[] }> {
  if (typeof input === "string") {
    return normalizeNonEmptyText(input, "Embed input text cannot be empty.");
  }

  if (input.type === "text") {
    return normalizeNonEmptyText(input.text, "Embed input text cannot be empty.");
  }

  const parsed = embedPartsInputSchema.parse(input);
  if (parsed.parts.length === 0) {
    throw new Error("Embed input parts cannot be empty.");
  }

  return [{ parts: parsed.parts }];
}

function normalizeOptionalTitle(title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }

  return normalizeNonEmptyText(title, "Embed document title cannot be empty.");
}

function normalizeNonEmptyText(value: string, errorMessage: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(errorMessage);
  }

  return trimmed;
}

function parseEmbeddingValues(response: EmbedResponse): Float32Array {
  const values = embeddingValuesSchema.parse(response.embedding?.values);
  if (values.length === 0) {
    throw new Error("Gemini embedContent returned an empty embedding vector.");
  }

  return Float32Array.from(values);
}
