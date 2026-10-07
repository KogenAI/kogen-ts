import { createHash } from "node:crypto";
import type { FileSystemPort } from "../../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../../fs/read";
import { redactSensitiveText } from "../../run/journal";
import type { AdditionalToolHandler } from "./dispatch";

export const DEFAULT_TOOL_RESULT_TOKENS = 2_000;
export const MIN_TOOL_RESULT_TOKENS = 128;
export const MAX_TOOL_RESULT_TOKENS = 100_000;
export const TOOL_RESULT_BYTES_PER_TOKEN = 4;
export const TOOL_RESULT_NOTICE_RESERVE_BYTES = 320;
export const TOOL_RESULT_LOG_PREFIX = "tool-result-";
export const TOOL_RESULT_LOG_SUFFIX = ".log";
export const TOOL_OUTPUT_UNKNOWN_HANDLE =
	"ERROR: Unknown or unavailable tool-output handle.";
export const TOOL_OUTPUT_STORAGE_ERROR =
	"ERROR: Tool output could not be stored safely.";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const HANDLE = /^[a-f0-9]{64}$/;

export interface ToolOutputContext {
	readonly runDirectory: string;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly toolResultTokens?: number;
}

function isValidUnicode(text: string): boolean {
	try {
		return decoder.decode(encoder.encode(text)) === text;
	} catch {
		return false;
	}
}

function bytesFromText(text: string): Uint8Array {
	if (!isValidUnicode(text))
		throw new TypeError("Tool output must be valid Unicode text.");
	return encoder.encode(text);
}

/** Converts raw process bytes using the provider contract's full-payload fallback. */
export function processOutputText(bytes: Uint8Array): string {
	try {
		return decoder.decode(bytes);
	} catch {
		return `[non-UTF-8 output, base64 encoded]\n${Buffer.from(bytes).toString("base64")}`;
	}
}

export function toolOutputHandle(text: string): string {
	return createHash("sha256").update(bytesFromText(text)).digest("hex");
}

function outputBudgetBytes(tokens: number | undefined): number {
	const effectiveTokens = tokens ?? DEFAULT_TOOL_RESULT_TOKENS;
	if (
		!Number.isSafeInteger(effectiveTokens) ||
		effectiveTokens < MIN_TOOL_RESULT_TOKENS ||
		effectiveTokens > MAX_TOOL_RESULT_TOKENS
	)
		throw new RangeError(
			`tool_result_tokens must be an integer from ${MIN_TOOL_RESULT_TOKENS} to ${MAX_TOOL_RESULT_TOKENS}`,
		);
	return effectiveTokens * TOOL_RESULT_BYTES_PER_TOKEN;
}

