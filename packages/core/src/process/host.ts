import { accessSync, closeSync, constants, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const HOST_MAX_PAYLOAD_BYTES = HOST_MAX_FRAME_BYTES - 8;

const FRAME_HEADER_BYTES = 8;
const FRAME_PREFIX_BYTES = 4;
const RESPONSE_BIT = 0x8000;
const ERROR_OPERATION = 0xffff;
const STDERR_LIMIT_BYTES = 64 * 1024;
type HostSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

export interface HostHelperLookupOptions {
	readonly compiledExecutablePath?: string;
}

export type HostBridgeOptions = HostHelperLookupOptions;

export class HostBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HostBridgeError";
	}
}

export function hostHelperName(
	platform: string = process.platform,
	architecture: string = process.arch,
): string {
	if (platform !== "darwin" && platform !== "linux") {
		throw new HostBridgeError(`Unsupported host platform: ${platform}`);
	}
	if (!/^[A-Za-z0-9_-]+$/.test(architecture)) {
		throw new HostBridgeError(`Unsupported host architecture: ${architecture}`);
	}
	return `kogen-host-${platform}-${architecture}`;
}

export function resolveHostHelperPath(
	options: HostHelperLookupOptions = {},
): string {
	const executablePath = resolve(
		options.compiledExecutablePath ?? process.execPath,
	);
	const name = hostHelperName();
	const sourceRoot = resolve(import.meta.dir, "../../../..");
	const candidates = [
		join(dirname(executablePath), name),
		join(sourceRoot, "native", name),
	];
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) {
				accessSync(candidate, constants.X_OK);
				return candidate;
			}
		} catch {
			// Try the next packaged or source-run location.
		}
	}
	throw new HostBridgeError(
		`Compiled host helper ${name} was not found beside ${executablePath} or in ${join(sourceRoot, "native")}`,
	);
}

class StreamBytes {
	readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
	#chunks: Uint8Array[] = [];
	#available = 0;

	constructor(stream: ReadableStream<Uint8Array>) {
		this.#reader = stream.getReader();
	}

	async readExact(length: number): Promise<Uint8Array> {
		while (this.#available < length) {
			const next = await this.#reader.read();
			if (next.done)
				throw new HostBridgeError("Host helper closed its response pipe");
			if (next.value.byteLength === 0) continue;
			this.#chunks.push(next.value);
			this.#available += next.value.byteLength;
		}

		const result = new Uint8Array(length);
		let offset = 0;
		while (offset < length) {
			const chunk = this.#chunks[0];
			if (!chunk)
				throw new HostBridgeError("Host response buffer was inconsistent");
			const take = Math.min(chunk.byteLength, length - offset);
			result.set(chunk.subarray(0, take), offset);
			offset += take;
			this.#available -= take;
			if (take === chunk.byteLength) this.#chunks.shift();
			else this.#chunks[0] = chunk.subarray(take);
		}
		return result;
	}
}

function u32be(bytes: Uint8Array, offset: number): number {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint32(offset, false);
}

function encodeFrame(
	operation: number,
	requestId: number,
	payload: Uint8Array,
): Uint8Array {
	if (
		!Number.isInteger(operation) ||
		operation < 1 ||
		operation >= RESPONSE_BIT
	) {
		throw new HostBridgeError(
			"Host operation must be an unsigned request opcode",
		);
	}
	if (payload.byteLength > HOST_MAX_PAYLOAD_BYTES) {
		throw new HostBridgeError("Host request exceeds the 1 MiB frame bound");
	}
	const frame = new Uint8Array(
		FRAME_PREFIX_BYTES + FRAME_HEADER_BYTES + payload.byteLength,
	);
	const view = new DataView(frame.buffer);
	view.setUint32(0, FRAME_HEADER_BYTES + payload.byteLength, false);
	view.setUint16(FRAME_PREFIX_BYTES, HOST_PROTOCOL_VERSION, false);
	view.setUint16(FRAME_PREFIX_BYTES + 2, operation, false);
	view.setUint32(FRAME_PREFIX_BYTES + 4, requestId, false);
	frame.set(payload, FRAME_PREFIX_BYTES + FRAME_HEADER_BYTES);
	return frame;
}

