import { isAbsolute, posix } from "node:path";
import type { PortError, Result } from "../contracts/errors";
import type { FileSystemPort } from "../contracts/ports";
import { FILESYSTEM_MAX_RESPONSE_BYTES } from "../fs/read";
import { isValidIntentSlug } from "../intent/parse";
import type {
	AcceptanceAdapter,
	AdapterRunResult,
	RunAcceptanceTestRequest,
	StageAcceptanceTestRequest,
	StagedAcceptanceTest,
} from "./interface";

export const COMMAND_ADAPTER_OUTPUT_LIMIT_BYTES = 512 * 1024;
const ACCEPTANCE_TEST_MAX_BYTES = FILESYSTEM_MAX_RESPONSE_BYTES - 1;
const MAX_PATH_BYTES = 4096;
const MAX_ARG_BYTES = 4096;

export interface CommandAdapterOptions {
	readonly extension: string;
	readonly candidateDirectory: string;
	readonly run: readonly string[];
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function byteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function validAbsolutePath(value: string): boolean {
	return (
		value.length > 0 &&
		isAbsolute(value) &&
		!value.includes("\0") &&
		byteLength(value) <= MAX_PATH_BYTES
	);
}

function validRelativeDirectory(value: string): boolean {
	if (
		value.length === 0 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		/[\0\r\n]/u.test(value) ||
		byteLength(value) > MAX_PATH_BYTES
	)
		return false;
	if (value === ".") return true;
	const components = value.split("/");
	return components.every(
		(component) =>
			component.length > 0 &&
			component !== "." &&
			component !== ".." &&
			component !== ".git",
	);
}

function validExtension(value: string): boolean {
	return (
		/^\.[A-Za-z0-9._-]+$/u.test(value) &&
		!value.endsWith(".") &&
		byteLength(value) <= 128
	);
}

function validArg(value: string, index: number): PortError | null {
	if (
		value.length === 0 ||
		value.includes("\0") ||
		byteLength(value) > MAX_ARG_BYTES
	)
		return portError(
			"invalid_input",
			`Command acceptance argv[${index}] must contain 1 through ${MAX_ARG_BYTES} UTF-8 bytes without NUL.`,
		);
	return null;
}

function validateOptions(options: CommandAdapterOptions): PortError | null {
	if (!validExtension(options.extension))
		return portError(
			"invalid_input",
			"Command acceptance extension is invalid.",
		);
	if (!validRelativeDirectory(options.candidateDirectory))
		return portError(
			"invalid_input",
			"Command acceptance candidate_dir must be a bounded relative path.",
		);
	if (!Array.isArray(options.run) || options.run.length === 0)
		return portError(
			"invalid_input",
			"Command acceptance run must contain an executable argv element.",
		);
	for (let index = 0; index < options.run.length; index += 1) {
		const argument = options.run[index];
		if (argument === undefined)
			return portError("invalid_input", "Command acceptance argv is sparse.");
		const invalid = validArg(argument, index);
		if (invalid !== null) return invalid;
	}
	return null;
}

function pathForSlug(
	slug: string,
	extension: string,
	directory: string,
): string {
	if (!isValidIntentSlug(slug))
		throw new TypeError("Acceptance slug is invalid.");
	return directory === "."
		? `${slug}${extension}`
		: posix.join(directory, `${slug}${extension}`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function sourceAtWorkdir(
	filesystem: Pick<FileSystemPort, "readFile">,
	workdir: string,
	path: string,
): Promise<Result<Uint8Array>> {
	return filesystem.readFile({
		root: workdir,
		path,
		maxBytes: ACCEPTANCE_TEST_MAX_BYTES,
	});
}

async function stageAcceptanceTest(
	adapter: Pick<AcceptanceAdapter, "sourcePath" | "candidatePath">,
	request: StageAcceptanceTestRequest,
): Promise<Result<StagedAcceptanceTest>> {
	if (
		!validAbsolutePath(request.sourceRoot) ||
		!validAbsolutePath(request.workdir)
	)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Acceptance source and worktree roots must be absolute bounded paths.",
			),
		};
	let sourcePath: string;
	let candidatePath: string;
	try {
		sourcePath = adapter.sourcePath(request.slug);
		candidatePath = adapter.candidatePath(request.slug);
	} catch (cause) {
		return {
			ok: false,
			error: portError(
				"invalid_input",
				cause instanceof Error ? cause.message : "Acceptance slug is invalid.",
			),
		};
	}
	if (sourcePath === candidatePath)
		return {
			ok: false,
			error: portError(
				"invalid_input",
				"Acceptance source and candidate paths must be distinct.",
			),
		};

	const source = await request.filesystem.readFile({
		root: request.sourceRoot,
		path: sourcePath,
		maxBytes: ACCEPTANCE_TEST_MAX_BYTES,
	});
	if (!source.ok) return source;

	const candidate = await sourceAtWorkdir(
		request.filesystem,
		request.workdir,
		candidatePath,
	);
	if (candidate.ok)
		return {
			ok: false,
			error: portError(
				"conflict",
				`Staged acceptance path is already occupied: ${candidatePath}.`,
			),
		};
	if (candidate.error.code !== "not_found") {
		if (
			candidate.error.code === "invalid_input" ||
			candidate.error.code === "permission_denied"
		)
			return {
				ok: false,
				error: portError(
					"conflict",
					`Staged acceptance path is occupied or unsafe: ${candidatePath}.`,
				),
			};
		return candidate;
	}

	const sourceCopy = await sourceAtWorkdir(
		request.filesystem,
		request.workdir,
		sourcePath,
	);
	if (sourceCopy.ok && !sameBytes(sourceCopy.value, source.value))
		return {
			ok: false,
			error: portError(
				"conflict",
				"Acceptance source in the candidate worktree differs from the approved source.",
			),
		};
	if (!sourceCopy.ok && sourceCopy.error.code !== "not_found")
		return sourceCopy;

	const written = await request.filesystem.writeFileAtomically({
		root: request.workdir,
		path: candidatePath,
		bytes: source.value,
		mode: 0o600,
	});
	if (!written.ok) return written;

	if (sourceCopy.ok) {
		const removed = await request.filesystem.removeFile(
			request.workdir,
			sourcePath,
		);
		if (!removed.ok && removed.error.code !== "not_found") {
			const rollback = await request.filesystem.removeFile(
				request.workdir,
				candidatePath,
			);
			return {
				ok: false,
				error: portError(
					removed.error.code,
					rollback.ok
						? `Could not remove the staged source copy: ${removed.error.message}`
						: `Could not remove the staged source copy or roll back the candidate test: ${removed.error.message}; ${rollback.error.message}`,
					removed.error.retryable || !rollback.ok,
				),
			};
		}
	}

	return {
		ok: true,
		value: {
			sourcePath,
			candidatePath,
			bytesWritten: source.value.byteLength,
		},
	};
}

export function createCommandAdapter(
	options: CommandAdapterOptions,
): Result<AcceptanceAdapter> {
	const invalid = validateOptions(options);
	if (invalid !== null) return { ok: false, error: invalid };
	const runArgv = [...options.run];
	const candidateDirectory =
		options.candidateDirectory === "."
			? "."
			: posix.normalize(options.candidateDirectory);
	const extension = options.extension;
	const adapter: AcceptanceAdapter = {
		name: "command",
		sourcePath(slug) {
			return pathForSlug(slug, extension, ".kogen/acceptance");
		},
		candidatePath(slug) {
			return pathForSlug(slug, extension, candidateDirectory);
		},
		stage(request) {
			return stageAcceptanceTest(adapter, request);
		},
		async run(
			request: RunAcceptanceTestRequest,
		): Promise<Result<AdapterRunResult>> {
			if (!isValidIntentSlug(request.slug))
				return {
					ok: false,
					error: portError("invalid_input", "Acceptance slug is invalid."),
				};
			if (
				!validAbsolutePath(request.workdir) ||
				!validAbsolutePath(request.reportPath)
			)
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Acceptance worktree and report paths must be absolute bounded paths.",
					),
				};
			if (
				!Number.isSafeInteger(request.timeoutMilliseconds) ||
				request.timeoutMilliseconds < 1
			)
				return {
					ok: false,
					error: portError(
						"invalid_input",
						"Acceptance timeout must be a positive safe integer.",
					),
				};
			const candidatePath = adapter.candidatePath(request.slug);
			const argv = runArgv.map((argument) =>
				argument.replaceAll("{path}", candidatePath),
			);
			for (let index = 0; index < argv.length; index += 1) {
				const argument = argv[index];
				if (argument === undefined || validArg(argument, index) !== null)
					return {
						ok: false,
						error: portError(
							"invalid_input",
							`Expanded command acceptance argv[${index}] is invalid.`,
						),
					};
			}
			const environment: Record<string, string> = Object.create(null);
			for (const [name, value] of Object.entries(request.environment))
				environment[name] = value;
			environment.KOGEN_LEDGER_REPORT = request.reportPath;
			environment.KOGEN_INTENT_SLUG = request.slug;

			const result = await request.process.run({
				argv,
				cwd: request.workdir,
				env: environment,
				timeoutMilliseconds: request.timeoutMilliseconds,
				outputLimitBytes: COMMAND_ADAPTER_OUTPUT_LIMIT_BYTES,
			});
			if (!result.ok) return result;
			return {
				ok: true,
				value: {
					exitStatus: result.value.exitCode,
					timedOut: result.value.timedOut,
					log: {
						stdout: result.value.stdout.slice(),
						stderr: result.value.stderr.slice(),
					},
				},
			};
		},
	};
	return { ok: true, value: adapter };
}
