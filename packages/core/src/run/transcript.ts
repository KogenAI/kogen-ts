import type { PortError, Result } from "../contracts/errors";
import {
	appendFileBytes,
	type BytePathPublishRequest,
	publishFileAtomically,
} from "../fs/publish";
import type { FileSystemHostRequest } from "../fs/read";
import {
	encodeJsonLine,
	encodeSafeLogBytes,
	type JsonValue,
	redactSensitiveText,
} from "./journal";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface TranscriptTextEntry {
	readonly kind: "assistant_text" | "tool_result" | "controller_note";
	readonly stage: string;
	readonly rung: string | null;
	readonly turn: number;
	readonly ts: number;
	readonly text: string;
}

function portError(
	code: PortError["code"],
	message: string,
	cause?: unknown,
): PortError {
	return {
		code,
		message,
		retryable: code === "io" || code === "unavailable",
		...(cause === undefined ? {} : { cause }),
	};
}

function publishRequest(
	runDirectory: string,
	path: string,
	bytes: Uint8Array,
): BytePathPublishRequest {
	const rootBytes = encoder.encode(runDirectory);
	const pathBytes = encoder.encode(path);
	if (
		!runDirectory.startsWith("/") ||
		runDirectory.includes("\0") ||
		decoder.decode(rootBytes) !== runDirectory ||
		path.includes("\0") ||
		decoder.decode(pathBytes) !== path
	)
		throw new TypeError(
			"Transcript path is not a valid absolute Unicode path.",
		);
	return {
		root: rootBytes,
		path: pathBytes,
		bytes,
	};
}

function validTranscriptName(filename: string): boolean {
	return (
		filename.length > 0 &&
		filename.length <= 128 &&
		filename !== "." &&
		filename !== ".." &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)
	);
}

function transcriptText(value: TranscriptTextEntry): JsonValue {
	if (
		(value.kind !== "assistant_text" &&
			value.kind !== "tool_result" &&
			value.kind !== "controller_note") ||
		!Number.isSafeInteger(value.turn) ||
		value.turn < 0 ||
		!Number.isSafeInteger(value.ts) ||
		value.ts < 0 ||
		value.stage.length === 0 ||
		/[\r\n\0]/.test(value.stage) ||
		(value.rung !== null &&
			(value.rung.length === 0 || /[\r\n\0]/.test(value.rung))) ||
		typeof value.text !== "string"
	)
		throw new TypeError("Transcript entry is invalid.");
	return {
		kind: value.kind,
		stage: redactSensitiveText(value.stage),
		rung: value.rung === null ? null : redactSensitiveText(value.rung),
		turn: value.turn,
		ts: value.ts,
		text: redactSensitiveText(value.text),
	};
}

export async function appendTranscriptText(
	host: FileSystemHostRequest,
	runDirectory: string,
	entry: TranscriptTextEntry,
): Promise<Result<void>> {
	let line: Uint8Array;
	let request: BytePathPublishRequest;
	try {
		line = encodeJsonLine(transcriptText(entry));
		request = publishRequest(runDirectory, "transcript.jsonl", line);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Transcript entry is invalid or too large.",
				cause,
			),
		};
	}
	return appendFileBytes(host, request);
}

export async function writeSafeLog(
	host: FileSystemHostRequest,
	runDirectory: string,
	filename: string,
	bytes: Uint8Array,
): Promise<Result<void>> {
	if (!validTranscriptName(filename))
		return {
			ok: false,
			error: portError("invalid_input", "Log filename is invalid."),
		};
	try {
		return publishFileAtomically(
			host,
			publishRequest(
				runDirectory,
				`logs/${filename}`,
				encodeSafeLogBytes(bytes),
			),
			0o600,
		);
	} catch (cause) {
		return {
			ok: false,
			error: portError("invalid_input", "Log path is invalid.", cause),
		};
	}
}

export async function writeSafeCandidateDiff(
	host: FileSystemHostRequest,
	runDirectory: string,
	filename: string,
	bytes: Uint8Array,
): Promise<Result<void>> {
	if (
		filename !== "candidate.diff" &&
		!/^candidate-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.diff$/.test(filename)
	)
		return {
			ok: false,
			error: portError("invalid_input", "Candidate diff filename is invalid."),
		};
	try {
		return publishFileAtomically(
			host,
			publishRequest(runDirectory, filename, encodeSafeLogBytes(bytes)),
			0o600,
		);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Candidate diff path is invalid.",
				cause,
			),
		};
	}
}

export function sanitizeTranscriptText(text: string): string {
	return redactSensitiveText(text);
}
