import { ChildEnvironmentError } from "../../core/src/process/environment";
import { HostBridgeError } from "../../core/src/process/host";
import { LinuxSandboxError } from "../../core/src/sandbox/linux";
import type { CliOutput } from "./output";

/** Only recognized host and environment failures are operational errors. */
export function classifyCliException(error: unknown): CliOutput {
	const operational =
		error instanceof HostBridgeError ||
		error instanceof ChildEnvironmentError ||
		error instanceof LinuxSandboxError;
	const message = (error instanceof Error ? error.message : String(error))
		.replace(/[\r\n\0]+/gu, " ")
		.trim();
	return {
		stdout: `${operational ? "environment/host_unavailable" : "controller/internal_error"}: ${message}\n`,
		stderr: "",
		exitCode: operational ? 3 : 70,
	};
}
