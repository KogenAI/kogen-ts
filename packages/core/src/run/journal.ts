import { createHash } from "node:crypto";
import type { PortError, Result } from "../contracts/errors";
import { appendFileBytes } from "../fs/publish";
import {
	FILESYSTEM_MAX_RESPONSE_BYTES,
	type FileSystemHostRequest,
	readControllerFileBytes,
} from "../fs/read";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export interface JournalEvent {
	readonly event: string;
	readonly ts: number;
	readonly [key: string]: JsonValue;
}

export type TokenUsage = Readonly<{
	input: number | null;
	cached_input: number | null;
	cache_write: number | null;
	output: number | null;
	reasoning: number | null;
}>;

export interface RequestAttemptInput {
	readonly attempt_id: string;
	readonly stage: string;
	readonly rung: string | null;
	readonly provider: string;
	readonly adapter: string;
	readonly model: string;
	readonly effort: string;
	readonly endpoint_url: string;
	readonly header_names: readonly string[];
	readonly cache_key: string | null;
	readonly thread_id: string | null;
	readonly conversation_id: string | null;
	readonly request_bytes: number;
	readonly prefix_sha256: string | null;
	readonly started_ms: number;
	readonly ended_ms: number;
	readonly cut_after_ms: number | null;
	readonly resumed: boolean;
	readonly tokens: TokenUsage;
}

export interface RequestAttemptRecord {
	readonly kind: "request_attempt";
	readonly attempt_id: string;
	readonly stage: string;
	readonly rung: string | null;
	readonly provider: string;
	readonly adapter: string;
	readonly model: string;
	readonly effort: string;
	readonly endpoint: Readonly<{ host: string; path: string }>;
	readonly headers: readonly string[];
	readonly cache_key: string | null;
	readonly thread_id: string | null;
	readonly conversation_id: string | null;
	readonly request_bytes: number;
	readonly prefix_sha256: string | null;
	readonly started_ms: number;
	readonly ended_ms: number;
	readonly cut_after_ms: number | null;
	readonly resumed: boolean;
	readonly tokens: TokenUsage;
}

export type JournalWriteError = Readonly<{
	stage: "encode" | "append";
	error: PortError;
	appendState: "not_attempted" | "unknown";
}>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export const MAX_JOURNAL_ROW_BYTES = 256 * 1024;

function error(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: code === "io" || code === "unavailable" };
}

function validUnicode(value: string): boolean {
	try {
		return decoder.decode(encoder.encode(value)) === value;
	} catch {
		return false;
	}
}

function encodeRootPath(value: string): Uint8Array {
	const bytes = encoder.encode(value);
	if (!value.startsWith("/") || value.includes("\0") || !validUnicode(value))
		throw new TypeError(
			"Run directory must be an absolute valid Unicode path.",
		);
	return bytes;
}

function compareUtf8(left: string, right: string): number {
	const a = encoder.encode(left);
	const b = encoder.encode(right);
	const length = Math.min(a.byteLength, b.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return a.byteLength - b.byteLength;
}

function canonicalString(value: JsonValue, seen: Set<object>): string {
	if (value === null || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "string") {
		if (!validUnicode(value))
			throw new TypeError("JSON strings must be valid Unicode.");
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value))
			throw new TypeError("Journal numbers must be safe integers.");
		return String(value);
	}
	if (typeof value !== "object") throw new TypeError("Value is not JSON data.");
	if (seen.has(value))
		throw new TypeError("Journal data cannot contain cycles.");
	seen.add(value);
	try {
		if (Array.isArray(value))
			return `[${value.map((entry) => canonicalString(entry, seen)).join(",")}]`;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError("Journal objects must be plain records.");
		const record = value as Readonly<Record<string, JsonValue>>;
		const keys = Object.keys(record).sort(compareUtf8);
		for (const key of keys) {
			if (!validUnicode(key))
				throw new TypeError("Journal keys must be valid Unicode.");
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			if (
				!descriptor ||
				!("value" in descriptor) ||
				descriptor.value === undefined
			)
				throw new TypeError("Journal records cannot contain undefined values.");
		}
		return `{${keys
			.map((key) => {
				const descriptor = Object.getOwnPropertyDescriptor(record, key);
				if (!descriptor || !("value" in descriptor))
					throw new TypeError("Journal records cannot contain accessors.");
				return `${JSON.stringify(key)}:${canonicalString(descriptor.value as JsonValue, seen)}`;
			})
			.join(",")}}`;
	} finally {
		seen.delete(value);
	}
}

