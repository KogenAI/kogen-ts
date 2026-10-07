import { HOST_MAX_PAYLOAD_BYTES, type HostBridge } from "./host";

export const PROCESS_SUPERVISE_OPERATION = 0x0303;
export const PROCESS_ARG_MAX_BYTES = 4096;
export const PROCESS_TIMEOUT_MAX_MS = 86_400_000;

const REQUEST_VERSION = 1;
const REQUEST_HEADER_BYTES = 32;
const RESPONSE_HEADER_BYTES = 44;
const RESPONSE_MAX_TAIL_BYTES = HOST_MAX_PAYLOAD_BYTES - RESPONSE_HEADER_BYTES;
const DEFAULT_TAIL_BYTES = 16 * 1024;
const MAX_ARGS = 256;
const MAX_ENV = 512;
const MAX_ENV_ENTRY_BYTES = 64 * 1024;

export interface SuperviseProcessRequest {
	readonly argv: readonly string[];
	readonly timeoutMs: number;
	readonly cwd?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly stdin?: Uint8Array;
	readonly stdoutTailBytes?: number;
	readonly stderrTailBytes?: number;
}

export type ProcessTermination = "exited" | "timed-out" | "parent-died";

export interface SuperviseProcessResult {
	readonly termination: ProcessTermination;
	readonly exitCode: number | null;
	readonly signal: number | null;
	readonly durationMs: number;
	readonly stdoutBytes: number;
	readonly stderrBytes: number;
	readonly stdoutTail: Uint8Array;
	readonly stderrTail: Uint8Array;
}

export class ProcessSupervisorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProcessSupervisorError";
	}
}

function requireSafeInteger(
	value: number,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new ProcessSupervisorError(
			`${name} must be an integer from ${minimum} through ${maximum}`,
		);
	}
	return value;
}

function textBytes(value: string, name: string, maxBytes: number): Uint8Array {
	if (value.includes("\0"))
		throw new ProcessSupervisorError(`${name} cannot contain NUL`);
	const bytes = new TextEncoder().encode(value);
	if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
		throw new ProcessSupervisorError(
			`${name} must contain 1 through ${maxBytes} UTF-8 bytes`,
		);
	}
	return bytes;
}

function putU32(view: DataView, offset: number, value: number): void {
	view.setUint32(offset, value, false);
}

