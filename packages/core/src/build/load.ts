import type { PortError, Result } from "../contracts/errors";
import type { GitPort, ProcessResult } from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../git/command";
import { hashApprovalBytes, hashIntentBytes } from "../intent/hash";
import { isValidIntentSlug } from "../intent/parse";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_APPROVAL_BYTES = 2 * 1024 * 1024;

export interface LoadedBuildApproval {
	readonly slug: string;
	readonly approvalCommit: string;
	readonly approvalSha256: string;
	readonly intentSha256: string;
	readonly targetBranch: string;
	readonly baseSha: string;
	readonly intentPath: string;
	readonly acceptancePath: string;
	readonly intentBytes: Uint8Array;
	readonly acceptanceBytes: Uint8Array;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export interface BuildApprovalLoadFailure {
	readonly code:
		| "controller/approval_invalid"
		| "environment/approval_unavailable";
	readonly message: string;
	readonly cause?: PortError;
}

export type BuildApprovalLoadResult = Result<
	LoadedBuildApproval,
	BuildApprovalLoadFailure
>;

export interface LoadBuildApprovalRequest {
	readonly git: Pick<GitPort, "command">;
	readonly origin: string;
	readonly slug: string;
}

function invalid(
	message = "The immutable approval package is invalid.",
): BuildApprovalLoadFailure {
	return { code: "controller/approval_invalid", message };
}

function gitRequest(
	request: LoadBuildApprovalRequest,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
) {
	return {
		repository: request.origin,
		argv,
		timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
		outputLimitBytes,
	};
}

async function runGit(
	request: LoadBuildApprovalRequest,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	try {
		return await request.git.command(
			gitRequest(request, argv, outputLimitBytes),
		);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unknown",
				message:
					cause instanceof Error ? cause.message : "Git approval read failed.",
				retryable: true,
				cause,
			},
		};
	}
}

function unavailable(error: PortError): BuildApprovalLoadFailure {
	return {
		code: "environment/approval_unavailable",
		message: `Could not read the immutable approval package: ${error.message}`,
		cause: error,
	};
}

function splitOneLine(bytes: Uint8Array): string | null {
	try {
		const text = DECODER.decode(bytes);
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.length === 1 && lines[0] !== "" ? (lines[0] ?? null) : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 4096 &&
		!value.startsWith("/") &&
		!value.includes("\\") &&
		!value.includes("\0") &&
		value
			.split("/")
			.every(
				(part) =>
					part.length > 0 && part !== "." && part !== ".." && part !== ".git",
			)
	);
}

function parseApprovalMetadata(
	bytes: Uint8Array,
): Record<string, unknown> | null {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_APPROVAL_BYTES)
		return null;
	let value: unknown;
	try {
		value = JSON.parse(DECODER.decode(bytes)) as unknown;
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const required = [
		"schema",
		"slug",
		"approval_sha256",
		"intent_sha256",
		"target_branch",
		"base_sha",
		"domains",
		"acceptance_paths",
		"protected_manifest",
		"check_baseline",
		"witness",
		"by",
		"at",
	].sort();
	const keys = Object.keys(value).sort();
	if (
		keys.length !== required.length ||
		!required.every((key, index) => keys[index] === key) ||
		value.schema !== 2 ||
		typeof value.slug !== "string" ||
		!isValidIntentSlug(value.slug) ||
		typeof value.approval_sha256 !== "string" ||
		!SHA256.test(value.approval_sha256) ||
		typeof value.intent_sha256 !== "string" ||
		!SHA256.test(value.intent_sha256) ||
		typeof value.target_branch !== "string" ||
		value.target_branch.length === 0 ||
		/[\r\n\0]/u.test(value.target_branch) ||
		typeof value.base_sha !== "string" ||
		!OBJECT_ID.test(value.base_sha) ||
		!Array.isArray(value.domains) ||
		!value.domains.every((entry) => typeof entry === "string") ||
		!Array.isArray(value.acceptance_paths) ||
		value.acceptance_paths.length !== 1 ||
		!isSafeRelativePath(value.acceptance_paths[0]) ||
		!isRecord(value.protected_manifest) ||
		!Array.isArray(value.check_baseline) ||
		typeof value.by !== "string" ||
		value.by.length === 0 ||
		/[\r\n\0]/u.test(value.by) ||
		typeof value.at !== "string" ||
		Number.isNaN(Date.parse(value.at))
	)
		return null;
	return value;
}

function parseCommitIdentity(bytes: Uint8Array): {
	readonly tree: string;
	readonly message: string;
} | null {
	let text: string;
	try {
		text = DECODER.decode(bytes);
	} catch {
		return null;
	}
	const divider = text.indexOf("\n\n");
	if (divider < 0) return null;
	const headers = text.slice(0, divider).split("\n");
	const treeLines = headers.filter((line) => line.startsWith("tree "));
	if (treeLines.length !== 1) return null;
	const tree = treeLines[0]?.slice(5) ?? "";
	if (!OBJECT_ID.test(tree)) return null;
	return { tree, message: text.slice(divider + 2) };
}

function trailer(message: string, name: string): string | null {
	const matches = message.match(new RegExp(`^${name}: (.+)$`, "gmu"));
	if (matches === null || matches.length !== 1) return null;
	return matches[0]?.slice(name.length + 2) ?? null;
}

