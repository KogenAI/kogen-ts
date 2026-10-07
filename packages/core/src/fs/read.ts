import type { PortError, Result } from "../contracts/errors";
import type { FileReadRequest, FileSystemPort } from "../contracts/ports";

export const FILESYSTEM_HOST_OPERATION = 0x0301;
export const FILESYSTEM_MAX_PATH_BYTES = 64 * 1024;
export const FILESYSTEM_MAX_ENTRIES = 4096;
export const FILESYSTEM_MAX_RESPONSE_BYTES = 1024 * 1024 - 8;

const REQUEST_HEADER_BYTES = 17;
const RESPONSE_STATUS_BYTES = 1;
const ACTION_CONTROLLER_READ = 1;
const ACTION_TOOL_READ = 2;
const ACTION_CONTROLLER_LIST = 3;
const ACTION_TOOL_LIST = 4;

export const FileSystemStatus = {
	ok: 0,
	invalidPath: 1,
	notFound: 2,
	permission: 3,
	outsideRoot: 4,
	notRegular: 5,
	tooLarge: 6,
	io: 7,
	limit: 8,
} as const;

export const FileSystemEntryKind = {
	regular: 1,
	directory: 2,
	symlink: 3,
	other: 4,
} as const;

export type FileSystemEntryKindName = keyof typeof FileSystemEntryKind;

export interface FileSystemHostRequest {
	request(operation: number, payload: Uint8Array): Promise<Uint8Array>;
}

export interface BytePathReadRequest {
	readonly root: Uint8Array;
	readonly path: Uint8Array;
	readonly maxBytes: number;
}

export interface BytePathListRequest {
	readonly root: Uint8Array;
	readonly path: Uint8Array;
	readonly maxEntries: number;
	readonly maxNameBytes: number;
}

export interface FileSystemDirectoryEntry {
	readonly name: Uint8Array;
	readonly kind: FileSystemEntryKindName;
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
				"Filesystem handle is not a regular file or directory.",
			);
		case FileSystemStatus.tooLarge:
		case FileSystemStatus.limit:
			return portError(
				"invalid_input",
				"Filesystem request exceeds its byte or traversal limit.",
			);
		default:
			return portError("io", "Filesystem operation failed.");
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

function validateU32(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
		throw new RangeError(`${label} must be an unsigned 32-bit integer.`);
}

function encodeRequest(
	action: number,
	root: Uint8Array,
	path: Uint8Array,
	maxBytes: number,
	maxEntries = 0,
): Uint8Array {
	validateU32(maxBytes, "maxBytes");
	validateU32(maxEntries, "maxEntries");
	if (root.byteLength === 0 || root.byteLength > FILESYSTEM_MAX_PATH_BYTES)
		throw new RangeError("Root path is empty or exceeds the path bound.");
	if (path.byteLength > FILESYSTEM_MAX_PATH_BYTES)
		throw new RangeError("Relative path exceeds the path bound.");
	const requestLength =
		REQUEST_HEADER_BYTES + root.byteLength + path.byteLength;
	if (requestLength > FILESYSTEM_MAX_RESPONSE_BYTES)
		throw new RangeError("Filesystem request exceeds the host frame bound.");
	const request = new Uint8Array(requestLength);
	const view = new DataView(request.buffer);
	request[0] = action;
	view.setUint32(1, maxBytes, false);
	view.setUint32(5, maxEntries, false);
	view.setUint32(9, root.byteLength, false);
	view.setUint32(13, path.byteLength, false);
	request.set(root, REQUEST_HEADER_BYTES);
	request.set(path, REQUEST_HEADER_BYTES + root.byteLength);
	return request;
}

function decodeStatus(
	response: Uint8Array,
):
	| { readonly ok: true; readonly payload: Uint8Array }
	| { readonly ok: false; readonly error: PortError } {
	if (response.byteLength < RESPONSE_STATUS_BYTES)
		return {
			ok: false,
			error: portError(
				"unknown",
				"Filesystem helper returned an empty response.",
			),
		};
	const status = response[0];
	if (status !== FileSystemStatus.ok)
		return { ok: false, error: errorForStatus(status ?? FileSystemStatus.io) };
	return { ok: true, payload: response.subarray(RESPONSE_STATUS_BYTES) };
}

