import { isAbsolute, join } from "node:path";
import type { AdapterLog } from "../adapters/interface";
import type { PortError, Result } from "../contracts/errors";
import type {
	FileSystemPort,
	ProcessPort,
	ProcessResult,
} from "../contracts/ports";
import type { CheckSpec } from "../project/schema";

export const GATE_RAW_LOG_LIMIT_BYTES = 512 * 1024;

export interface GateTreeSnapshot {
	readonly identity: string;
	/** Opaque handle to the exact filesystem state, kept by the tree adapter. */
	readonly restoreToken: string;
}

/** The caller binds these operations to the trusted base-relative workspace snapshotter. */
export interface GateTreePort {
	snapshot(): Promise<Result<GateTreeSnapshot>>;
	changedPaths(
		before: GateTreeSnapshot,
		after: GateTreeSnapshot,
	): Promise<Result<readonly string[]>>;
	restore(snapshot: GateTreeSnapshot): Promise<Result<void>>;
}

export interface GateRawLog extends AdapterLog {
	readonly step: string;
	readonly stdoutPath: string;
	readonly stderrPath: string;
}

export interface GateCommandObservation {
	readonly step: string;
	readonly index: number;
	readonly argv: readonly string[];
	readonly exitStatus: number | null;
	readonly timedOut: boolean;
	readonly log: GateRawLog;
	readonly error?: PortError;
}

export interface RunGateCommandRequest {
	readonly process: Pick<ProcessPort, "run">;
	readonly filesystem: Pick<FileSystemPort, "writeFileAtomically">;
	readonly workdir: string;
	readonly runDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly step: string;
	readonly index: number;
	readonly argv: readonly string[];
	readonly timeoutMilliseconds: number;
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function encodedMessage(message: string): Uint8Array {
	return new TextEncoder().encode(message);
}

function validRequest(request: RunGateCommandRequest): PortError | null {
	if (
		!isAbsolute(request.workdir) ||
		!isAbsolute(request.runDirectory) ||
		request.workdir.includes("\0") ||
		request.runDirectory.includes("\0")
	)
		return portError(
			"invalid_input",
			"Gate worktree and run directory must be absolute paths.",
		);
	if (
		!Number.isSafeInteger(request.index) ||
		request.index < 1 ||
		request.index > 999_999
	)
		return portError("invalid_input", "Gate log index is invalid.");
	if (
		request.step.length === 0 ||
		request.step.includes("\0") ||
		!Array.isArray(request.argv) ||
		request.argv.length === 0 ||
		request.argv.some(
			(argument) => argument.length === 0 || argument.includes("\0"),
		)
	)
		return portError("invalid_input", "Gate command is invalid.");
	if (
		!Number.isSafeInteger(request.timeoutMilliseconds) ||
		request.timeoutMilliseconds < 1
	)
		return portError(
			"invalid_input",
			"Gate timeout must be a positive integer.",
		);
	return null;
}

export function gateLogRelativePaths(index: number): {
	readonly stdout: string;
	readonly stderr: string;
} {
	const stem = `gate-${String(index).padStart(6, "0")}`;
	return { stdout: `${stem}.stdout.log`, stderr: `${stem}.stderr.log` };
}

export async function persistGateRawLog(
	filesystem: Pick<FileSystemPort, "writeFileAtomically">,
	runDirectory: string,
	index: number,
	step: string,
	log: AdapterLog,
): Promise<Result<GateRawLog>> {
	const relativePaths = gateLogRelativePaths(index);
	const stdoutPath = join(runDirectory, relativePaths.stdout);
	const stderrPath = join(runDirectory, relativePaths.stderr);
	const stdoutWrite = await filesystem.writeFileAtomically({
		root: runDirectory,
		path: relativePaths.stdout,
		bytes: log.stdout.slice(),
		mode: 0o600,
	});
	if (!stdoutWrite.ok) return stdoutWrite;
	const stderrWrite = await filesystem.writeFileAtomically({
		root: runDirectory,
		path: relativePaths.stderr,
		bytes: log.stderr.slice(),
		mode: 0o600,
	});
	if (!stderrWrite.ok) return stderrWrite;
	return {
		ok: true,
		value: {
			step,
			stdout: log.stdout.slice(),
			stderr: log.stderr.slice(),
			stdoutPath,
			stderrPath,
		},
	};
}

/** Run one configured fix/check command once and keep the captured streams intact. */
export async function runGateCommand(
	request: RunGateCommandRequest,
): Promise<Result<GateCommandObservation>> {
	const invalid = validRequest(request);
	if (invalid !== null) return { ok: false, error: invalid };
	let execution: Result<ProcessResult>;
	try {
		execution = await request.process.run({
			argv: [...request.argv],
			cwd: request.workdir,
			env: request.environment,
			timeoutMilliseconds: request.timeoutMilliseconds,
			outputLimitBytes: GATE_RAW_LOG_LIMIT_BYTES,
		});
	} catch (cause) {
		execution = {
			ok: false,
			error: portError(
				"unavailable",
				cause instanceof Error
					? `Gate process could not be supervised: ${cause.message}`
					: "Gate process could not be supervised.",
				true,
			),
		};
	}
	const fallbackError = execution.ok ? undefined : execution.error;
	const log: AdapterLog = execution.ok
		? {
				stdout: execution.value.stdout.slice(),
				stderr: execution.value.stderr.slice(),
			}
		: {
				stdout: new Uint8Array(),
				stderr: encodedMessage(execution.error.message),
			};
	const persisted = await persistGateRawLog(
		request.filesystem,
		request.runDirectory,
		request.index,
		request.step,
		log,
	);
	if (!persisted.ok) return persisted;
	return {
		ok: true,
		value: {
			step: request.step,
			index: request.index,
			argv: [...request.argv],
			exitStatus: execution.ok ? execution.value.exitCode : null,
			timedOut: execution.ok
				? execution.value.timedOut
				: execution.error.code === "timeout",
			log: persisted.value,
			...(fallbackError === undefined ? {} : { error: fallbackError }),
		},
	};
}

export interface RunFixesRequest {
	readonly process: Pick<ProcessPort, "run">;
	readonly filesystem: Pick<FileSystemPort, "writeFileAtomically">;
	readonly workdir: string;
	readonly runDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly fixes: readonly CheckSpec[];
	readonly nextLogIndex: number;
}

export interface RunFixesResult {
	readonly commands: readonly GateCommandObservation[];
	readonly nextLogIndex: number;
}

/** Fix commands run once, in project order, before the verification tree is captured. */
export async function runFixes(
	request: RunFixesRequest,
): Promise<Result<RunFixesResult>> {
	const commands: GateCommandObservation[] = [];
	let index = request.nextLogIndex;
	for (const fix of request.fixes) {
		const command = await runGateCommand({
			process: request.process,
			filesystem: request.filesystem,
			workdir: request.workdir,
			runDirectory: request.runDirectory,
			environment: request.environment,
			step: `fix/${fix.name}`,
			index,
			argv: fix.argv,
			timeoutMilliseconds: fix.timeoutMs,
		});
		if (!command.ok) return command;
		commands.push(command.value);
		index += 1;
	}
	return { ok: true, value: { commands, nextLogIndex: index } };
}
