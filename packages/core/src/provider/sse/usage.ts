/** Token counts retained from a Responses API usage object. */
export interface ResponseUsage {
	/** Input tokens excluding cached input; null when that subtraction is unknown. */
	readonly input: number | null;
	readonly cached_input: number | null;
	readonly cache_write: number | null;
	readonly output: number | null;
	readonly reasoning: number | null;
}

export class ResponseUsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResponseUsageError";
	}
}

/**
 * Parse the provider's raw usage fields without turning absent telemetry into
 * zero. Invalid, negative, fractional, unsafe or internally inconsistent
 * counts are rejected so assembly can classify the response as malformed.
 */
export function parseResponseUsage(value: unknown): ResponseUsage | null {
	if (value === null || value === undefined) return null;
	if (!isRecord(value)) throw new ResponseUsageError("usage must be an object");

	const inputTokens = readCount(value.input_tokens, "input_tokens");
	const outputTokens = readCount(value.output_tokens, "output_tokens");
	const inputDetails = readOptionalRecord(
		value.input_tokens_details,
		"input_tokens_details",
	);
	const outputDetails = readOptionalRecord(
		value.output_tokens_details,
		"output_tokens_details",
	);
	const cachedTokens = readCount(
		inputDetails?.cached_tokens,
		"input_tokens_details.cached_tokens",
	);
	const cacheWriteTokens = readCount(
		value.cache_write_tokens,
		"cache_write_tokens",
	);
	const reasoningTokens = readCount(
		outputDetails?.reasoning_tokens,
		"output_tokens_details.reasoning_tokens",
	);

	if (
		inputTokens !== null &&
		cachedTokens !== null &&
		cachedTokens > inputTokens
	) {
		throw new ResponseUsageError(
			"cached input tokens cannot exceed total input tokens",
		);
	}

	return {
		input:
			inputTokens !== null && cachedTokens !== null
				? inputTokens - cachedTokens
				: null,
		cached_input: cachedTokens,
		cache_write: cacheWriteTokens,
		output: outputTokens,
		reasoning: reasoningTokens,
	};
}

function readCount(value: unknown, field: string): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ResponseUsageError(
			`${field} must be a non-negative safe integer`,
		);
	}
	return value;
}

function readOptionalRecord(
	value: unknown,
	field: string,
): Record<string, unknown> | null {
	if (value === undefined || value === null) return null;
	if (!isRecord(value))
		throw new ResponseUsageError(`${field} must be an object`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
