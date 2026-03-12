import { describe, expect, it } from "bun:test";

import {
	RetryExhaustedError,
	isRetriableEmbeddingError,
	retryWithBackoff,
} from "./retry";

describe("isRetriableEmbeddingError", () => {
	it("returns true for 429 and 5xx status errors", () => {
		expect(isRetriableEmbeddingError(createHttpError(429, "rate limit"))).toBe(
			true,
		);
		expect(
			isRetriableEmbeddingError(createHttpError(503, "service unavailable")),
		).toBe(true);
	});

	it("returns false for non-retriable 4xx status errors", () => {
		expect(isRetriableEmbeddingError(createHttpError(400, "bad request"))).toBe(
			false,
		);
		expect(
			isRetriableEmbeddingError(createHttpError(401, "invalid credentials")),
		).toBe(false);
	});
});

describe("retryWithBackoff", () => {
	it("returns success after transient failures", async () => {
		const delays: number[] = [];
		let attempts = 0;

		const result = await retryWithBackoff(
			async () => {
				attempts += 1;
				if (attempts < 3) {
					throw createHttpError(429, "rate limited");
				}
				return "ok";
			},
			{
				maxAttempts: 3,
				initialDelayMs: 10,
				backoffMultiplier: 2,
				maxDelayMs: 1000,
				jitterRatio: 0,
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe("ok");
		expect(attempts).toBe(3);
		expect(delays).toEqual([10, 20]);
	});

	it("throws RetryExhaustedError after max attempts for retriable errors", async () => {
		const delays: number[] = [];
		let attempts = 0;

		await expect(
			retryWithBackoff(
				async () => {
					attempts += 1;
					throw createHttpError(503, "temporary outage");
				},
				{
					maxAttempts: 3,
					initialDelayMs: 5,
					backoffMultiplier: 2,
					maxDelayMs: 1000,
					jitterRatio: 0,
					operationName: "embed document",
					sleep: async (delayMs) => {
						delays.push(delayMs);
					},
				},
			),
		).rejects.toThrow(
			"Failed to embed document after 3 attempts due to retriable errors.",
		);

		expect(attempts).toBe(3);
		expect(delays).toEqual([5, 10]);

		try {
			await retryWithBackoff(
				async () => {
					throw createHttpError(503, "temporary outage");
				},
				{
					maxAttempts: 2,
					initialDelayMs: 1,
					jitterRatio: 0,
					sleep: async () => {},
				},
			);
			throw new Error("Expected retryWithBackoff to throw.");
		} catch (error) {
			expect(error).toBeInstanceOf(RetryExhaustedError);
			if (error instanceof RetryExhaustedError) {
				expect(error.attempts).toBe(2);
				expect(error.cause).toBeInstanceOf(Error);
			}
		}
	});

	it("does not retry non-retriable errors", async () => {
		const delays: number[] = [];
		let attempts = 0;
		const nonRetriableError = createHttpError(400, "invalid request payload");

		await expect(
			retryWithBackoff(
				async () => {
					attempts += 1;
					throw nonRetriableError;
				},
				{
					maxAttempts: 5,
					initialDelayMs: 10,
					jitterRatio: 0,
					sleep: async (delayMs) => {
						delays.push(delayMs);
					},
				},
			),
		).rejects.toBe(nonRetriableError);

		expect(attempts).toBe(1);
		expect(delays).toEqual([]);
	});

	it("uses exponential backoff progression with max delay cap", async () => {
		const delays: number[] = [];
		let attempts = 0;

		const result = await retryWithBackoff(
			async () => {
				attempts += 1;
				if (attempts < 4) {
					throw createHttpError(429, "rate limit");
				}
				return "done";
			},
			{
				maxAttempts: 4,
				initialDelayMs: 100,
				backoffMultiplier: 3,
				maxDelayMs: 500,
				jitterRatio: 0,
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe("done");
		expect(delays).toEqual([100, 300, 500]);
	});

	it("honors Retry-After header hints for 429 when larger than computed delay", async () => {
		const delays: number[] = [];
		let attempts = 0;

		const result = await retryWithBackoff(
			async () => {
				attempts += 1;
				if (attempts === 1) {
					throw createHttpErrorWithHeaders(429, "rate limited", {
						"retry-after": "3",
					});
				}

				return "ok";
			},
			{
				maxAttempts: 2,
				initialDelayMs: 100,
				backoffMultiplier: 2,
				jitterRatio: 0,
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe("ok");
		expect(delays).toEqual([3000]);
	});

	it("uses max of computed and hinted delay for 503 retry hints", async () => {
		const delays: number[] = [];
		let attempts = 0;

		const result = await retryWithBackoff(
			async () => {
				attempts += 1;
				if (attempts === 1) {
					throw createHttpErrorWithRetryAfterMs(
						503,
						"service unavailable",
						500,
					);
				}

				return "ok";
			},
			{
				maxAttempts: 2,
				initialDelayMs: 2000,
				backoffMultiplier: 2,
				jitterRatio: 0,
				sleep: async (delayMs) => {
					delays.push(delayMs);
				},
			},
		);

		expect(result).toBe("ok");
		expect(delays).toEqual([2000]);
	});
});

function createHttpError(status: number, message: string): Error & { status: number } {
	const error = new Error(message) as Error & { status: number };
	error.status = status;
	return error;
}

function createHttpErrorWithHeaders(
	status: number,
	message: string,
	headers: Record<string, string>,
): Error & { status: number; response: { headers: { get(name: string): string | null } } } {
	const error = createHttpError(status, message) as Error & {
		status: number;
		response: { headers: { get(name: string): string | null } };
	};
	error.response = {
		headers: {
			get(name: string): string | null {
				const value = headers[name.toLowerCase()];
				return value ?? null;
			},
		},
	};
	return error;
}

function createHttpErrorWithRetryAfterMs(
	status: number,
	message: string,
	retryAfterMs: number,
): Error & { status: number; retryAfterMs: number } {
	const error = createHttpError(status, message) as Error & {
		status: number;
		retryAfterMs: number;
	};
	error.retryAfterMs = retryAfterMs;
	return error;
}