async function send(
	host: FileSystemHostRequest,
	request: Uint8Array,
): Promise<Result<Uint8Array>> {
	try {
		const response = await host.request(FILESYSTEM_HOST_OPERATION, request);
		const decoded = decodeStatus(response);
		if (!decoded.ok) return decoded;
		return { ok: true, value: decoded.payload.slice() };
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

async function readBytes(
	host: FileSystemHostRequest,
	request: BytePathReadRequest,
	action: number,
): Promise<Result<Uint8Array>> {
	if (
		!Number.isSafeInteger(request.maxBytes) ||
		request.maxBytes < 0 ||
		request.maxBytes > FILESYSTEM_MAX_RESPONSE_BYTES - 1
	) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"maxBytes is outside the supported range.",
			),
		};
	}
	let payload: Uint8Array;
	try {
		payload = encodeRequest(
			action,
			request.root,
			request.path,
			request.maxBytes,
		);
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
	const response = await send(host, payload);
	if (!response.ok) return response;
	if (response.value.byteLength > request.maxBytes) {
		return {
			ok: false,
			error: portError(
				"unknown",
				"Filesystem helper exceeded the requested read bound.",
			),
		};
	}
	return response;
}

export function readControllerFileBytes(
	host: FileSystemHostRequest,
	request: BytePathReadRequest,
): Promise<Result<Uint8Array>> {
	return readBytes(host, request, ACTION_CONTROLLER_READ);
}

export function readToolFileBytes(
	host: FileSystemHostRequest,
	request: BytePathReadRequest,
): Promise<Result<Uint8Array>> {
	return readBytes(host, request, ACTION_TOOL_READ);
}

export async function listDirectoryBytes(
	host: FileSystemHostRequest,
	request: BytePathListRequest,
	followInRootLinks = false,
): Promise<Result<readonly FileSystemDirectoryEntry[]>> {
	if (
		!Number.isSafeInteger(request.maxEntries) ||
		request.maxEntries < 0 ||
		request.maxEntries > FILESYSTEM_MAX_ENTRIES ||
		!Number.isSafeInteger(request.maxNameBytes) ||
		request.maxNameBytes < 0 ||
		request.maxNameBytes > FILESYSTEM_MAX_RESPONSE_BYTES
	) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Directory listing limits are outside the supported range.",
			),
		};
	}
	let payload: Uint8Array;
	try {
		payload = encodeRequest(
			followInRootLinks ? ACTION_TOOL_LIST : ACTION_CONTROLLER_LIST,
			request.root,
			request.path,
			request.maxNameBytes,
			request.maxEntries,
		);
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
	const response = await send(host, payload);
	if (!response.ok) return response;
	const bytes = response.value;
	if (bytes.byteLength < 4) {
		return {
			ok: false,
			error: portError(
				"unknown",
				"Filesystem helper returned a truncated directory listing.",
			),
		};
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = view.getUint32(0, false);
	if (count > request.maxEntries) {
		return {
			ok: false,
			error: portError(
				"unknown",
				"Filesystem helper exceeded the directory entry limit.",
			),
		};
	}
	const entries: FileSystemDirectoryEntry[] = [];
	let offset = 4;
	for (let index = 0; index < count; index++) {
		if (offset + 5 > bytes.byteLength)
			return {
				ok: false,
				error: portError(
					"unknown",
					"Filesystem helper returned a truncated directory entry.",
				),
			};
		const kind = bytes[offset];
		const nameLength = view.getUint32(offset + 1, false);
		offset += 5;
		if (nameLength === 0 || offset + nameLength > bytes.byteLength)
			return {
				ok: false,
				error: portError(
					"unknown",
					"Filesystem helper returned an invalid entry name.",
				),
			};
		const kindName = entryKindName(kind);
		if (kindName === undefined)
			return {
				ok: false,
				error: portError(
					"unknown",
					"Filesystem helper returned an unknown entry kind.",
				),
			};
		entries.push({
			name: bytes.slice(offset, offset + nameLength),
			kind: kindName,
		});
		offset += nameLength;
	}
	if (offset !== bytes.byteLength) {
		return {
			ok: false,
			error: portError(
				"unknown",
				"Filesystem helper returned trailing directory data.",
			),
		};
	}
	return { ok: true, value: entries };
}

function entryKindName(
	kind: number | undefined,
): FileSystemEntryKindName | undefined {
	for (const [name, value] of Object.entries(FileSystemEntryKind)) {
		if (value === kind) return name as FileSystemEntryKindName;
	}
	return undefined;
}

export function createReadFileSystemPort(
	host: FileSystemHostRequest,
): Pick<FileSystemPort, "readFile"> {
	return {
		readFile(request: FileReadRequest) {
			let root: Uint8Array;
			let path: Uint8Array;
			try {
				root = encodeTextPath(request.root);
				path = encodeTextPath(request.path);
			} catch (error) {
				return Promise.resolve({
					ok: false,
					error: portError(
						"invalid_input",
						error instanceof Error
							? error.message
							: "Filesystem path is invalid.",
					),
				});
			}
			return readControllerFileBytes(host, {
				root,
				path,
				maxBytes: request.maxBytes,
			});
		},
	};
}