export class HostBridge {
	readonly #process: HostSubprocess;
	readonly #controlFd: number;
	readonly #responses: StreamBytes;
	readonly #stderr: Promise<void>;
	#stderrBytes = 0;
	#stderrText = "";
	#requestId = 1;
	#requestQueue: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(child: HostSubprocess, controlFd: number) {
		this.#process = child;
		this.#controlFd = controlFd;
		this.#responses = new StreamBytes(child.stdout);
		this.#stderr = this.#drainStderr(child.stderr);
	}

	get pid(): number {
		return this.#process.pid;
	}

	get stderrText(): string {
		return this.#stderrText;
	}

	async request(
		operation: number,
		payload = new Uint8Array(),
	): Promise<Uint8Array> {
		if (payload.byteLength > HOST_MAX_PAYLOAD_BYTES) {
			throw new HostBridgeError("Host request exceeds the 1 MiB frame bound");
		}
		const payloadCopy = payload.slice();
		const response = this.#requestQueue.then(() =>
			this.#requestOnce(operation, payloadCopy),
		);
		this.#requestQueue = response.then(
			() => undefined,
			() => undefined,
		);
		return response;
	}

	async #requestOnce(
		operation: number,
		payload: Uint8Array,
	): Promise<Uint8Array> {
		if (this.#closed) throw new HostBridgeError("Host bridge is closed");
		const requestId = this.#requestId;
		this.#requestId = requestId === 0xffffffff ? 1 : requestId + 1;
		const stdin = this.#process.stdin;
		stdin.write(encodeFrame(operation, requestId, payload));
		await stdin.flush();

		const prefix = await this.#responses.readExact(FRAME_PREFIX_BYTES);
		const bodyLength = u32be(prefix, 0);
		if (bodyLength < FRAME_HEADER_BYTES || bodyLength > HOST_MAX_FRAME_BYTES) {
			throw new HostBridgeError("Host helper returned an invalid frame length");
		}
		const body = await this.#responses.readExact(bodyLength);
		const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
		const version = view.getUint16(0, false);
		const responseOperation = view.getUint16(2, false);
		const responseId = view.getUint32(4, false);
		if (version !== HOST_PROTOCOL_VERSION || responseId !== requestId) {
			throw new HostBridgeError(
				"Host response version or request id did not match",
			);
		}
		if (responseOperation === ERROR_OPERATION) {
			const errorCode =
				bodyLength >= FRAME_HEADER_BYTES + 4 ? u32be(body, 8) : 0;
			throw new HostBridgeError(`Host helper rejected request (${errorCode})`);
		}
		if (responseOperation !== (operation | RESPONSE_BIT)) {
			throw new HostBridgeError(
				"Host response operation did not match request",
			);
		}
		return body.slice(FRAME_HEADER_BYTES);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#requestQueue;
		try {
			this.#process.stdin.end();
		} finally {
			closeSync(this.#controlFd);
		}
		await this.#process.exited;
		await this.#stderr;
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			if (this.#stderrBytes >= STDERR_LIMIT_BYTES) continue;
			const remaining = STDERR_LIMIT_BYTES - this.#stderrBytes;
			const kept = chunk.subarray(0, remaining);
			this.#stderrText += decoder.decode(kept, { stream: true });
			this.#stderrBytes += kept.byteLength;
		}
		this.#stderrText += decoder.decode();
	}
}

export async function startHostBridge(
	options: HostBridgeOptions = {},
): Promise<HostBridge> {
	const helperPath = resolveHostHelperPath(options);
	let child: HostSubprocess;
	try {
		child = Bun.spawn<"pipe", "pipe", "pipe">({
			cmd: [helperPath],
			stdio: ["pipe", "pipe", "pipe", "socket-fd"],
			detached: true,
			env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
		});
	} catch (error) {
		throw new HostBridgeError(
			`Could not start compiled host helper: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const controlFd = child.stdio[3];
	if (controlFd == null) {
		child.kill("SIGKILL");
		throw new HostBridgeError("Bun did not create the private control socket");
	}
	const bridge = new HostBridge(child, controlFd);
	try {
		const version = await bridge.request(1);
		if (
			version.byteLength !== 6 ||
			u32be(version, 2) !== HOST_MAX_FRAME_BYTES
		) {
			throw new HostBridgeError(
				"Host helper did not advertise protocol version 1",
			);
		}
		const helperVersion = new DataView(
			version.buffer,
			version.byteOffset,
			version.byteLength,
		).getUint16(0, false);
		if (helperVersion !== HOST_PROTOCOL_VERSION) {
			throw new HostBridgeError(
				`Unsupported host protocol version ${helperVersion}`,
			);
		}
		return bridge;
	} catch (error) {
		child.kill("SIGKILL");
		closeSync(controlFd);
		await child.exited;
		throw error;
	}
}