export function encodeJsonLine(
	value: JsonValue,
	maxBytes = MAX_JOURNAL_ROW_BYTES,
): Uint8Array {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 2)
		throw new RangeError("JSON line byte limit is invalid.");
	const bytes = encoder.encode(`${canonicalString(value, new Set())}\n`);
	if (bytes.byteLength > maxBytes)
		throw new RangeError("Journal row exceeds its byte limit.");
	return bytes;
}

export function decodeJsonLines(
	bytes: Uint8Array,
): Result<readonly JsonValue[]> {
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		return {
			ok: false,
			error: error("invalid_input", "Journal contains invalid UTF-8."),
		};
	}
	if (text.length === 0) return { ok: true, value: [] };
	if (!text.endsWith("\n"))
		return {
			ok: false,
			error: error("invalid_input", "Journal ends with an incomplete row."),
		};
	const values: JsonValue[] = [];
	for (const [index, line] of text.slice(0, -1).split("\n").entries()) {
		try {
			const value: unknown = JSON.parse(line);
			if (
				value === null ||
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean" ||
				typeof value === "object"
			) {
				canonicalString(value as JsonValue, new Set());
				values.push(value as JsonValue);
				continue;
			}
		} catch {
			// The row number is useful for repair tools and contains no file data.
		}
		return {
			ok: false,
			error: error(
				"invalid_input",
				`Journal row ${index + 1} is invalid JSON.`,
			),
		};
	}
	return { ok: true, value: values };
}

function validateCount(value: number | null, label: string): void {
	if (value !== null && (!Number.isSafeInteger(value) || value < 0))
		throw new TypeError(
			`${label} must be null or a non-negative safe integer.`,
		);
}

function safeIdentifier(value: string | null, label: string): string | null {
	if (value === null) return null;
	if (
		!/^[A-Za-z0-9._:-]{1,256}$/.test(value) ||
		redactSensitiveText(value) !== value
	)
		throw new TypeError(`${label} is invalid.`);
	return value;
}

function safeSha256(value: string | null): string | null {
	if (value === null) return null;
	if (!/^[a-f0-9]{64}$/.test(value))
		throw new TypeError("prefix_sha256 must be a lowercase SHA-256 digest.");
	return value;
}

function endpointParts(
	value: string,
): Readonly<{ host: string; path: string }> {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError("Request endpoint URL is invalid.");
	}
	if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname)
		throw new TypeError("Request endpoint must use HTTP or HTTPS.");
	return {
		host: url.host.toLowerCase(),
		path: redactSensitiveText(url.pathname),
	};
}

export function makeRequestAttemptRecord(
	input: RequestAttemptInput,
): RequestAttemptRecord {
	const started = input.started_ms;
	const ended = input.ended_ms;
	if (
		!Number.isSafeInteger(started) ||
		started < 0 ||
		!Number.isSafeInteger(ended) ||
		ended < started
	)
		throw new TypeError(
			"Request timestamps must be ordered epoch milliseconds.",
		);
	validateCount(input.request_bytes, "request_bytes");
	if (input.cut_after_ms !== null)
		validateCount(input.cut_after_ms, "cut_after_ms");
	if (typeof input.resumed !== "boolean")
		throw new TypeError("resumed must be a boolean.");
	const tokens: TokenUsage = {
		input: input.tokens.input,
		cached_input: input.tokens.cached_input,
		cache_write: input.tokens.cache_write,
		output: input.tokens.output,
		reasoning: input.tokens.reasoning,
	};
	for (const [key, count] of Object.entries(tokens))
		validateCount(count, `tokens.${key}`);
	const headers = input.header_names.map((name) => {
		const normalized = name.toLowerCase();
		if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized))
			throw new TypeError("Request header names must be valid HTTP tokens.");
		return normalized;
	});
	return {
		kind: "request_attempt",
		attempt_id: safeIdentifier(input.attempt_id, "attempt_id") ?? "",
		stage: safeIdentifier(input.stage, "stage") ?? "",
		rung: safeIdentifier(input.rung, "rung"),
		provider: safeIdentifier(input.provider, "provider") ?? "",
		adapter: safeIdentifier(input.adapter, "adapter") ?? "",
		model: safeIdentifier(input.model, "model") ?? "",
		effort: safeIdentifier(input.effort, "effort") ?? "",
		endpoint: endpointParts(input.endpoint_url),
		headers: [...new Set(headers)].sort(compareUtf8),
		cache_key: safeIdentifier(input.cache_key, "cache_key"),
		thread_id: safeIdentifier(input.thread_id, "thread_id"),
		conversation_id: safeIdentifier(input.conversation_id, "conversation_id"),
		request_bytes: input.request_bytes,
		prefix_sha256: safeSha256(input.prefix_sha256),
		started_ms: started,
		ended_ms: ended,
		cut_after_ms: input.cut_after_ms,
		resumed: input.resumed,
		tokens,
	};
}

