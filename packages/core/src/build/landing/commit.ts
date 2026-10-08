import type { PortError, Result } from "../../contracts/errors";
import type { GitPort, ProcessResult } from "../../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../../git/command";
import type { PrivateGitRepository } from "../../git/repository";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const RUN_ID = /^[a-f0-9]{32}$/u;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export interface LandingCommitRequest {
	readonly origin: string;
	readonly runId: string;
	readonly slug: string;
	readonly title: string;
	readonly expectedParent: string;
	readonly verifiedTree: string;
	/** Private metadata that owns verifiedTree; it is only used to transfer objects. */
	readonly source?: Pick<
		PrivateGitRepository,
		"gitDirectory" | "objectFormat" | "command"
	>;
	/** This must retain the user's public identity and signing configuration. */
	readonly git: Pick<GitPort, "command">;
}

export interface LandingCommit {
	readonly commit: string;
	readonly tree: string;
	readonly parent: string;
	readonly objectFormat: "sha1" | "sha256";
	readonly transferCleanupWarning: string | null;
}

function failure(message: string, cause?: unknown): PortError {
	return {
		code: "unavailable",
		message,
		retryable: true,
		...(cause === undefined ? {} : { cause }),
	};
}

function validObjectId(value: string, length: number): boolean {
	return value.length === length && /^[a-f0-9]+$/u.test(value);
}

