import type { PortError, Result } from "../contracts/errors";
import type { ProcessPort, ProcessResult } from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
	type GitCommandOptions,
	type GitCommandRequest,
	runGitCommand,
} from "./command";

export type GitObjectFormat = "sha1" | "sha256";

export interface PrivateGitRepositoryOptions {
	/** The checked-out source whose on-disk object format will be mirrored. */
	readonly sourceRepository: string;
	/** A fresh, private, already-created directory outside the model worktree. */
	readonly gitDirectory: string;
	/** Worktree to inspect; its own .git metadata is never selected. */
	readonly workTree: string;
	readonly executable?: string;
	readonly environment?: Readonly<Record<string, string>>;
}

export interface GitRepositoryCommandOptions {
	readonly stdin?: Uint8Array;
	readonly timeoutMilliseconds?: number;
	readonly outputLimitBytes?: number;
}

export interface PrivateGitRepository {
	readonly gitDirectory: string;
	readonly workTree: string;
	readonly objectFormat: GitObjectFormat;
	command(
		argv: readonly string[],
		options?: GitRepositoryCommandOptions,
	): Promise<Result<ProcessResult>>;
	hashObject(bytes: Uint8Array, write?: boolean): Promise<Result<string>>;
}

function portError(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function failedCommand(
	result: Result<ProcessResult>,
	command: string,
): Result<never> {
	if (!result.ok) return result;
	if (result.value.timedOut) {
		return {
			ok: false,
			error: portError("timeout", `Git ${command} timed out`, true),
		};
	}
	if (result.value.exitCode !== 0) {
		return {
			ok: false,
			error: portError(
				"unavailable",
				`Git ${command} failed with exit ${result.value.exitCode}`,
				true,
			),
		};
	}
	return { ok: false, error: portError("unknown", "Git command failed") };
}

function objectFormatFromResult(
	result: Result<ProcessResult>,
	command: string,
): Result<GitObjectFormat> {
	if (!result.ok) return result;
	if (result.value.timedOut || result.value.exitCode !== 0)
		return failedCommand(result, command);
	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true })
			.decode(result.value.stdout)
			.trim();
	} catch {
		return {
			ok: false,
			error: portError("unavailable", "Git returned an invalid object format"),
		};
	}
	if (value === "sha1" || value === "sha256") return { ok: true, value };
	return {
		ok: false,
		error: portError(
			"unavailable",
			"Git reported an unsupported object format",
		),
	};
}

function objectIdLength(format: GitObjectFormat): number {
	return format === "sha1" ? 40 : 64;
}

/**
 * Create an isolated Git metadata repository for worktree inspection. The
 * metadata directory must be a fresh private directory created by the caller.
 */
export async function createPrivateGitRepository(
	process: Pick<ProcessPort, "run">,
	options: PrivateGitRepositoryOptions,
): Promise<Result<PrivateGitRepository>> {
	const commandOptions: GitCommandOptions = {
		...(options.executable === undefined
			? {}
			: { executable: options.executable }),
		...(options.environment === undefined
			? {}
			: { environment: options.environment }),
		configuration: "private",
	};
	const formatResult = await runGitCommand(
		process,
		{
			repository: options.sourceRepository,
			argv: ["rev-parse", "--show-object-format=storage"],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 64,
		},
		commandOptions,
	);
	const format = objectFormatFromResult(formatResult, "object-format probe");
	if (!format.ok) return format;

	const initResult = await runGitCommand(
		process,
		{
			repository: options.gitDirectory,
			argv: [
				"init",
				"--bare",
				"--initial-branch=kogen",
				`--object-format=${format.value}`,
				"--template=/dev/null",
				".",
			],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 4096,
		},
		commandOptions,
	);
	if (!initResult.ok) return initResult;
	if (initResult.value.timedOut || initResult.value.exitCode !== 0)
		return failedCommand(initResult, "private metadata initialization");

	const repository: PrivateGitRepository = {
		gitDirectory: options.gitDirectory,
		workTree: options.workTree,
		objectFormat: format.value,
		async command(argv, command = {}) {
			const request: GitCommandRequest = {
				repository: options.workTree,
				argv: [
					`--git-dir=${options.gitDirectory}`,
					`--work-tree=${options.workTree}`,
					...argv,
				],
				...(command.stdin === undefined ? {} : { stdin: command.stdin }),
				timeoutMilliseconds:
					command.timeoutMilliseconds ?? GIT_DEFAULT_TIMEOUT_MS,
				outputLimitBytes:
					command.outputLimitBytes ?? GIT_MAX_OUTPUT_LIMIT_BYTES,
			};
			return runGitCommand(process, request, commandOptions);
		},
		async hashObject(bytes, write = false) {
			const response = await repository.command(
				["hash-object", ...(write ? ["-w"] : []), "--no-filters", "--stdin"],
				{
					stdin: bytes,
					timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
					outputLimitBytes: 128,
				},
			);
			if (!response.ok) return response;
			if (response.value.timedOut || response.value.exitCode !== 0)
				return failedCommand(response, "blob hashing");
			let objectId: string;
			try {
				objectId = new TextDecoder("utf-8", { fatal: true })
					.decode(response.value.stdout)
					.trim();
			} catch {
				return {
					ok: false,
					error: portError("unknown", "Git returned a non-text object id"),
				};
			}
			if (
				objectId.length !== objectIdLength(format.value) ||
				!/^[0-9a-f]+$/.test(objectId)
			) {
				return {
					ok: false,
					error: portError(
						"unknown",
						`Git returned an invalid ${format.value} object id (${JSON.stringify(objectId)})`,
					),
				};
			}
			return { ok: true, value: objectId };
		},
	};

	const configureResult = await repository.command(
		["config", "--local", "--replace-all", "core.bare", "false"],
		{ outputLimitBytes: 1024 },
	);
	if (!configureResult.ok) return configureResult;
	if (configureResult.value.timedOut || configureResult.value.exitCode !== 0)
		return failedCommand(configureResult, "private metadata configuration");
	for (const [key, value] of [
		["user.name", "Kogen private metadata"],
		["user.email", "kogen-private@invalid"],
		["commit.gpgsign", "false"],
		["tag.gpgsign", "false"],
	] as const) {
		const configured = await repository.command(
			["config", "--local", "--replace-all", key, value],
			{ outputLimitBytes: 1024 },
		);
		if (!configured.ok) return configured;
		if (configured.value.timedOut || configured.value.exitCode !== 0)
			return failedCommand(configured, "private metadata configuration");
	}
	return { ok: true, value: repository };
}
