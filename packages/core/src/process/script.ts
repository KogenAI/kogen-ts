import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Result } from "../contracts/errors";
import type {
	FileSystemPort,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../contracts/ports";

export const PRIVATE_SCRIPT_MODE = 0o600;
export const PRIVATE_SCRIPT_ARG_MAX_BYTES = 4096;

export interface PrivateScriptFile {
	readonly path: string;
	readonly relativePath: string;
}

export interface RunPrivateShellScriptRequest {
	readonly runDirectory: string;
	readonly workingDirectory: string;
	readonly script: string | Uint8Array;
	readonly environment: Readonly<Record<string, string>>;
	/** Passed unchanged to the process supervisor; project deadlines are unscaled. */
	readonly timeoutMilliseconds: number;
	readonly outputLimitBytes: number;
	readonly stdin?: Uint8Array;
}

function scriptBytes(script: string | Uint8Array): Uint8Array {
	if (script instanceof Uint8Array) return script.slice();
	const bytes = new TextEncoder().encode(script);
	if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== script)
		throw new TypeError("shell script contains invalid Unicode");
	return bytes;
}

/** Write script bytes atomically below the private run directory at mode 0600. */
export async function writePrivateScript(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	runDirectory: string,
	script: string | Uint8Array,
): Promise<Result<PrivateScriptFile>> {
	let bytes: Uint8Array;
	try {
		bytes = scriptBytes(script);
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message:
					error instanceof Error ? error.message : "shell script is invalid",
				retryable: false,
			},
		};
	}
	const relativePath = `shell-${randomBytes(16).toString("hex")}.sh`;
	const path = join(runDirectory, relativePath);
	if (
		new TextEncoder().encode(path).byteLength > PRIVATE_SCRIPT_ARG_MAX_BYTES
	) {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "private script path exceeds the process argument limit",
				retryable: false,
			},
		};
	}
	const written = await filesystem.writeFileAtomically({
		root: runDirectory,
		path: relativePath,
		bytes,
		mode: PRIVATE_SCRIPT_MODE,
	});
	if (!written.ok) return written;
	return { ok: true, value: { path, relativePath } };
}

/** Write a private script, then pass only its short path and optional stdin to a child. */
export async function runPrivateShellScript(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	process: Pick<ProcessPort, "run">,
	request: RunPrivateShellScriptRequest,
): Promise<Result<ProcessResult>> {
	const file = await writePrivateScript(
		filesystem,
		request.runDirectory,
		request.script,
	);
	if (!file.ok) return file;
	const processRequest: ProcessRequest = {
		argv: ["sh", file.value.path],
		cwd: request.workingDirectory,
		env: request.environment,
		stdin: request.stdin?.slice() ?? new Uint8Array(),
		timeoutMilliseconds: request.timeoutMilliseconds,
		outputLimitBytes: request.outputLimitBytes,
	};
	return process.run(processRequest);
}