async function readCommitBlob(
	request: LoadBuildApprovalRequest,
	commit: string,
	path: string,
	limit: number,
): Promise<Result<Uint8Array, BuildApprovalLoadFailure>> {
	const result = await runGit(
		request,
		["cat-file", "blob", `${commit}:${path}`],
		Math.min(limit, GIT_MAX_OUTPUT_LIMIT_BYTES),
	);
	if (!result.ok) return { ok: false, error: unavailable(result.error) };
	if (result.value.timedOut)
		return {
			ok: false,
			error: unavailable({
				code: "timeout",
				message: "Git blob read timed out.",
				retryable: true,
			}),
		};
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: invalid(`Approval package is missing ${path}.`),
		};
	if (result.value.stdout.byteLength > limit)
		return {
			ok: false,
			error: invalid(`Approval package file ${path} exceeds its size limit.`),
		};
	return { ok: true, value: result.value.stdout.slice() };
}

/** Read and verify the immutable approval before Build claims or model effects. */
export async function loadBuildApproval(
	request: LoadBuildApprovalRequest,
): Promise<BuildApprovalLoadResult> {
	if (
		!isValidIntentSlug(request.slug) ||
		!request.origin.startsWith("/") ||
		request.origin.includes("\0")
	)
		return {
			ok: false,
			error: invalid("Approval lookup identity is invalid."),
		};
	const ref = `refs/kogen/intents/${request.slug}`;
	const refResult = await runGit(
		request,
		["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref],
		4096,
	);
	if (!refResult.ok) return { ok: false, error: unavailable(refResult.error) };
	if (refResult.value.timedOut)
		return {
			ok: false,
			error: unavailable({
				code: "timeout",
				message: "Approval ref lookup timed out.",
				retryable: true,
			}),
		};
	if (refResult.value.exitCode !== 0)
		return {
			ok: false,
			error: unavailable({
				code: "unavailable",
				message: "Approval ref lookup failed.",
				retryable: true,
			}),
		};
	const row = splitOneLine(refResult.value.stdout);
	const fields = row?.split("\0");
	const commit = fields?.[1];
	if (
		fields?.[0] !== ref ||
		commit === undefined ||
		!OBJECT_ID.test(commit) ||
		fields[2] !== ""
	)
		return {
			ok: false,
			error: invalid("Approval ref is missing or malformed."),
		};
	const commitResult = await runGit(request, ["cat-file", "-p", commit]);
	if (!commitResult.ok)
		return { ok: false, error: unavailable(commitResult.error) };
	if (commitResult.value.timedOut)
		return {
			ok: false,
			error: unavailable({
				code: "timeout",
				message: "Approval commit read timed out.",
				retryable: true,
			}),
		};
	if (commitResult.value.exitCode !== 0)
		return {
			ok: false,
			error: invalid("Approval ref does not point to a readable commit."),
		};
	const parsedCommit = parseCommitIdentity(commitResult.value.stdout);
	if (parsedCommit === null)
		return {
			ok: false,
			error: invalid("Approval commit metadata is malformed."),
		};
	const intentPath = `.kogen/intents/${request.slug}/intent.md`;
	const approvalPath = `.kogen/intents/${request.slug}/approval.json`;
	const [approvalBlob, intentBlob] = await Promise.all([
		readCommitBlob(request, commit, approvalPath, MAX_APPROVAL_BYTES),
		readCommitBlob(request, commit, intentPath, MAX_APPROVAL_BYTES),
	]);
	if (!approvalBlob.ok) return approvalBlob;
	if (!intentBlob.ok) return intentBlob;
	const metadata = parseApprovalMetadata(approvalBlob.value);
	if (metadata === null || metadata.slug !== request.slug)
		return {
			ok: false,
			error: invalid("Approval metadata is malformed or names another Intent."),
		};
	const acceptancePath = (metadata.acceptance_paths as string[])[0];
	if (typeof acceptancePath !== "string")
		return {
			ok: false,
			error: invalid("Approval acceptance path is missing."),
		};
	const acceptanceBlob = await readCommitBlob(
		request,
		commit,
		acceptancePath,
		MAX_APPROVAL_BYTES,
	);
	if (!acceptanceBlob.ok) return acceptanceBlob;
	const approvalSha256 = hashApprovalBytes(
		intentBlob.value,
		acceptanceBlob.value,
	);
	const intentSha256 = hashIntentBytes(intentBlob.value);
	const commitMessage = parsedCommit.message.replace(/\n*$/u, "");
	if (
		approvalSha256 !== metadata.approval_sha256 ||
		intentSha256 !== metadata.intent_sha256 ||
		trailer(commitMessage, "Kogen-Approval") !== request.slug ||
		trailer(commitMessage, "Kogen-Approved-Hash") !== approvalSha256 ||
		trailer(commitMessage, "Kogen-Approved-By") !== metadata.by ||
		trailer(commitMessage, "Kogen-Approved-At") !== metadata.at
	)
		return { ok: false, error: invalid("Approval integrity check failed.") };
	return {
		ok: true,
		value: {
			slug: request.slug,
			approvalCommit: commit,
			approvalSha256,
			intentSha256,
			targetBranch: metadata.target_branch as string,
			baseSha: metadata.base_sha as string,
			intentPath,
			acceptancePath,
			intentBytes: intentBlob.value,
			acceptanceBytes: acceptanceBlob.value,
			metadata,
		},
	};
}
