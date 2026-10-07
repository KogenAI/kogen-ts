import type { PortError, Result } from "../contracts/errors";
import type {
	GitPort,
	GitRequest,
	ProcessPort,
	ProcessRequest,
	ProcessResult,
} from "../contracts/ports";
import { createAllowlistedBaseEnvironment } from "../process/environment";

export const GIT_DEFAULT_TIMEOUT_MS = 30_000;
export const GIT_MAX_TIMEOUT_MS = 900_000;
export const GIT_DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const GIT_MAX_OUTPUT_LIMIT_BYTES = 900 * 1024;
export const GIT_MAX_STDIN_BYTES = 900 * 1024;
export const GIT_MAX_ARG_BYTES = 4096;
// Leave room under ProcessSupervisor's 256 element cap for the executable and
// Git's invariant safety options.
export const GIT_MAX_ARGS = 235;

export type GitConfigurationMode = "private" | "public";

export interface GitCommandOptions {
	readonly executable?: string;
	readonly environment?: Readonly<Record<string, string>>;
	readonly configuration?: GitConfigurationMode;
}

export interface GitCommandRequest {
	readonly repository: string;
	readonly argv: readonly string[];
	readonly stdin?: Uint8Array;
	readonly timeoutMilliseconds?: number;
	readonly outputLimitBytes?: number;
}

const REDIRECTING_GIT_ENVIRONMENT = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_COMMON_DIR",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
	"GIT_SHALLOW_FILE",
	"GIT_REPLACE_REF_BASE",
	"GIT_GRAFT_FILE",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_ATTR_NOSYSTEM",
	"GIT_TEMPLATE_DIR",
	"GIT_PAGER",
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
	"GIT_TERMINAL_PROMPT",
	"GIT_ASKPASS",
	"GIT_SSH_COMMAND",
	"GIT_TRACE",
	"GIT_TRACE_SETUP",
	"GIT_TRACE_PACKET",
	"GIT_TRACE_PERFORMANCE",
	"GIT_TRACE_PACK_ACCESS",
	"GIT_TRACE_CURL",
	"GIT_TRACE_REDACT",
	"GIT_TRACE2",
	"GIT_TRACE2_EVENT",
	"GIT_TRACE2_PERF",
]);

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function utf8Length(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function validateArgument(value: string, index: number): PortError | null {
	if (value.includes("\0"))
		return error("invalid_input", "Git arguments cannot contain NUL");
	if (utf8Length(value) === 0 || utf8Length(value) > GIT_MAX_ARG_BYTES) {
		return error(
			"invalid_input",
			"Git arguments must contain 1 through " +
				GIT_MAX_ARG_BYTES +
				" UTF-8 bytes (argument " +
				index +
				")",
		);
	}
	return null;
}

function isConfigInjection(name: string): boolean {
	return (
		name.startsWith("GIT_CONFIG_KEY_") ||
		name.startsWith("GIT_CONFIG_VALUE_") ||
		name.startsWith("GIT_TRACE2_") ||
		name.startsWith("GIT_TRACE_CURL_")
	);
}

/**
 * Keep the caller's base environment while removing variables that can redirect
 * repository discovery, indexes, objects, config parsing, hooks, or diagnostics.
 * Public Git calls retain only GIT_CONFIG_GLOBAL so user identity/signing work.
 */
export function buildGitEnvironment(
	base: Readonly<Record<string, string | undefined>> = process.env,
	configuration: GitConfigurationMode = "private",
): Record<string, string> {
	const environment: Record<string, string> = Object.create(null);
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (REDIRECTING_GIT_ENVIRONMENT.has(name) || isConfigInjection(name))
			continue;
		if (
			name.startsWith("GIT_") &&
			name !== "GIT_CONFIG_GLOBAL" &&
			!(
				configuration === "public" &&
				[
					"GIT_AUTHOR_NAME",
					"GIT_AUTHOR_EMAIL",
					"GIT_AUTHOR_DATE",
					"GIT_COMMITTER_NAME",
					"GIT_COMMITTER_EMAIL",
					"GIT_COMMITTER_DATE",
				].includes(name)
			)
		)
			continue;
		environment[name] = value;
	}
	environment.GIT_CONFIG_NOSYSTEM = "1";
	environment.GIT_CONFIG_SYSTEM = "/dev/null";
	environment.GIT_ATTR_NOSYSTEM = "1";
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_PAGER = "cat";
	environment.GIT_EDITOR = "/bin/false";
	environment.GIT_SEQUENCE_EDITOR = "/bin/false";
	if (configuration === "private") environment.GIT_CONFIG_GLOBAL = "/dev/null";
	return environment;
}

function safetyArguments(configuration: GitConfigurationMode): string[] {
	const args = [
		"--no-pager",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.pager=cat",
		"-c",
		"color.ui=false",
		"-c",
		"gc.auto=0",
		"-c",
		"maintenance.auto=false",
		"-c",
		"diff.external=",
	];
	if (configuration === "private") {
		args.push(
			"-c",
			"core.attributesFile=/dev/null",
			"-c",
			"core.excludesFile=/dev/null",
		);
	}
	return args;
}

const DIFF_COMMANDS = new Set([
	"diff",
	"diff-tree",
	"log",
	"show",
	"whatchanged",
]);

