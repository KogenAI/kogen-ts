import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort, FileWriteRequest } from "../contracts/ports";
import { type FileSystemHostRequest, FileSystemStatus } from "./read";

export const FILESYSTEM_PUBLISH_HOST_OPERATION = 0x0302;
export const FILESYSTEM_PUBLISH_MAX_BYTES = 1024 * 1024 - 8;
export const FILESYSTEM_PUBLISH_MAX_PATH_BYTES = 64 * 1024;
export const FILESYSTEM_PUBLISH_ACTION = {
	atomicWrite: 1,
	append: 2,
	remove: 3,
	restore: 4,
} as const;
export const FILESYSTEM_RESTORE_KIND = {
	regular: 1,
	symlink: 2,
	directory: 3,
	absent: 4,
} as const;

const REQUEST_HEADER_BYTES = 16;

export interface BytePathPublishRequest {
	readonly root: Uint8Array;
	readonly path: Uint8Array;
	readonly bytes: Uint8Array;
}

function portError(code: PortError["code"], message: string): PortError {
	return { code, message, retryable: code === "io" || code === "unavailable" };
}

function errorForStatus(status: number): PortError {
	switch (status) {
		case FileSystemStatus.invalidPath:
			return portError(
				"invalid_input",
				"Filesystem path is invalid or could not be resolved safely.",
			);
		case FileSystemStatus.notFound:
			return portError("not_found", "Filesystem path does not exist.");
		case FileSystemStatus.permission:
			return portError("permission_denied", "Filesystem access was denied.");
		case FileSystemStatus.outsideRoot:
			return portError("permission_denied", "Path escapes the worktree.");
		case FileSystemStatus.notRegular:
			return portError(
				"invalid_input",
				"Filesystem handle has an incompatible type.",
			);
		case FileSystemStatus.tooLarge:
		case FileSystemStatus.limit:
			return portError(
				"invalid_input",
				"Filesystem request exceeds its byte or traversal limit.",
			);
		case FileSystemStatus.io:
			return portError("io", "Filesystem operation failed.");
		default:
			return portError(
				"unknown",
				"Filesystem helper returned an unknown status.",
			);
	}
}

function encodeTextPath(value: string): Uint8Array {
	const encoded = new TextEncoder().encode(value);
	try {
		if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== value)
			throw new Error("Path contains an unpaired UTF-16 surrogate.");
	} catch {
		throw new TypeError("Filesystem string paths must be valid Unicode.");
	}
	return encoded;
}

function encodeRequest(
	action: number,
	root: Uint8Array,
	path: Uint8Array,
	bytes: Uint8Array = new Uint8Array(),
	mode = 0,
	restoreKind = 0,
): Uint8Array {
	if (
		root.byteLength === 0 ||
		root.byteLength > FILESYSTEM_PUBLISH_MAX_PATH_BYTES ||
		path.byteLength === 0 ||
		path.byteLength > FILESYSTEM_PUBLISH_MAX_PATH_BYTES
	)
		throw new RangeError(
			"Root or relative path is empty or exceeds its bound.",
		);
	const length =
		REQUEST_HEADER_BYTES + root.byteLength + path.byteLength + bytes.byteLength;
	if (length > FILESYSTEM_PUBLISH_MAX_BYTES)
		throw new RangeError(
			"Filesystem publication request exceeds the host frame bound.",
		);
	const request = new Uint8Array(length);
	const view = new DataView(request.buffer);
	request[0] = action;
	request[1] = restoreKind;
	view.setUint16(2, mode, false);
	view.setUint32(4, root.byteLength, false);
	view.setUint32(8, path.byteLength, false);
	view.setUint32(12, bytes.byteLength, false);
	request.set(root, REQUEST_HEADER_BYTES);
	request.set(path, REQUEST_HEADER_BYTES + root.byteLength);
	request.set(bytes, REQUEST_HEADER_BYTES + root.byteLength + path.byteLength);
	return request;
}

