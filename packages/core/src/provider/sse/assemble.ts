import type { SseFrame } from "./framing";
import { parseResponseUsage, type ResponseUsage } from "./usage";

export type ResponseFailureClass =
	| "usage_limit"
	| "overload"
	| "transport"
	| "incomplete"
	| "malformed";

export interface ResponseToolCall {
	/** The Responses API call_id, used to pair the later tool output. */
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface AssembledResponse {
	readonly ok: true;
	readonly id: string;
	readonly text: string;
	readonly tool_calls: readonly ResponseToolCall[];
	readonly usage: ResponseUsage | null;
	readonly raw_items: readonly unknown[];
	/** JSON source slices parallel to raw_items, retained for byte-stable history. */
	readonly raw_item_json: readonly string[];
}

export interface FailedResponseAssembly {
	readonly ok: false;
	readonly class: ResponseFailureClass;
	readonly message: string;
	readonly usage: ResponseUsage | null;
	/** Partial items are available for continuation and are never executable. */
	readonly raw_items: readonly unknown[];
	readonly raw_item_json: readonly string[];
}

export type ResponseAssembly = AssembledResponse | FailedResponseAssembly;

interface RawItem {
	readonly value: unknown;
	readonly json: string;
}

interface Completion {
	readonly value: Record<string, unknown>;
	readonly json: string;
}

interface Failure {
	readonly class: Exclude<ResponseFailureClass, "malformed">;
	readonly message: string;
}

/**
 * Assemble the frames from one Responses SSE body.
 *
 * Stream failures take precedence over malformed data, which takes
 * precedence over a missing completion. No items from any failed assembly
 * are returned as tool calls.
 */
export function assembleResponses(
	frames: readonly SseFrame[],
): ResponseAssembly {
	let completion: Completion | null = null;
	let failure: Failure | null = null;
	let malformed = false;
	let usage: ResponseUsage | null = null;
	let collectedItems: RawItem[] = [];
	let failureItems: RawItem[] | null = null;

	for (const frame of frames) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(frame.data) as unknown;
		} catch {
			malformed = true;
			continue;
		}
		if (!isRecord(parsed)) continue;

		const type = typeof parsed.type === "string" ? parsed.type : frame.event;
		const response = isRecord(parsed.response) ? parsed.response : undefined;

		if (type === "response.output_item.done") {
			const item = getRawProperty(frame.data, "item");
			if (
				!item ||
				!isRecord(item.value) ||
				!jsonValuesEqual(item.value, parsed.item)
			) {
				malformed = true;
			} else {
				collectedItems.push(item);
			}
		}

		if (type === "response.completed") {
			if (completion !== null) {
				malformed = true;
			} else if (!response) {
				malformed = true;
			} else {
				completion = { value: response, json: frame.data };
				trySetUsage(
					response.usage,
					(next) => {
						usage = next;
					},
					() => {
						malformed = true;
					},
				);
			}
		}

		if (type === "response.incomplete") {
			failure ??= {
				class: "incomplete",
				message: incompleteMessage(response),
			};
			if (response) {
				const partial = responseItems(frame.data, "response", response);
				if (partial.kind === "invalid") malformed = true;
				else if (partial.items.length > 0) {
					collectedItems = partial.items;
					failureItems = partial.items;
				}
				trySetUsage(
					response.usage,
					(next) => {
						usage = next;
					},
					() => {
						malformed = true;
					},
				);
			}
		}

