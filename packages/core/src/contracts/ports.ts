import type { ClockPort } from "./clock";
import type { PortError, Result } from "./errors";

export interface FileReadRequest {
	readonly root: string;
	readonly path: string;
	readonly maxBytes: number;
}

export interface FileWriteRequest {
	readonly root: string;
	readonly path: string;
	readonly bytes: Uint8Array;
	readonly mode: number;
	readonly expectedSha256?: string;
}

/** Anchored, no-follow filesystem operations supplied by the host layer. */
export interface FileSystemPort {
	readFile(request: FileReadRequest): Promise<Result<Uint8Array>>;
	writeFileAtomically(request: FileWriteRequest): Promise<Result<void>>;
	removeFile(root: string, path: string): Promise<Result<void>>;
}

export interface ProcessRequest {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly stdin?: Uint8Array;
	readonly timeoutMilliseconds: number;
	readonly outputLimitBytes: number;
}

export interface ProcessResult {
	readonly exitCode: number | null;
	readonly signal: string | null;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
	readonly timedOut: boolean;
}

export interface ProcessPort {
	run(request: ProcessRequest): Promise<Result<ProcessResult>>;
}

export interface GitRequest {
	readonly repository: string;
	readonly argv: readonly string[];
	readonly stdin?: Uint8Array;
	readonly timeoutMilliseconds: number;
	readonly outputLimitBytes: number;
}

export interface GitPort {
	command(request: GitRequest): Promise<Result<ProcessResult>>;
}

export interface HttpRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body?: Uint8Array;
	readonly firstByteTimeoutMilliseconds: number;
	readonly idleTimeoutMilliseconds: number;
	readonly totalTimeoutMilliseconds: number;
}

export interface HttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: AsyncIterable<Uint8Array>;
}

export interface HttpPort {
	request(
		request: HttpRequest,
		signal?: AbortSignal,
	): Promise<Result<HttpResponse>>;
}

export interface CredentialKey {
	readonly provider: string;
	readonly account: string;
	readonly name: string;
}

/** Secret values stay as bytes at the port boundary. */
export interface CredentialPort {
	read(key: CredentialKey): Promise<Result<Uint8Array>>;
	write(key: CredentialKey, value: Uint8Array): Promise<Result<void>>;
	remove(key: CredentialKey): Promise<Result<void>>;
}

export interface RandomPort {
	bytes(length: number): Promise<Result<Uint8Array>>;
}

export interface EffectPorts {
	readonly clock: ClockPort;
	readonly credentials: CredentialPort;
	readonly filesystem: FileSystemPort;
	readonly git: GitPort;
	readonly http: HttpPort;
	readonly process: ProcessPort;
	readonly random: RandomPort;
}

export type { PortError };