export function encodeSupervisorRequest(
	request: SuperviseProcessRequest,
): Uint8Array<ArrayBuffer> {
	if (!Array.isArray(request.argv) || request.argv.length === 0)
		throw new ProcessSupervisorError("argv must contain an executable");
	if (request.argv.length > MAX_ARGS)
		throw new ProcessSupervisorError(`argv cannot exceed ${MAX_ARGS} elements`);
	const timeoutMs = requireSafeInteger(
		request.timeoutMs,
		"timeoutMs",
		1,
		PROCESS_TIMEOUT_MAX_MS,
	);
	const args = request.argv.map((argument, index) =>
		textBytes(argument, `argv[${index}]`, PROCESS_ARG_MAX_BYTES),
	);
	const cwd =
		request.cwd === undefined || request.cwd === ""
			? new Uint8Array()
			: textBytes(request.cwd, "cwd", MAX_ENV_ENTRY_BYTES);
	const environment = Object.entries(request.environment ?? {}).sort(
		([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
	);
	if (environment.length > MAX_ENV)
		throw new ProcessSupervisorError(
			`environment cannot exceed ${MAX_ENV} entries`,
		);
	const environmentBytes = environment.map(([key, value], index) => {
		if (key.length === 0 || key.includes("=") || key.includes("\0")) {
			throw new ProcessSupervisorError(
				`environment key ${index} must be nonempty and cannot contain = or NUL`,
			);
		}
		if (value.includes("\0"))
			throw new ProcessSupervisorError(
				`environment value ${index} cannot contain NUL`,
			);
		const entry = textBytes(
			`${key}=${value}`,
			`environment entry ${index}`,
			MAX_ENV_ENTRY_BYTES,
		);
		return entry;
	});
	const stdin = request.stdin?.slice() ?? new Uint8Array();
	const stdoutLimit = requireSafeInteger(
		request.stdoutTailBytes ?? DEFAULT_TAIL_BYTES,
		"stdoutTailBytes",
		0,
		RESPONSE_MAX_TAIL_BYTES,
	);
	const stderrLimit = requireSafeInteger(
		request.stderrTailBytes ?? DEFAULT_TAIL_BYTES,
		"stderrTailBytes",
		0,
		RESPONSE_MAX_TAIL_BYTES - stdoutLimit,
	);
	let length = REQUEST_HEADER_BYTES + cwd.byteLength + stdin.byteLength;
	for (const argument of args) length += 4 + argument.byteLength;
	for (const entry of environmentBytes) length += 4 + entry.byteLength;
	if (length > HOST_MAX_PAYLOAD_BYTES)
		throw new ProcessSupervisorError(
			"process request exceeds the 1 MiB host frame",
		);
	if (cwd.byteLength > 0xffff_ffff || stdin.byteLength > 0xffff_ffff)
		throw new ProcessSupervisorError("process request field is too large");
	const result = new Uint8Array(length);
	const view = new DataView(result.buffer);
	view.setUint16(0, REQUEST_VERSION, false);
	view.setUint16(2, 0, false);
	view.setBigUint64(4, BigInt(timeoutMs), false);
	putU32(view, 12, stdoutLimit);
	putU32(view, 16, stderrLimit);
	putU32(view, 20, cwd.byteLength);
	view.setUint16(24, args.length, false);
	view.setUint16(26, environmentBytes.length, false);
	putU32(view, 28, stdin.byteLength);
	let offset = REQUEST_HEADER_BYTES;
	result.set(cwd, offset);
	offset += cwd.byteLength;
	for (const argument of args) {
		putU32(view, offset, argument.byteLength);
		offset += 4;
		result.set(argument, offset);
		offset += argument.byteLength;
	}
	for (const entry of environmentBytes) {
		putU32(view, offset, entry.byteLength);
		offset += 4;
		result.set(entry, offset);
		offset += entry.byteLength;
	}
	result.set(stdin, offset);
	return result;
}

function safeNumber(view: DataView, offset: number, name: string): number {
	const value = view.getBigUint64(offset, false);
	if (value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new ProcessSupervisorError(
			`${name} exceeds JavaScript's safe integer range`,
		);
	return Number(value);
}

export function decodeSupervisorResponse(
	bytes: Uint8Array,
): SuperviseProcessResult {
	if (bytes.byteLength < RESPONSE_HEADER_BYTES)
		throw new ProcessSupervisorError(
			"supervisor returned a truncated response",
		);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint16(0, false) !== REQUEST_VERSION || view.getUint8(3) !== 0)
		throw new ProcessSupervisorError(
			"supervisor returned an unsupported response",
		);
	const terminationTag = view.getUint8(2);
	const termination: ProcessTermination | undefined =
		terminationTag === 0
			? "exited"
			: terminationTag === 1
				? "timed-out"
				: terminationTag === 2
					? "parent-died"
					: undefined;
	if (termination === undefined)
		throw new ProcessSupervisorError(
			"supervisor returned an unknown termination state",
		);
	const stdoutLength = view.getUint32(36, false);
	const stderrLength = view.getUint32(40, false);
	if (RESPONSE_HEADER_BYTES + stdoutLength + stderrLength !== bytes.byteLength)
		throw new ProcessSupervisorError(
			"supervisor returned inconsistent tail lengths",
		);
	const exitCodeValue = view.getInt32(4, false);
	const signalValue = view.getUint32(8, false);
	return {
		termination,
		exitCode: exitCodeValue < 0 ? null : exitCodeValue,
		signal: signalValue === 0 ? null : signalValue,
		durationMs: safeNumber(view, 12, "durationMs"),
		stdoutBytes: safeNumber(view, 20, "stdoutBytes"),
		stderrBytes: safeNumber(view, 28, "stderrBytes"),
		stdoutTail: bytes.slice(
			RESPONSE_HEADER_BYTES,
			RESPONSE_HEADER_BYTES + stdoutLength,
		),
		stderrTail: bytes.slice(RESPONSE_HEADER_BYTES + stdoutLength),
	};
}

export async function superviseProcess(
	bridge: Pick<HostBridge, "request">,
	request: SuperviseProcessRequest,
): Promise<SuperviseProcessResult> {
	const payload = encodeSupervisorRequest(request);
	const response = await bridge.request(PROCESS_SUPERVISE_OPERATION, payload);
	return decodeSupervisorResponse(response);
}