		const hasError = parsed.error !== undefined && parsed.error !== null;
		if (type === "error" || type === "response.failed" || hasError) {
			failure ??= {
				class: classifyFailure(frame.data),
				message: failureMessage(frame.data),
			};
			if (response) {
				const partial = responseItems(frame.data, "response", response);
				if (partial.kind === "invalid") malformed = true;
				else if (partial.items.length > 0) {
					collectedItems = partial.items;
					failureItems = partial.items;
				}
				trySetUsage(
					response.usage,
					(next) => {
						usage = next;
					},
					() => {
						malformed = true;
					},
				);
			}
		}
	}

	if (failure) {
		const completionItems = completion ? getPartialItems(completion, []) : [];
		const partial =
			failureItems ??
			(completionItems.length > 0 ? completionItems : collectedItems);
		return failed(failure.class, failure.message, partial, usage);
	}
	if (malformed) {
		return failed(
			"malformed",
			"Malformed Responses stream.",
			getPartialItems(completion, collectedItems),
			usage,
		);
	}
	if (!completion) {
		return failed(
			"malformed",
			"Responses stream ended without a completed event.",
			collectedItems,
			null,
		);
	}

	const response = completion.value;
	if (
		response.status !== "completed" ||
		typeof response.id !== "string" ||
		response.id.length === 0
	) {
		return failed(
			"malformed",
			"Completed Responses event has an invalid status or id.",
			getPartialItems(completion, collectedItems),
			readUsageQuietly(response.usage),
		);
	}

	const completedItems = responseItems(completion.json, "response", response);
	if (completedItems.kind === "invalid") {
		return failed(
			"malformed",
			"Completed response output must be an array of items.",
			collectedItems,
			readUsageQuietly(response.usage),
		);
	}
	const rawItems =
		completedItems.items.length > 0 ? completedItems.items : collectedItems;

	let responseUsage: ResponseUsage | null;
	try {
		responseUsage = parseResponseUsage(response.usage);
	} catch (error) {
		return failed(
			"malformed",
			messageFrom(error, "Invalid Responses usage."),
			rawItems,
			null,
		);
	}

	const toolCalls: ResponseToolCall[] = [];
	const text: string[] = [];
	for (const rawItem of rawItems) {
		if (!isRecord(rawItem.value)) {
			return failed(
				"malformed",
				"Response output item must be an object.",
				rawItems,
				responseUsage,
			);
		}
		const item = rawItem.value;
		if (item.type === "message") {
			if (Array.isArray(item.content)) {
				for (const part of item.content) {
					if (
						isRecord(part) &&
						part.type === "output_text" &&
						typeof part.text === "string"
					) {
						text.push(part.text);
					}
				}
			}
		}
		if (item.type !== "function_call") continue;
		if (item.status !== undefined && item.status !== "completed") continue;

		const callId = item.call_id;
		const name = item.name;
		const args = parseFunctionArguments(item.arguments);
		if (
			typeof callId !== "string" ||
			callId.length === 0 ||
			typeof name !== "string" ||
			name.length === 0 ||
			!args
		) {
			return failed(
				"malformed",
				"Function call requires a call_id, name, and object arguments.",
				rawItems,
				responseUsage,
			);
		}
		toolCalls.push({ id: callId, name, arguments: args });
	}

	return {
		ok: true,
		id: response.id,
		text: text.join(""),
		tool_calls: toolCalls,
		usage: responseUsage,
		raw_items: rawItems.map((item) => item.value),
		raw_item_json: rawItems.map((item) => item.json),
	};
}

function failed(
	classification: ResponseFailureClass,
	message: string,
	items: readonly RawItem[],
	usage: ResponseUsage | null,
): FailedResponseAssembly {
	return {
		ok: false,
		class: classification,
		message,
		usage,
		raw_items: items.map((item) => item.value),
		raw_item_json: items.map((item) => item.json),
	};
}

function getPartialItems(
	completion: Completion | null,
	fallback: readonly RawItem[],
): readonly RawItem[] {
	if (!completion) return fallback;
	const responseItems = fromCompletion(completion);
	if (responseItems.kind === "items" && responseItems.items.length > 0)
		return responseItems.items;
	return fallback;
}

function responseItems(
	json: string,
	rootName: "response",
	response: Record<string, unknown>,
):
	| { readonly kind: "items"; readonly items: RawItem[] }
	| { readonly kind: "invalid" } {
	if (response.output === undefined) return { kind: "items", items: [] };
	if (!Array.isArray(response.output)) return { kind: "invalid" };
	const expectedOutput = response.output;
	const output = getRawPath(json, [rootName, "output"]);
	if (!output || output.kind !== "array") return { kind: "invalid" };
	if (
		output.items.length !== expectedOutput.length ||
		output.items.some(
			(item, index) => !jsonValuesEqual(item.value, expectedOutput[index]),
		)
	) {
		return { kind: "invalid" };
	}
	return { kind: "items", items: output.items };
}

function fromCompletion(
	completion: Completion,
):
	| { readonly kind: "items"; readonly items: RawItem[] }
	| { readonly kind: "invalid" } {
	return responseItems(completion.json, "response", completion.value);
}

function getRawProperty(json: string, key: string): RawItem | null {
	const range = findPropertyRange(json, 0, key);
	if (!range) return null;
	try {
		return {
			value: JSON.parse(json.slice(range.start, range.end)) as unknown,
			json: json.slice(range.start, range.end),
		};
	} catch {
		return null;
	}
}

function getRawPath(
	json: string,
	path: readonly string[],
): { readonly kind: "array"; readonly items: RawItem[] } | null {
	let current = { start: 0, end: json.length };
	for (const key of path) {
		const range = findPropertyRange(json, current.start, key, current.end);
		if (!range) return null;
		current = range;
	}
	if (json[current.start] !== "[") return null;
	const ranges = arrayValueRanges(json, current.start, current.end);
	if (!ranges) return null;
	const items: RawItem[] = [];
	for (const range of ranges) {
		const source = json.slice(range.start, range.end);
		try {
			items.push({ value: JSON.parse(source) as unknown, json: source });
		} catch {
			return null;
		}
	}
	return { kind: "array", items };
}

