import { dirname, isAbsolute, resolve } from "node:path";
import type { PortError, Result } from "../contracts/errors";
import type { ProcessPort, ProcessResult } from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
	type GitCommandOptions,
	runGitCommand,
} from "../git/command";

export interface CloneWorkspaceRequest {
	readonly sourceRepository: string;
	/** The destination must not already exist; Git creates it as a fresh clone. */
	readonly destination: string;
	/** Saved build-base object id, not the source checkout's current HEAD. */
	readonly baseCommit: string;
	readonly executable?: string;
	readonly environment?: Readonly<Record<string, string>>;
}

export interface ClonedWorkspace {
	readonly path: string;
	readonly baseCommit: string;
	readonly headCommit: string;
	readonly objectFormat: "sha1" | "sha256";
}

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
): PortError {
	return { code, message, retryable };
}

function validateRequest(request: CloneWorkspaceRequest): PortError | null {
	for (const [label, path] of [
		["source repository", request.sourceRepository],
		["workspace destination", request.destination],
	] as const) {
		if (
			path.length === 0 ||
			!isAbsolute(path) ||
			path.includes("\0") ||
			new TextEncoder().encode(path).byteLength > 4096
		)
			return error(
				"invalid_input",
				`${label} path must be absolute and bounded.`,
			);
	}
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.baseCommit))
		return error("invalid_input", "Build base must be a full Git object id.");
	if (resolve(request.sourceRepository) === resolve(request.destination))
		return error(
			"invalid_input",
			"Workspace destination must differ from source.",
		);
	return null;
}

function commandError(
	result: Result<ProcessResult>,
	label: string,
): Result<never> | null {
	if (!result.ok) return result;
	if (result.value.timedOut)
		return {
			ok: false,
			error: error("timeout", `Git ${label} timed out.`, true),
		};
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Git ${label} failed with exit ${result.value.exitCode}.`,
				true,
			),
		};
	return null;
}

function decodeObjectId(
	bytes: Uint8Array,
	expectedLength: number,
): string | null {
	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
	} catch {
		return null;
	}
	return value.length === expectedLength && /^[0-9a-f]+$/.test(value)
		? value
		: null;
}

/**
 * Make an independent local clone without hardlinked Git objects, then check
 * out the recorded base detached. The caller supplies a fresh destination and
 * an existing parent directory.
 */
export async function cloneFreshWorkspace(
	process: Pick<ProcessPort, "run">,
	request: CloneWorkspaceRequest,
): Promise<Result<ClonedWorkspace>> {
	const invalid = validateRequest(request);
	if (invalid !== null) return { ok: false, error: invalid };
	const options: GitCommandOptions = {
		...(request.executable === undefined
			? {}
			: { executable: request.executable }),
		...(request.environment === undefined
			? {}
			: { environment: request.environment }),
		configuration: "private",
	};
	const cloned = await runGitCommand(
		process,
		{
			repository: dirname(request.destination),
			argv: [
				"clone",
				"--local",
				"--no-hardlinks",
				"--no-checkout",
				"--no-tags",
				"--no-recurse-submodules",
				"--template=/dev/null",
				"--config=core.hooksPath=/dev/null",
				"--config=core.fsmonitor=false",
				"--config=core.excludesFile=/dev/null",
				"--config=core.attributesFile=/dev/null",
				"--config=core.autocrlf=false",
				"--config=commit.gpgsign=false",
				"--config=tag.gpgsign=false",
				request.sourceRepository,
				request.destination,
			],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES,
		},
		options,
	);
	const cloneFailure = commandError(cloned, "local clone");
	if (cloneFailure !== null) return cloneFailure;
	if (!cloned.ok) return cloned;

	const formatResult = await runGitCommand(
		process,
		{
			repository: request.destination,
			argv: ["rev-parse", "--show-object-format=storage"],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 64,
		},
		options,
	);
	const formatFailure = commandError(formatResult, "object-format probe");
	if (formatFailure !== null) return formatFailure;
	if (!formatResult.ok) return formatResult;
	let format: "sha1" | "sha256";
	try {
		const value = new TextDecoder("utf-8", { fatal: true })
			.decode(formatResult.value.stdout)
			.trim();
		if (value !== "sha1" && value !== "sha256") throw new Error();
		format = value;
	} catch {
		return {
			ok: false,
			error: error("unavailable", "Git returned an unsupported object format."),
		};
	}
	if (request.baseCommit.length !== (format === "sha1" ? 40 : 64))
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Build base does not match the repository format.",
			),
		};

	const fetched = await runGitCommand(
		process,
		{
			repository: request.destination,
			argv: [
				"fetch",
				"--no-tags",
				"--no-recurse-submodules",
				request.sourceRepository,
				request.baseCommit,
			],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 4096,
		},
		options,
	);
	const fetchFailure = commandError(fetched, "saved-base fetch");
	if (fetchFailure !== null) return fetchFailure;
	if (!fetched.ok) return fetched;

	const checkout = await runGitCommand(
		process,
		{
			repository: request.destination,
			argv: ["checkout", "--force", "--detach", request.baseCommit],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 4096,
		},
		options,
	);
	const checkoutFailure = commandError(checkout, "saved-base checkout");
	if (checkoutFailure !== null) return checkoutFailure;
	if (!checkout.ok) return checkout;

	const head = await runGitCommand(
		process,
		{
			repository: request.destination,
			argv: ["rev-parse", "--verify", "HEAD"],
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: 128,
		},
		options,
	);
	const headFailure = commandError(head, "saved-base verification");
	if (headFailure !== null) return headFailure;
	if (!head.ok) return head;
	const headCommit = decodeObjectId(
		head.value.stdout,
		format === "sha1" ? 40 : 64,
	);
	if (headCommit !== request.baseCommit)
		return {
			ok: false,
			error: error(
				"conflict",
				"Fresh workspace did not check out the saved base.",
			),
		};
	return {
		ok: true,
		value: {
			path: request.destination,
			baseCommit: request.baseCommit,
			headCommit,
			objectFormat: format,
		},
	};
}
