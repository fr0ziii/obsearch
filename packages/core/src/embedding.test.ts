import { describe, expect, it } from "bun:test";

import {
  createEmbeddingClient,
  type Embedder,
  type EmbedRequest,
} from "./embedding";

describe("createEmbeddingClient", () => {
  it("returns a Float32Array for valid responses", async () => {
    const embedder: Embedder = async () => ({
      embedding: { values: [0.1, 0.2, 0.3] },
    });

    const client = createEmbeddingClient({
      model: "gemini-embedding-2-preview",
      embedder,
    });

    const vector = await client.embedQuery("hello");
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector[0]).toBeCloseTo(0.1, 6);
    expect(vector[1]).toBeCloseTo(0.2, 6);
    expect(vector[2]).toBeCloseTo(0.3, 6);
  });

  it("uses RETRIEVAL_QUERY for query embeddings", async () => {
    const spy: { request: EmbedRequest | undefined } = { request: undefined };
    const embedder: Embedder = async (request) => {
      spy.request = request;
      return {
        embedding: { values: [0.1, 0.2, 0.3] },
      };
    };

    const client = createEmbeddingClient({
      model: "gemini-embedding-2-preview",
      embedder,
    });

    await client.embedQuery("architecture");

    const capturedRequest = spy.request;
    expect(capturedRequest).toBeDefined();
    if (!capturedRequest) {
      throw new Error("Expected embed request to be captured.");
    }
    expect(capturedRequest.taskType).toBe("RETRIEVAL_QUERY");
    expect(capturedRequest.contents).toBe("architecture");
    expect(capturedRequest.title).toBeUndefined();
  });

  it("uses RETRIEVAL_DOCUMENT and forwards title for document embeddings", async () => {
    const spy: { request: EmbedRequest | undefined } = { request: undefined };
    const embedder: Embedder = async (request) => {
      spy.request = request;
      return {
        embedding: { values: [0.1, 0.2, 0.3] },
      };
    };

    const client = createEmbeddingClient({
      model: "gemini-embedding-2-preview",
      embedder,
    });

    await client.embedDocument("System design notes", { title: "Architecture" });

    const capturedRequest = spy.request;
    expect(capturedRequest).toBeDefined();
    if (!capturedRequest) {
      throw new Error("Expected embed request to be captured.");
    }
    expect(capturedRequest.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(capturedRequest.contents).toBe("System design notes");
    expect(capturedRequest.title).toBe("Architecture");
  });

  it("throws when embedding values are missing", async () => {
    const embedder: Embedder = async () => ({});

    const client = createEmbeddingClient({
      model: "gemini-embedding-2-preview",
      embedder,
    });

    await expect(client.embedDocument("hello")).rejects.toThrow();
  });

  it("throws on embedding dimension mismatch", async () => {
    const embedder: Embedder = async () => ({
      embedding: { values: [1, 2] },
    });

    const client = createEmbeddingClient({
      model: "gemini-embedding-2-preview",
      expectedDimension: 3,
      embedder,
    });

    await expect(client.embedDocument("hello")).rejects.toThrow("Embedding dimension mismatch");
  });
});
