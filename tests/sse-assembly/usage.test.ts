import { expect, test } from "bun:test";
import {
	parseResponseUsage,
	ResponseUsageError,
} from "../../packages/core/src/provider/sse/usage";

test("missing usage and missing fields stay nullable", () => {
	expect(parseResponseUsage(undefined)).toBeNull();
	expect(parseResponseUsage(null)).toBeNull();
	expect(parseResponseUsage({})).toEqual({
		input: null,
		cached_input: null,
		cache_write: null,
		output: null,
		reasoning: null,
	});
	expect(parseResponseUsage({ input_tokens: 9, output_tokens: 4 })).toEqual({
		input: null,
		cached_input: null,
		cache_write: null,
		output: 4,
		reasoning: null,
	});
});

test("uncached input is derived only when both input counts are known", () => {
	expect(
		parseResponseUsage({
			input_tokens: 50,
			input_tokens_details: { cached_tokens: 40 },
		}),
	).toEqual({
		input: 10,
		cached_input: 40,
		cache_write: null,
		output: null,
		reasoning: null,
	});
	expect(
		parseResponseUsage({
			input_tokens_details: { cached_tokens: 4 },
		}),
	).toEqual({
		input: null,
		cached_input: 4,
		cache_write: null,
		output: null,
		reasoning: null,
	});
});

test("rejects inconsistent, negative, fractional and unsafe counts", () => {
	const invalid = [
		{ input_tokens: 3, input_tokens_details: { cached_tokens: 4 } },
		{ input_tokens: -1 },
		{ output_tokens: 0.5 },
		{ cache_write_tokens: Number.MAX_SAFE_INTEGER + 1 },
		{ output_tokens_details: { reasoning_tokens: "2" } },
		{ input_tokens_details: [] },
		[],
	];
	for (const value of invalid) {
		expect(() => parseResponseUsage(value)).toThrow(ResponseUsageError);
	}
});