async function callGit(
	git: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	try {
		return await git.command({
			repository,
			argv,
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		return {
			ok: false,
			error: failure(`Git ${argv[0] ?? "command"} failed.`, cause),
		};
	}
}

async function callPrivate(
	source: Pick<PrivateGitRepository, "command">,
	argv: readonly string[],
	stdin?: Uint8Array,
): Promise<Result<ProcessResult>> {
	try {
		return await source.command(argv, {
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes: GIT_MAX_OUTPUT_LIMIT_BYTES,
		});
	} catch (cause) {
		return {
			ok: false,
			error: failure(`Private Git ${argv[0] ?? "command"} failed.`, cause),
		};
	}
}

function successfulOutput(
	result: Result<ProcessResult>,
	command: string,
): Result<string> {
	if (!result.ok) return result;
	if (result.value.timedOut || result.value.exitCode !== 0)
		return {
			ok: false,
			error: failure(
				`Git ${command} failed with exit ${String(result.value.exitCode)}.`,
			),
		};
	try {
		return { ok: true, value: DECODER.decode(result.value.stdout).trimEnd() };
	} catch (cause) {
		return {
			ok: false,
			error: failure(`Git ${command} returned invalid UTF-8.`, cause),
		};
	}
}

async function hasObject(
	git: Pick<GitPort, "command">,
	origin: string,
	objectExpression: string,
): Promise<Result<boolean>> {
	const result = await callGit(
		git,
		origin,
		["cat-file", "-e", objectExpression],
		undefined,
		1024,
	);
	if (!result.ok) return result;
	if (result.value.timedOut)
		return { ok: false, error: failure("Git object lookup timed out.") };
	if (result.value.exitCode === 0) return { ok: true, value: true };
	if (result.value.exitCode === 1 || result.value.exitCode === 128)
		return { ok: true, value: false };
	return { ok: false, error: failure("Git object lookup failed.") };
}

async function publicSigningEnabled(
	git: Pick<GitPort, "command">,
	origin: string,
): Promise<Result<boolean>> {
	const result = await callGit(
		git,
		origin,
		["config", "--bool", "--get", "commit.gpgsign"],
		undefined,
		128,
	);
	if (!result.ok) return result;
	if (result.value.timedOut)
		return {
			ok: false,
			error: failure("Git signing configuration lookup timed out."),
		};
	if (result.value.exitCode === 1 && result.value.stdout.byteLength === 0)
		return { ok: true, value: false };
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: failure("Git signing configuration lookup failed."),
		};
	const output = successfulOutput(result, "signing configuration lookup");
	if (!output.ok) return output;
	if (output.value === "true") return { ok: true, value: true };
	if (output.value === "false") return { ok: true, value: false };
	return {
		ok: false,
		error: failure("Git returned invalid signing configuration."),
	};
}

async function transferVerifiedTree(
	request: LandingCommitRequest,
	objectFormat: "sha1" | "sha256",
	objectIdLength: number,
): Promise<Result<string | null>> {
	const source = request.source;
	if (source === undefined) return { ok: true, value: null };
	if (source.objectFormat !== objectFormat)
		return {
			ok: false,
			error: failure("Candidate and origin Git object formats differ."),
		};
	const transferRef = `refs/kogen/landing-transfer/${request.runId}`;
	const zero = "0".repeat(objectIdLength);
	const seedResult = await callPrivate(
		source,
		[
			"commit-tree",
			request.verifiedTree,
			"-p",
			request.expectedParent,
			"-F",
			"-",
		],
		ENCODER.encode("Kogen private landing object transfer\n"),
	);
	const seedOutput = successfulOutput(
		seedResult,
		"private tree transfer commit",
	);
	if (!seedOutput.ok) return seedOutput;
	const seed = seedOutput.value;
	if (!validObjectId(seed, objectIdLength))
		return {
			ok: false,
			error: failure("Private Git returned an invalid transfer commit id."),
		};
	const created = await callPrivate(source, [
		"update-ref",
		transferRef,
		seed,
		zero,
	]);
	const createOutput = successfulOutput(
		created,
		"private transfer ref creation",
	);
	if (!createOutput.ok) return createOutput;
	const fetched = await callGit(
		request.git,
		request.origin,
		[
			"fetch",
			"--no-tags",
			"--no-write-fetch-head",
			"--no-recurse-submodules",
			source.gitDirectory,
			transferRef,
		],
		undefined,
		GIT_MAX_OUTPUT_LIMIT_BYTES,
	);
	const fetchOutput = successfulOutput(fetched, "verified tree transfer");
	const removed = await callPrivate(source, [
		"update-ref",
		"-d",
		transferRef,
		seed,
	]);
	const removeOutput = successfulOutput(
		removed,
		"private transfer ref cleanup",
	);
	if (!fetchOutput.ok) return fetchOutput;
	if (!removeOutput.ok)
		return {
			ok: true,
			value: `Private transfer ref ${transferRef} could not be removed: ${removeOutput.error.message}`,
		};
	return { ok: true, value: null };
}

function exactCommitHeaders(
	text: string,
	objectIdLength: number,
	parent: string,
	tree: string,
	message: string,
	signingRequired: boolean,
): boolean {
	const split = text.indexOf("\n\n");
	if (split < 0 || text.slice(split + 2) !== message) return false;
	const headers = text.slice(0, split).split("\n");
	const trees = headers.filter((line) => line.startsWith("tree "));
	const parents = headers.filter((line) => line.startsWith("parent "));
	const hasSignature = headers.some((line) =>
		/^gpgsig(?:-[^ ]+)? /u.test(line),
	);
	return (
		trees.length === 1 &&
		trees[0] === `tree ${tree}` &&
		parents.length === 1 &&
		parents[0] === `parent ${parent}` &&
		trees[0].slice(5).length === objectIdLength &&
		(!signingRequired || hasSignature)
	);
}

export async function createLandingCommit(
	request: LandingCommitRequest,
): Promise<Result<LandingCommit>> {
	if (
		!/^\/[\s\S]+$/u.test(request.origin) ||
		request.origin.includes("\0") ||
		!RUN_ID.test(request.runId) ||
		!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(request.slug) ||
		request.title.trim().length === 0 ||
		/[\r\n\0]/u.test(request.title) ||
		!OBJECT_ID.test(request.expectedParent) ||
		!OBJECT_ID.test(request.verifiedTree)
	)
		return { ok: false, error: failure("Landing commit inputs are invalid.") };
	const formatResult = await callGit(
		request.git,
		request.origin,
		["rev-parse", "--show-object-format=storage"],
		undefined,
		128,
	);
	const formatOutput = successfulOutput(formatResult, "object format lookup");
	if (!formatOutput.ok) return formatOutput;
	const objectFormat = formatOutput.value;
	if (objectFormat !== "sha1" && objectFormat !== "sha256")
		return {
			ok: false,
			error: failure("Origin uses an unsupported Git object format."),
		};
	const objectIdLength = objectFormat === "sha1" ? 40 : 64;
	if (
		!validObjectId(request.expectedParent, objectIdLength) ||
		!validObjectId(request.verifiedTree, objectIdLength) ||
		(request.source !== undefined &&
			request.source.objectFormat !== objectFormat)
	)
		return {
			ok: false,
			error: failure("Landing ids do not match the origin object format."),
		};
	const parentExists = await hasObject(
		request.git,
		request.origin,
		`${request.expectedParent}^{commit}`,
	);
	if (!parentExists.ok) return parentExists;
	if (!parentExists.value)
		return {
			ok: false,
			error: failure("Expected landing parent is missing from the origin."),
		};
	let transferCleanupWarning: string | null = null;
	const treeExists = await hasObject(
		request.git,
		request.origin,
		`${request.verifiedTree}^{tree}`,
	);
	if (!treeExists.ok) return treeExists;
	if (!treeExists.value) {
		const transferred = await transferVerifiedTree(
			request,
			objectFormat,
			objectIdLength,
		);
		if (!transferred.ok) return transferred;
		transferCleanupWarning = transferred.value;
	}
	const treeAvailable = await hasObject(
		request.git,
		request.origin,
		`${request.verifiedTree}^{tree}`,
	);
	if (!treeAvailable.ok) return treeAvailable;
	if (!treeAvailable.value)
		return {
			ok: false,
			error: failure(
				"Verified candidate tree was not imported into the origin.",
			),
		};
	for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"] as const) {
		const identity = await callGit(
			request.git,
			request.origin,
			["var", variable],
			undefined,
			4096,
		);
		const identityOutput = successfulOutput(identity, `${variable} lookup`);
		if (!identityOutput.ok || identityOutput.value.length === 0)
			return {
				ok: false,
				error: identityOutput.ok
					? failure("Public Git author and committer identity are required.")
					: identityOutput.error,
			};
	}
	const message = `${request.title}\n\nKogen-Intent: ${request.slug}\n`;
	const signing = await publicSigningEnabled(request.git, request.origin);
	if (!signing.ok) return signing;
	const created = await callGit(
		request.git,
		request.origin,
		[
			"commit-tree",
			...(signing.value ? ["-S"] : []),
			request.verifiedTree,
			"-p",
			request.expectedParent,
			"-F",
			"-",
		],
		ENCODER.encode(message),
		4096,
	);
	const commitOutput = successfulOutput(
		created,
		"signed landing commit creation",
	);
	if (!commitOutput.ok) return commitOutput;
	const commit = commitOutput.value;
	if (!validObjectId(commit, objectIdLength))
		return {
			ok: false,
			error: failure("Git returned an invalid landing commit id."),
		};
	const rawCommit = await callGit(
		request.git,
		request.origin,
		["cat-file", "-p", commit],
		undefined,
		64 * 1024,
	);
	if (!rawCommit.ok) return rawCommit;
	if (rawCommit.value.timedOut || rawCommit.value.exitCode !== 0)
		return {
			ok: false,
			error: failure("Git landing commit verification failed."),
		};
	let rawCommitText: string;
	try {
		rawCommitText = DECODER.decode(rawCommit.value.stdout);
	} catch (cause) {
		return {
			ok: false,
			error: failure("Git landing commit is not valid UTF-8.", cause),
		};
	}
	if (
		!exactCommitHeaders(
			rawCommitText,
			objectIdLength,
			request.expectedParent,
			request.verifiedTree,
			message,
			signing.value,
		)
	)
		return {
			ok: false,
			error: failure(
				"Landing commit does not have the verified tree, sole parent, and normative message.",
			),
		};
	return {
		ok: true,
		value: {
			commit,
			tree: request.verifiedTree,
			parent: request.expectedParent,
			objectFormat,
			transferCleanupWarning,
		},
	};
}