function isContinuationByte(byte: number | undefined): boolean {
	return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

function moveBoundaryForward(
	bytes: Uint8Array,
	index: number,
	end: number,
): number {
	let boundary = Math.max(0, Math.min(index, end));
	while (boundary < end && isContinuationByte(bytes[boundary])) boundary += 1;
	return boundary;
}

function moveBoundaryBackward(
	bytes: Uint8Array,
	index: number,
	start: number,
): number {
	let boundary = Math.max(start, Math.min(index, bytes.byteLength));
	while (boundary > start && isContinuationByte(bytes[boundary])) boundary -= 1;
	return boundary;
}

export interface ToolOutputByteRange {
	readonly start: number;
	readonly end: number;
}

/** Selects a zero-based UTF-8 byte range, moving both edges inward. */
export function selectUtf8ByteRange(
	bytes: Uint8Array,
	offset = 0,
	limit?: number,
): ToolOutputByteRange {
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new RangeError("output_offset must be a non-negative safe integer");
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
		throw new RangeError("output_limit must be a non-negative safe integer");
	const rawStart = Math.min(offset, bytes.byteLength);
	const rawEnd =
		limit === undefined
			? bytes.byteLength
			: rawStart + Math.min(limit, bytes.byteLength - rawStart);
	const start = moveBoundaryForward(bytes, rawStart, bytes.byteLength);
	const end = moveBoundaryBackward(bytes, rawEnd, start);
	return Object.freeze({ start: Math.min(start, end), end });
}

function renderRangeNotice(
	totalBytes: number,
	start: number,
	headEnd: number,
	tailStart: number,
	end: number,
	handle: string,
): string {
	return `\n[truncated/range: ${totalBytes} bytes; shown byte ranges ${start}-${headEnd},${tailStart}-${end}; retrieve with tool_output handle=${handle}, output_offset and output_limit]\n`;
}

function utf8Slice(bytes: Uint8Array, start: number, end: number): string {
	return decoder.decode(bytes.subarray(start, end));
}

/** Clips a selected source range while preserving UTF-8 and the exact cap. */
export function clipToolOutputRange(
	fullBytes: Uint8Array,
	range: ToolOutputByteRange,
	maxBytes: number,
	handle: string,
): string {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
		throw new RangeError("tool output byte budget must be positive");
	const { start, end } = range;
	if (end - start <= maxBytes) return utf8Slice(fullBytes, start, end);
	const initialContentBudget = Math.max(
		0,
		maxBytes - Math.min(TOOL_RESULT_NOTICE_RESERVE_BYTES, maxBytes),
	);
	let headEnd = moveBoundaryForward(
		fullBytes,
		start + Math.floor(initialContentBudget / 2),
		end,
	);
	let tailStart = moveBoundaryBackward(
		fullBytes,
		end - Math.ceil(initialContentBudget / 2),
		start,
	);
	for (let iteration = 0; iteration < 64; iteration += 1) {
		const notice = renderRangeNotice(
			fullBytes.byteLength,
			start,
			headEnd,
			tailStart,
			end,
			handle,
		);
		const noticeBytes = encoder.encode(notice).byteLength;
		if (noticeBytes >= maxBytes)
			throw new RangeError("tool output notice exceeds the configured budget");
		const available = maxBytes - noticeBytes;
		const headBudget = Math.floor(available / 2);
		const tailBudget = available - headBudget;
		const nextHeadEnd = moveBoundaryForward(
			fullBytes,
			Math.min(start + headBudget, end),
			end,
		);
		const nextTailStart = moveBoundaryBackward(
			fullBytes,
			Math.max(end - tailBudget, start),
			start,
		);
		if (nextHeadEnd === headEnd && nextTailStart === tailStart) break;
		headEnd = nextHeadEnd;
		tailStart = nextTailStart;
	}
	let finalNotice = renderRangeNotice(
		fullBytes.byteLength,
		start,
		headEnd,
		tailStart,
		end,
		handle,
	);
	let totalOutputBytes =
		headEnd - start + encoder.encode(finalNotice).byteLength + end - tailStart;
	while (totalOutputBytes > maxBytes) {
		if (headEnd - start >= end - tailStart) {
			headEnd = moveBoundaryBackward(fullBytes, headEnd - 1, start);
		} else {
			tailStart = moveBoundaryForward(fullBytes, tailStart + 1, end);
		}
		finalNotice = renderRangeNotice(
			fullBytes.byteLength,
			start,
			headEnd,
			tailStart,
			end,
			handle,
		);
		totalOutputBytes =
			headEnd -
			start +
			encoder.encode(finalNotice).byteLength +
			end -
			tailStart;
	}
	return `${utf8Slice(fullBytes, start, headEnd)}${finalNotice}${utf8Slice(fullBytes, tailStart, end)}`;
}

function logPath(handle: string): string {
	return `logs/${TOOL_RESULT_LOG_PREFIX}${handle}${TOOL_RESULT_LOG_SUFFIX}`;
}

/** Redacts, stores when clipping is required, and returns the model-visible result. */
export async function budgetToolOutput(
	context: ToolOutputContext,
	text: string,
): Promise<string> {
	const safeText = redactSensitiveText(text);
	const bytes = bytesFromText(safeText);
	const budget = outputBudgetBytes(context.toolResultTokens);
	if (bytes.byteLength <= budget) return safeText;
	const handle = toolOutputHandle(safeText);
	const stored = await context.filesystem.writeFileAtomically({
		root: context.runDirectory,
		path: logPath(handle),
		bytes,
		mode: 0o600,
	});
	if (!stored.ok) return TOOL_OUTPUT_STORAGE_ERROR;
	return clipToolOutputRange(
		bytes,
		{ start: 0, end: bytes.byteLength },
		budget,
		handle,
	);
}

/** Reads one safe byte range from a regular, digest-bound stored tool result. */
export async function readToolOutput(
	context: ToolOutputContext,
	argumentsValue: Readonly<Record<string, unknown>>,
): Promise<string> {
	const handle = argumentsValue.handle;
	if (typeof handle !== "string" || !HANDLE.test(handle))
		return TOOL_OUTPUT_UNKNOWN_HANDLE;
	const stored = await context.filesystem.readFile({
		root: context.runDirectory,
		path: logPath(handle),
		maxBytes: FILESYSTEM_MAX_RESPONSE_BYTES - 1,
	});
	if (!stored.ok) return TOOL_OUTPUT_UNKNOWN_HANDLE;
	let text: string;
	try {
		text = decoder.decode(stored.value);
	} catch {
		return TOOL_OUTPUT_UNKNOWN_HANDLE;
	}
	if (toolOutputHandle(text) !== handle) return TOOL_OUTPUT_UNKNOWN_HANDLE;
	const offset = argumentsValue.output_offset ?? 0;
	const limit = argumentsValue.output_limit;
	let range: ToolOutputByteRange;
	try {
		range = selectUtf8ByteRange(
			stored.value,
			offset as number,
			limit as number | undefined,
		);
	} catch {
		return "ERROR (invalid_arguments): Tool arguments do not match the schema.";
	}
	return clipToolOutputRange(
		stored.value,
		range,
		outputBudgetBytes(context.toolResultTokens),
		handle,
	);
}

export function createToolOutputHandler(
	context: ToolOutputContext,
): AdditionalToolHandler {
	return (argumentsValue) => readToolOutput(context, argumentsValue);
}
