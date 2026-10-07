import type { FileSystemPort, ProcessPort } from "../../contracts/ports";
import { runPrivateShellScript } from "../../process/script";
import type { AdditionalToolHandler } from "./dispatch";
import {
	budgetToolOutput,
	processOutputText,
	type ToolOutputContext,
} from "./output";

export const SHELL_TOOL_TIMEOUT_MS = 120_000;
export const SHELL_TOOL_PROCESS_OUTPUT_LIMIT_BYTES = 1_000_000;
export const PROCESS_LOG_UNAVAILABLE_NOTICE =
	"[process log unavailable; captured tail may be incomplete]\n";
const MERGED_STDOUT_SCRIPT_PREFIX = "exec 2>&1\n";

export interface ShellToolContext extends ToolOutputContext {
	readonly workspaceRoot: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly filesystem: Pick<FileSystemPort, "readFile" | "writeFileAtomically">;
	readonly process: Pick<ProcessPort, "run">;
	/** Test seam used by the conformance harness; omitted production-wide. */
	readonly timeoutScale?: number;
}

export function scaleShellToolTimeout(scale = 1): number {
	if (!Number.isFinite(scale) || scale <= 0)
		throw new RangeError("shell timeout scale must be positive and finite");
	return Math.max(1, Math.round(SHELL_TOOL_TIMEOUT_MS * scale));
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(left.byteLength + right.byteLength);
	bytes.set(left);
	bytes.set(right, left.byteLength);
	return bytes;
}

function exitStatus(exitCode: number | null, signal: string | null): string {
	if (exitCode !== null) return `exit ${exitCode}`;
	if (signal !== null && /^\d+$/.test(signal)) {
		const signalNumber = Number(signal);
		if (Number.isSafeInteger(signalNumber) && signalNumber > 0)
			return `exit ${128 + signalNumber}`;
	}
	return "exit unknown";
}

function normalShellResult(
	bytes: Uint8Array,
	exitCode: number | null,
	signal: string | null,
): string {
	const output = processOutputText(bytes);
	const separator = output.length === 0 || /[\r\n]$/.test(output) ? "" : "\n";
	return `${output}${separator}${exitStatus(exitCode, signal)}\n`;
}

/** Execute a model command from a private 0600 run-directory script. */
export async function runShellTool(
	context: ShellToolContext,
	argumentsValue: Readonly<Record<string, unknown>>,
): Promise<string> {
	const command = argumentsValue.cmd;
	if (typeof command !== "string")
		return "ERROR (invalid_arguments): Tool arguments do not match the schema.";
	let processOutput: string;
	const result = await runPrivateShellScript(
		context.filesystem,
		context.process,
		{
			runDirectory: context.runDirectory,
			workingDirectory: context.workspaceRoot,
			script: `${MERGED_STDOUT_SCRIPT_PREFIX}${command}`,
			environment: context.environment,
			timeoutMilliseconds: scaleShellToolTimeout(context.timeoutScale),
			outputLimitBytes: SHELL_TOOL_PROCESS_OUTPUT_LIMIT_BYTES,
		},
	);
	if (!result.ok) {
		processOutput = PROCESS_LOG_UNAVAILABLE_NOTICE;
	} else {
		const captured = concatenate(result.value.stdout, result.value.stderr);
		processOutput = result.value.timedOut
			? `timed out after ${SHELL_TOOL_TIMEOUT_MS / 1_000} seconds\n${processOutputText(captured)}`
			: normalShellResult(captured, result.value.exitCode, result.value.signal);
	}
	return budgetToolOutput(context, processOutput);
}

export function createShellToolHandler(
	context: ShellToolContext,
): AdditionalToolHandler {
	return (argumentsValue) => runShellTool(context, argumentsValue);
}