function commandArguments(argv: readonly string[]): Result<string[]> {
	const command = argv[0];
	const args = [...argv];
	if (command === "commit") {
		if (args.includes("--verify")) {
			return {
				ok: false,
				error: error("invalid_input", "Git commits cannot re-enable hooks"),
			};
		}
		args.splice(1, 0, "--no-verify");
	}
	if (command !== undefined && DIFF_COMMANDS.has(command)) {
		if (args.includes("--textconv") || args.includes("--ext-diff")) {
			return {
				ok: false,
				error: error(
					"invalid_input",
					"Git textconv and external diff are disabled",
				),
			};
		}
		args.splice(1, 0, "--no-textconv", "--no-ext-diff");
	}
	return { ok: true, value: args };
}

function validateRequest(
	request: GitCommandRequest,
	options: GitCommandOptions,
): Result<ProcessRequest> {
	if (
		request.repository.length === 0 ||
		request.repository.includes("\0") ||
		utf8Length(request.repository) > 64 * 1024
	) {
		return {
			ok: false,
			error: error("invalid_input", "Git repository path is invalid"),
		};
	}
	if (!Array.isArray(request.argv) || request.argv.length === 0) {
		return {
			ok: false,
			error: error("invalid_input", "Git argv must contain a subcommand"),
		};
	}
	if (request.argv.length > GIT_MAX_ARGS) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				`Git argv cannot exceed ${GIT_MAX_ARGS} arguments`,
			),
		};
	}
	for (let index = 0; index < request.argv.length; index += 1) {
		const argument = request.argv[index];
		if (argument === undefined) continue;
		const problem = validateArgument(argument, index);
		if (problem) return { ok: false, error: problem };
	}
	const commandArgv = commandArguments(request.argv);
	if (!commandArgv.ok) return commandArgv;
	const executable = options.executable ?? "git";
	const executableError = validateArgument(executable, -1);
	if (executableError)
		return {
			ok: false,
			error: error("invalid_input", "Git executable is invalid"),
		};
	const timeoutMilliseconds =
		request.timeoutMilliseconds ?? GIT_DEFAULT_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMilliseconds) ||
		timeoutMilliseconds < 1 ||
		timeoutMilliseconds > GIT_MAX_TIMEOUT_MS
	) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Git timeout must be an integer from 1 through " +
					GIT_MAX_TIMEOUT_MS +
					" milliseconds",
			),
		};
	}
	const outputLimitBytes =
		request.outputLimitBytes ?? GIT_DEFAULT_OUTPUT_LIMIT_BYTES;
	if (
		!Number.isSafeInteger(outputLimitBytes) ||
		outputLimitBytes < 0 ||
		outputLimitBytes > GIT_MAX_OUTPUT_LIMIT_BYTES
	) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Git output limit must be an integer from 0 through " +
					GIT_MAX_OUTPUT_LIMIT_BYTES +
					" bytes",
			),
		};
	}
	const stdin = request.stdin?.slice();
	if (stdin && stdin.byteLength > GIT_MAX_STDIN_BYTES) {
		return {
			ok: false,
			error: error(
				"invalid_input",
				`Git stdin exceeds ${GIT_MAX_STDIN_BYTES} bytes`,
			),
		};
	}
	return {
		ok: true,
		value: {
			argv: [
				executable,
				...safetyArguments(options.configuration ?? "private"),
				...commandArgv.value,
			],
			cwd: request.repository,
			env: buildGitEnvironment(
				createAllowlistedBaseEnvironment(options.environment ?? process.env),
				options.configuration ?? "private",
			),
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds,
			outputLimitBytes,
		},
	};
}

/**
 * Run one argv-only Git process through the supplied bounded ProcessPort. This
 * low-level call does not select trusted metadata; workspace work must use a
 * PrivateGitRepository so the workspace's own .git directory is never read.
 */
export async function runGitCommand(
	process: Pick<ProcessPort, "run">,
	request: GitCommandRequest,
	options: GitCommandOptions = {},
): Promise<Result<ProcessResult>> {
	const checked = validateRequest(request, options);
	if (!checked.ok) return checked;
	let result: Result<ProcessResult>;
	try {
		result = await process.run(checked.value);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unknown",
				message: "Git process port failed",
				retryable: true,
				cause,
			},
		};
	}
	if (!result.ok) return result;
	if (
		result.value.stdout.byteLength + result.value.stderr.byteLength >
		checked.value.outputLimitBytes
	) {
		return {
			ok: false,
			error: error(
				"unknown",
				"Git supervisor returned output beyond the requested bound",
				true,
			),
		};
	}
	return result;
}

/**
 * Adapt the low-level process-backed runner to the shared Git effect port.
 * Workspace calls still need PrivateGitRepository's explicit private git-dir.
 */
export function createGitPort(
	process: Pick<ProcessPort, "run">,
	options: GitCommandOptions = {},
): GitPort {
	return {
		command(request: GitRequest) {
			const commandRequest: GitCommandRequest = {
				repository: request.repository,
				argv: request.argv,
				...(request.stdin === undefined ? {} : { stdin: request.stdin }),
				timeoutMilliseconds: request.timeoutMilliseconds,
				outputLimitBytes: request.outputLimitBytes,
			};
			return runGitCommand(process, commandRequest, options);
		},
	};
}

/**
 * Public identity/signing/ref operations retain user's global config. Use this
 * with trusted public repository work, never to inspect a model-writable tree.
 */
export function createPublicGitPort(
	process: Pick<ProcessPort, "run">,
	options: Omit<GitCommandOptions, "configuration"> = {},
): GitPort {
	return createGitPort(process, { ...options, configuration: "public" });
}
