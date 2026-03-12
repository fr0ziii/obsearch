export type RetrySleep = (delayMs: number) => Promise<void>;

export interface RetryOptions {
	maxAttempts?: number;
	initialDelayMs?: number;
	maxDelayMs?: number;
	backoffMultiplier?: number;
	jitterRatio?: number;
	operationName?: string;
	shouldRetry?: (error: unknown) => boolean;
	sleep?: RetrySleep;
	random?: () => number;
}

interface ResolvedRetryOptions {
	maxAttempts: number;
	initialDelayMs: number;
	maxDelayMs: number;
	backoffMultiplier: number;
	jitterRatio: number;
	operationName: string;
	shouldRetry: (error: unknown) => boolean;
	sleep: RetrySleep;
	random: () => number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_JITTER_RATIO = 0.1;

const transientNetworkCodes = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"ENOTFOUND",
	"EPIPE",
]);

const transientMessageSnippets = [
	"fetch failed",
	"network",
	"timeout",
	"timed out",
	"socket hang up",
	"connection reset",
	"connection refused",
	"connection aborted",
	"temporary failure",
	"temporarily unavailable",
	"service unavailable",
	"rate limit",
];

export class RetryExhaustedError extends Error {
	readonly attempts: number;
	readonly lastError: unknown;

	constructor(operationName: string, attempts: number, lastError: unknown) {
		super(
			`Failed to ${operationName} after ${attempts} attempts due to retriable errors.`,
			{ cause: lastError },
		);
		this.name = "RetryExhaustedError";
		this.attempts = attempts;
		this.lastError = lastError;
	}
}

export async function retryWithBackoff<T>(
	operation: () => Promise<T>,
	options: RetryOptions = {},
): Promise<T> {
	const resolvedOptions = resolveRetryOptions(options);

	for (let attempt = 1; attempt <= resolvedOptions.maxAttempts; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			const retriable = resolvedOptions.shouldRetry(error);
			const isFinalAttempt = attempt >= resolvedOptions.maxAttempts;

			if (!retriable) {
				throw error;
			}

			if (isFinalAttempt) {
				throw new RetryExhaustedError(
					resolvedOptions.operationName,
					resolvedOptions.maxAttempts,
					error,
				);
			}

			const retryIndex = attempt - 1;
			const computedDelayMs = computeBackoffDelayMs(retryIndex, resolvedOptions);
			const hintedDelayMs = computeServerHintDelayMs(error);
			const delayMs = Math.max(computedDelayMs, hintedDelayMs ?? 0);
			await resolvedOptions.sleep(delayMs);
		}
	}

	throw new Error("Unreachable retry state.");
}

export function isRetriableEmbeddingError(error: unknown): boolean {
	const status = extractHttpStatus(error);
	if (status !== undefined) {
		return status === 429 || (status >= 500 && status <= 599);
	}

	const code = extractStringCode(error);
	if (code !== undefined && transientNetworkCodes.has(code.toUpperCase())) {
		return true;
	}

	const message = extractErrorMessage(error);
	if (message === undefined) {
		return false;
	}

	const normalizedMessage = message.toLowerCase();
	return transientMessageSnippets.some((snippet) =>
		normalizedMessage.includes(snippet),
	);
}

function resolveRetryOptions(options: RetryOptions): ResolvedRetryOptions {
	const maxAttempts = validatePositiveInteger(
		options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		"maxAttempts",
	);
	const initialDelayMs = validateNonNegativeNumber(
		options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
		"initialDelayMs",
	);
	const maxDelayMs = validateNonNegativeNumber(
		options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
		"maxDelayMs",
	);
	const backoffMultiplier = validateMinimumNumber(
		options.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER,
		1,
		"backoffMultiplier",
	);
	const jitterRatio = validateRangeNumber(
		options.jitterRatio ?? DEFAULT_JITTER_RATIO,
		0,
		1,
		"jitterRatio",
	);

	return {
		maxAttempts,
		initialDelayMs,
		maxDelayMs,
		backoffMultiplier,
		jitterRatio,
		operationName: options.operationName?.trim() || "complete operation",
		shouldRetry: options.shouldRetry ?? isRetriableEmbeddingError,
		sleep: options.sleep ?? defaultSleep,
		random: options.random ?? Math.random,
	};
}

function computeBackoffDelayMs(
	retryIndex: number,
	options: ResolvedRetryOptions,
): number {
	const baseDelay = Math.min(
		options.maxDelayMs,
		Math.round(
			options.initialDelayMs *
				Math.pow(options.backoffMultiplier, Math.max(retryIndex, 0)),
		),
	);

	if (baseDelay === 0 || options.jitterRatio === 0) {
		return baseDelay;
	}

	const jitterSpan = baseDelay * options.jitterRatio;
	const jitterOffset = (options.random() * 2 - 1) * jitterSpan;
	return Math.max(0, Math.round(baseDelay + jitterOffset));
}

function defaultSleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, delayMs);
	});
}

function extractHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	const directStatus = asHttpStatus((error as Record<string, unknown>).status);
	if (directStatus !== undefined) {
		return directStatus;
	}

	const statusCode = asHttpStatus((error as Record<string, unknown>).statusCode);
	if (statusCode !== undefined) {
		return statusCode;
	}

	const numericCode = asHttpStatus((error as Record<string, unknown>).code);
	if (numericCode !== undefined) {
		return numericCode;
	}

	const response = (error as Record<string, unknown>).response;
	if (response && typeof response === "object") {
		const responseStatus = asHttpStatus(
			(response as Record<string, unknown>).status,
		);
		if (responseStatus !== undefined) {
			return responseStatus;
		}
	}

	const cause = (error as Record<string, unknown>).cause;
	if (cause !== undefined) {
		return extractHttpStatus(cause);
	}

	return undefined;
}

function extractStringCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	const directCode = (error as Record<string, unknown>).code;
	if (typeof directCode === "string") {
		return directCode;
	}

	const cause = (error as Record<string, unknown>).cause;
	if (cause !== undefined) {
		return extractStringCode(cause);
	}

	return undefined;
}

function extractErrorMessage(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.message;
	}

	if (!error || typeof error !== "object") {
		return undefined;
	}

	const message = (error as Record<string, unknown>).message;
	if (typeof message === "string") {
		return message;
	}

	const cause = (error as Record<string, unknown>).cause;
	if (cause !== undefined) {
		return extractErrorMessage(cause);
	}

	return undefined;
}

function computeServerHintDelayMs(error: unknown): number | undefined {
	const status = extractHttpStatus(error);
	if (status !== 429 && status !== 503) {
		return undefined;
	}

	return extractRetryAfterHintMs(error);
}

function extractRetryAfterHintMs(error: unknown): number | undefined {
	if (!error || typeof error !== "object") {
		return undefined;
	}

	const errorRecord = error as Record<string, unknown>;

	const directMsHint = firstDefined([
		parseMillisecondsValue(errorRecord.retryAfterMs),
		parseMillisecondsValue(errorRecord.retry_after_ms),
		parseSecondsValue(errorRecord.retryAfterSeconds),
		parseSecondsValue(errorRecord.retry_after_seconds),
		parseGenericRetryAfterValue(errorRecord.retryAfter),
		parseGenericRetryAfterValue(errorRecord.retry_after),
	]);
	if (directMsHint !== undefined) {
		return directMsHint;
	}

	const responseHint = extractRetryAfterHintFromResponse(errorRecord.response);
	if (responseHint !== undefined) {
		return responseHint;
	}

	const headersHint = extractRetryAfterHintFromHeaders(errorRecord.headers);
	if (headersHint !== undefined) {
		return headersHint;
	}

	return extractRetryAfterHintMs(errorRecord.cause);
}

function extractRetryAfterHintFromResponse(response: unknown): number | undefined {
	if (!response || typeof response !== "object") {
		return undefined;
	}

	const responseRecord = response as Record<string, unknown>;
	return firstDefined([
		extractRetryAfterHintFromHeaders(responseRecord.headers),
		parseMillisecondsValue(responseRecord.retryAfterMs),
		parseMillisecondsValue(responseRecord.retry_after_ms),
		parseSecondsValue(responseRecord.retryAfterSeconds),
		parseSecondsValue(responseRecord.retry_after_seconds),
		parseGenericRetryAfterValue(responseRecord.retryAfter),
		parseGenericRetryAfterValue(responseRecord.retry_after),
	]);
}

function extractRetryAfterHintFromHeaders(headers: unknown): number | undefined {
	if (!headers || typeof headers !== "object") {
		return undefined;
	}

	if ("get" in headers && typeof headers.get === "function") {
		const headersWithGet = headers as { get(name: string): unknown };
		return firstDefined([
			parseRetryAfterHeaderValue(headersWithGet.get("retry-after")),
			parseRetryAfterHeaderValue(headersWithGet.get("Retry-After")),
		]);
	}

	const headersRecord = headers as Record<string, unknown>;
	for (const [key, value] of Object.entries(headersRecord)) {
		if (key.toLowerCase() === "retry-after") {
			return parseRetryAfterHeaderValue(value);
		}
	}

	return undefined;
}

function parseRetryAfterHeaderValue(value: unknown): number | undefined {
	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	return parseRetryAfterHeaderString(trimmed);
}

function parseGenericRetryAfterValue(value: unknown): number | undefined {
	if (typeof value === "number") {
		return parseMillisecondsValue(value);
	}

	if (typeof value !== "string") {
		return undefined;
	}

	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	return parseRetryAfterHeaderString(trimmed);
}

function parseRetryAfterHeaderString(value: string): number | undefined {
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}

	const dateMs = Date.parse(value);
	if (!Number.isFinite(dateMs)) {
		return undefined;
	}

	const delayMs = dateMs - Date.now();
	if (delayMs < 0) {
		return 0;
	}

	return Math.round(delayMs);
}

function parseMillisecondsValue(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}

	return Math.round(value);
}

function parseSecondsValue(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}

	return Math.round(value * 1000);
}

function firstDefined(values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (value !== undefined) {
			return value;
		}
	}

	return undefined;
}

function asHttpStatus(value: unknown): number | undefined {
	if (typeof value !== "number") {
		return undefined;
	}

	if (!Number.isInteger(value) || value < 100 || value > 599) {
		return undefined;
	}

	return value;
}

function validatePositiveInteger(value: number, fieldName: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${fieldName} must be a positive integer.`);
	}

	return value;
}

function validateNonNegativeNumber(value: number, fieldName: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${fieldName} must be a non-negative number.`);
	}

	return value;
}

function validateMinimumNumber(
	value: number,
	minimum: number,
	fieldName: string,
): number {
	if (!Number.isFinite(value) || value < minimum) {
		throw new Error(`${fieldName} must be at least ${minimum}.`);
	}

	return value;
}

function validateRangeNumber(
	value: number,
	minimum: number,
	maximum: number,
	fieldName: string,
): number {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(
			`${fieldName} must be a number between ${minimum} and ${maximum}.`,
		);
	}

	return value;
}