export function redactSensitiveText(text: string): string {
	return text
		.replace(
			/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
			"[REDACTED PRIVATE KEY]",
		)
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "$1 [REDACTED]")
		.replace(
			/\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,})\b/g,
			"[REDACTED TOKEN]",
		)
		.replace(
			/\b(?:xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|pypi-[A-Za-z0-9_-]{50,})\b/g,
			"[REDACTED TOKEN]",
		)
		.replace(
			/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
			"[REDACTED JWT]",
		)
		.replace(
			/\b([\w-]*(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|credential|password|cookie|token))\s*([:=])\s*(["']?)[^\s"',;]+/gi,
			"$1$2[REDACTED]",
		);
}

function redactJsonValue(
	value: JsonValue,
	seen = new Set<object>(),
): JsonValue {
	if (typeof value === "string") return redactSensitiveText(value);
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value))
		throw new TypeError("Journal data cannot contain cycles.");
	seen.add(value);
	try {
		if (Array.isArray(value))
			return value.map((entry) => redactJsonValue(entry, seen));
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null)
			throw new TypeError("Journal objects must be plain records.");
		const redacted: Record<string, JsonValue> = Object.create(null) as Record<
			string,
			JsonValue
		>;
		for (const key of Object.keys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor))
				throw new TypeError("Journal records cannot contain accessors.");
			const safeKey = redactSensitiveText(key);
			if (Object.hasOwn(redacted, safeKey))
				throw new TypeError("Redaction produced a duplicate journal key.");
			redacted[safeKey] = redactJsonValue(descriptor.value as JsonValue, seen);
		}
		return redacted;
	} finally {
		seen.delete(value);
	}
}

export function sanitizeJournalEvent(event: JournalEvent): JournalEvent {
	const safe = redactJsonValue(event);
	if (
		safe === null ||
		Array.isArray(safe) ||
		typeof safe !== "object" ||
		typeof (safe as Readonly<Record<string, JsonValue>>).event !== "string" ||
		typeof (safe as Readonly<Record<string, JsonValue>>).ts !== "number"
	)
		throw new TypeError("Journal event is invalid.");
	return safe as unknown as JournalEvent;
}

export function encodeSafeLogBytes(bytes: Uint8Array): Uint8Array {
	let text: string;
	try {
		text = decoder.decode(bytes);
	} catch {
		const digest = createHash("sha256").update(bytes).digest("hex");
		text = `[non-UTF-8 log omitted; bytes=${bytes.byteLength}; sha256=${digest}]\n`;
	}
	return encoder.encode(redactSensitiveText(text));
}

export async function appendRequestAttempt(
	host: FileSystemHostRequest,
	runDirectory: string,
	input: RequestAttemptInput,
): Promise<Result<RequestAttemptRecord, JournalWriteError>> {
	let record: RequestAttemptRecord;
	let line: Uint8Array;
	let root: Uint8Array;
	try {
		record = makeRequestAttemptRecord(input);
		line = encodeJsonLine({ ...record });
		root = encodeRootPath(runDirectory);
	} catch (cause) {
		return {
			ok: false,
			error: {
				stage: "encode",
				appendState: "not_attempted",
				error: {
					...error(
						"invalid_input",
						"Request attempt metadata is invalid or unsafe.",
					),
					cause,
				},
			},
		};
	}
	const result = await appendFileBytes(host, {
		root,
		path: encoder.encode("transcript.jsonl"),
		bytes: line,
	});
	if (!result.ok)
		return {
			ok: false,
			error: { stage: "append", appendState: "unknown", error: result.error },
		};
	return { ok: true, value: record };
}

export const MAX_RUN_FILE_READ_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;

export async function readRunFile(
	host: FileSystemHostRequest,
	runDirectory: string,
	path: "run.json" | "events.jsonl" | "transcript.jsonl" | "candidate.diff",
): Promise<Result<Uint8Array>> {
	try {
		return readControllerFileBytes(host, {
			root: encodeRootPath(runDirectory),
			path: encoder.encode(path),
			maxBytes: MAX_RUN_FILE_READ_BYTES,
		});
	} catch {
		return {
			ok: false,
			error: error("invalid_input", "Run directory path is invalid."),
		};
	}
}