async function send(
	host: FileSystemHostRequest,
	request: Uint8Array,
): Promise<Result<void>> {
	try {
		const response = await host.request(
			FILESYSTEM_PUBLISH_HOST_OPERATION,
			request,
		);
		if (response.byteLength !== 1)
			return {
				ok: false,
				error: portError(
					"unknown",
					"Filesystem helper returned a malformed status.",
				),
			};
		const status = response[0];
		if (status !== FileSystemStatus.ok)
			return {
				ok: false,
				error: errorForStatus(status ?? FileSystemStatus.io),
			};
		return { ok: true, value: undefined };
	} catch (error) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				error instanceof Error
					? `Filesystem host operation is unavailable: ${error.message}`
					: "Filesystem host operation is unavailable.",
			),
		};
	}
}

function encodeOrError(encode: () => Uint8Array): Uint8Array | Result<void> {
	try {
		return encode();
	} catch (error) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				error instanceof Error
					? error.message
					: "Filesystem request is invalid.",
			),
		};
	}
}

function isErrorResult(
	value: Uint8Array | Result<void>,
): value is Result<void> {
	return !(value instanceof Uint8Array);
}

export interface FileSystemPublishCommand {
	readonly action: number;
	readonly root: Uint8Array;
	readonly path: Uint8Array;
	readonly bytes?: Uint8Array;
	readonly mode?: number;
	readonly restoreKind?: number;
}

export function sendFilesystemPublishCommand(
	host: FileSystemHostRequest,
	command: FileSystemPublishCommand,
): Promise<Result<void>> {
	const payload = encodeOrError(() =>
		encodeRequest(
			command.action,
			command.root,
			command.path,
			command.bytes,
			command.mode,
			command.restoreKind,
		),
	);
	return isErrorResult(payload)
		? Promise.resolve(payload)
		: send(host, payload);
}

export function publishFileAtomically(
	host: FileSystemHostRequest,
	request: BytePathPublishRequest,
	mode: 0o600 | 0o700,
): Promise<Result<void>> {
	return sendFilesystemPublishCommand(host, {
		action: FILESYSTEM_PUBLISH_ACTION.atomicWrite,
		root: request.root,
		path: request.path,
		bytes: request.bytes,
		mode,
	});
}

export function appendFileBytes(
	host: FileSystemHostRequest,
	request: BytePathPublishRequest,
): Promise<Result<void>> {
	return sendFilesystemPublishCommand(host, {
		action: FILESYSTEM_PUBLISH_ACTION.append,
		root: request.root,
		path: request.path,
		bytes: request.bytes,
	});
}

export function removePathNoFollow(
	host: FileSystemHostRequest,
	root: Uint8Array,
	path: Uint8Array,
): Promise<Result<void>> {
	return sendFilesystemPublishCommand(host, {
		action: FILESYSTEM_PUBLISH_ACTION.remove,
		root,
		path,
	});
}

function invalidResult(message: string): Result<void> {
	return { ok: false, error: portError("invalid_input", message) };
}

export function createPublicationFileSystemPort(
	host: FileSystemHostRequest,
): Pick<FileSystemPort, "writeFileAtomically" | "removeFile"> {
	return {
		writeFileAtomically(request: FileWriteRequest) {
			if (request.expectedSha256 !== undefined)
				return Promise.resolve(
					invalidResult("Conditional filesystem publication is not supported."),
				);
			if (
				!Number.isSafeInteger(request.mode) ||
				request.mode < 0 ||
				request.mode > 0o7777
			)
				return Promise.resolve(invalidResult("File mode is invalid."));
			let root: Uint8Array;
			let path: Uint8Array;
			try {
				root = encodeTextPath(request.root);
				path = encodeTextPath(request.path);
			} catch (error) {
				return Promise.resolve(
					invalidResult(
						error instanceof Error
							? error.message
							: "Filesystem path is invalid.",
					),
				);
			}
			return publishFileAtomically(
				host,
				{ root, path, bytes: request.bytes },
				(request.mode & 0o111) !== 0 ? 0o700 : 0o600,
			);
		},
		removeFile(rootPath: string, relativePath: string) {
			let root: Uint8Array;
			let path: Uint8Array;
			try {
				root = encodeTextPath(rootPath);
				path = encodeTextPath(relativePath);
			} catch (error) {
				return Promise.resolve(
					invalidResult(
						error instanceof Error
							? error.message
							: "Filesystem path is invalid.",
					),
				);
			}
			return removePathNoFollow(host, root, path);
		},
	};
}