function findPropertyRange(
	source: string,
	objectStart: number,
	key: string,
	objectEnd = source.length,
): { readonly start: number; readonly end: number } | null {
	if (source[objectStart] !== "{" || objectStart >= objectEnd) return null;
	let index = objectStart + 1;
	while (index < objectEnd) {
		index = skipWhitespace(source, index);
		if (source[index] === "}") return null;
		if (source[index] !== '"') return null;
		const keyEnd = quotedStringEnd(source, index);
		if (keyEnd === null) return null;
		let parsedKey: unknown;
		try {
			parsedKey = JSON.parse(source.slice(index, keyEnd)) as unknown;
		} catch {
			return null;
		}
		index = skipWhitespace(source, keyEnd);
		if (source[index] !== ":") return null;
		const start = skipWhitespace(source, index + 1);
		const end = jsonValueEnd(source, start, objectEnd);
		if (end === null) return null;
		if (parsedKey === key) return { start, end };
		index = skipWhitespace(source, end);
		if (source[index] === "}") return null;
		if (source[index] !== ",") return null;
		index++;
	}
	return null;
}

function arrayValueRanges(
	source: string,
	arrayStart: number,
	arrayEnd: number,
): { readonly start: number; readonly end: number }[] | null {
	if (source[arrayStart] !== "[") return null;
	const ranges: { start: number; end: number }[] = [];
	let index = skipWhitespace(source, arrayStart + 1);
	if (source[index] === "]") return ranges;
	while (index < arrayEnd) {
		const start = index;
		const end = jsonValueEnd(source, start, arrayEnd);
		if (end === null) return null;
		ranges.push({ start, end });
		index = skipWhitespace(source, end);
		if (source[index] === "]") return ranges;
		if (source[index] !== ",") return null;
		index = skipWhitespace(source, index + 1);
	}
	return null;
}

function jsonValueEnd(
	source: string,
	start: number,
	limit: number,
): number | null {
	const first = source[start];
	if (first === '"') return quotedStringEnd(source, start);
	if (first !== "{" && first !== "[") {
		let index = start;
		while (index < limit && !/[\s,\]}]/u.test(source[index] ?? "")) index++;
		return index > start ? index : null;
	}
	const stack: string[] = [first === "{" ? "}" : "]"];
	let inString = false;
	let escaped = false;
	for (let index = start + 1; index < limit; index++) {
		const character = source[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{") stack.push("}");
		else if (character === "[") stack.push("]");
		else if (character === "}" || character === "]") {
			if (stack.pop() !== character) return null;
			if (stack.length === 0) return index + 1;
		}
	}
	return null;
}

function quotedStringEnd(source: string, start: number): number | null {
	let escaped = false;
	for (let index = start + 1; index < source.length; index++) {
		const character = source[index];
		if (escaped) escaped = false;
		else if (character === "\\") escaped = true;
		else if (character === '"') return index + 1;
	}
	return null;
}

function skipWhitespace(source: string, start: number): number {
	let index = start;
	while (index < source.length && /\s/u.test(source[index] ?? "")) index++;
	return index;
}

function trySetUsage(
	usageValue: unknown,
	set: (usage: ResponseUsage | null) => void,
	invalid: () => void,
): void {
	try {
		set(parseResponseUsage(usageValue));
	} catch {
		invalid();
	}
}

function readUsageQuietly(value: unknown): ResponseUsage | null {
	try {
		return parseResponseUsage(value);
	} catch {
		return null;
	}
}

function parseFunctionArguments(
	value: unknown,
): Record<string, unknown> | null {
	let parsed = value;
	if (typeof value === "string") {
		try {
			parsed = JSON.parse(value) as unknown;
		} catch {
			return null;
		}
	}
	return isRecord(parsed) ? parsed : null;
}

function classifyFailure(
	source: string,
): Exclude<ResponseFailureClass, "incomplete" | "malformed"> {
	const value = source.toLowerCase();
	if (
		["usage_limit", "usage limit", "rate_limit", "rate limit"].some((word) =>
			value.includes(word),
		)
	)
		return "usage_limit";
	if (value.includes("overload")) return "overload";
	return "transport";
}

function failureMessage(source: string): string {
	try {
		const parsed: unknown = JSON.parse(source);
		if (
			isRecord(parsed) &&
			isRecord(parsed.error) &&
			typeof parsed.error.message === "string"
		)
			return parsed.error.message;
	} catch {
		// The frame is already known to be valid JSON here; use a safe fallback.
	}
	return "Provider response reported an error.";
}

function incompleteMessage(
	response: Record<string, unknown> | undefined,
): string {
	const details =
		response && isRecord(response.incomplete_details)
			? response.incomplete_details
			: null;
	const reason =
		details && typeof details.reason === "string" ? details.reason : "unknown";
	return `Model response incomplete (${reason}); no tool calls were executed.`;
}

function messageFrom(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
