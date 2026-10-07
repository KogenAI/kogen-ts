import type { PortError, Result } from "../contracts/errors";
import type {
	FileSystemPort,
	GitPort,
	ProcessResult,
} from "../contracts/ports";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../git/command";
import { isValidIntentSlug } from "../intent/parse";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RUN_DISPOSITIONS = new Set(["failed", "parked", "interrupted"]);

export type IntentRemoveBuildDisposition = "failed" | "parked" | "interrupted";

/**
 * The command composition supplies one snapshot from the real queue/run/status
 * stores. The approval commit is included so a stale run cannot describe a
 * newer approval.
 */
export interface IntentRemoveLifecycle {
	readonly activeBuild: boolean;
	readonly landed: boolean;
	readonly buildDisposition: IntentRemoveBuildDisposition | null;
}

export interface IntentRemoveLifecyclePort {
	inspect(
		slug: string,
		approvalCommit: string | null,
	): Promise<Result<IntentRemoveLifecycle>>;
}

export interface IntentRemoveRequest {
	readonly origin: string;
	readonly checkout: string;
	readonly slug: string;
	/** Exact source path selected by the project's acceptance adapter. */
	readonly acceptancePath: string;
	readonly force: boolean;
	readonly filesystem: Pick<FileSystemPort, "readFile">;
	/** Public Git port: commits retain the user's identity and signing config. */
	readonly git: Pick<GitPort, "command">;
	readonly lifecycle: IntentRemoveLifecyclePort;
}

export interface IntentRemoveSuccess {
	readonly slug: string;
	readonly commit: string;
	readonly deletedApprovalRef: boolean;
}

export interface IntentRemoveFailure {
	readonly code:
		| "intent/invalid_slug"
		| "intent/not_found"
		| "intent/remove_blocked"
		| "intent/remove_requires_force"
		| "intent/remove_requires_commit"
		| "environment/remove_state_unavailable"
		| "environment/approval_ref_invalid"
		| "environment/approval_ref_changed"
		| "environment/remove_commit_failed";
	readonly exitCode: 2 | 3 | 70;
	readonly message: string;
}

export type IntentRemoveResult = Result<
	IntentRemoveSuccess,
	IntentRemoveFailure
>;

interface ApprovalRef {
	readonly name: string;
	readonly target: string;
}

function fail(
	code: IntentRemoveFailure["code"],
	exitCode: IntentRemoveFailure["exitCode"],
	message: string,
): IntentRemoveResult {
	return { ok: false, error: { code, exitCode, message } };
}

function portFailure(
	code: IntentRemoveFailure["code"],
	message: string,
	error?: PortError,
): IntentRemoveResult {
	return fail(
		code,
		3,
		error === undefined ? message : `${message}: ${error.message}`,
	);
}

function relativeAcceptancePath(slug: string, path: string): boolean {
	const prefix = `.kogen/acceptance/${slug}`;
	return (
		path.startsWith(prefix) &&
		path.length > prefix.length &&
		!path.slice(prefix.length).includes("/") &&
		!path.includes("\\") &&
		!path.includes("\0")
	);
}

function splitNul(bytes: Uint8Array): Uint8Array[] | null {
	if (bytes.byteLength === 0) return [];
	if (bytes[bytes.byteLength - 1] !== 0) return null;
	const fields: Uint8Array[] = [];
	let start = 0;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] !== 0) continue;
		fields.push(bytes.subarray(start, index));
		start = index + 1;
	}
	return fields;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

function parseApprovalRef(bytes: Uint8Array, slug: string): ApprovalRef | null {
	if (bytes.byteLength === 0) return null;
	let output: string;
	try {
		output = DECODER.decode(bytes);
	} catch {
		return null;
	}
	const rows = output.split("\n").filter((row) => row.length > 0);
	if (rows.length === 0) return null;
	if (rows.length !== 1) return null;
	const fields = rows[0]?.split("\0");
	const name = fields?.[0];
	const target = fields?.[1];
	const symbolic = fields?.[2];
	const expectedName = `refs/kogen/intents/${slug}`;
	if (
		name !== expectedName ||
		target === undefined ||
		!OBJECT_ID.test(target) ||
		symbolic !== ""
	)
		return null;
	return { name, target };
}

async function runGit(
	request: IntentRemoveRequest,
	repository: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	try {
		return await request.git.command({
			repository,
			argv,
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unknown",
				message:
					cause instanceof Error ? cause.message : "Git port operation failed",
				retryable: true,
				cause,
			},
		};
	}
}

async function approvalRef(
	request: IntentRemoveRequest,
): Promise<Result<ApprovalRef | null>> {
	const ref = `refs/kogen/intents/${request.slug}`;
	const result = await runGit(
		request,
		request.origin,
		["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", ref],
		undefined,
		4096,
	);
	if (!result.ok) return result;
	if (result.value.timedOut || result.value.exitCode !== 0)
		return {
			ok: false,
			error: {
				code: result.value.timedOut ? "timeout" : "unavailable",
				message: "Could not read the approval ref.",
				retryable: true,
			},
		};
	const parsed = parseApprovalRef(result.value.stdout, request.slug);
	if (result.value.stdout.byteLength > 0 && parsed === null)
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "Approval ref is malformed.",
				retryable: false,
			},
		};
	return { ok: true, value: parsed };
}

function validLifecycle(value: IntentRemoveLifecycle): boolean {
	return (
		typeof value.activeBuild === "boolean" &&
		typeof value.landed === "boolean" &&
		(value.buildDisposition === null ||
			(typeof value.buildDisposition === "string" &&
				RUN_DISPOSITIONS.has(value.buildDisposition)))
	);
}

async function lifecycle(
	request: IntentRemoveRequest,
	approvalCommit: string | null,
): Promise<Result<IntentRemoveLifecycle>> {
	try {
		const result = await request.lifecycle.inspect(
			request.slug,
			approvalCommit,
		);
		if (!result.ok) return result;
		if (!validLifecycle(result.value))
			return {
				ok: false,
				error: {
					code: "invalid_input",
					message: "Intent removal lifecycle state is malformed.",
					retryable: false,
				},
			};
		return result;
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "unknown",
				message: "Intent removal lifecycle lookup failed.",
				retryable: true,
				cause,
			},
		};
	}
}

function forceMessage(
	disposition: IntentRemoveBuildDisposition | null,
): string {
	if (disposition === "failed")
		return "Intent still has a failed Build approval; pass --force to discard the approval and remove its files";
	if (disposition === "parked")
		return "Intent still has a parked Build approval; pass --force to discard the approval and remove its files";
	if (disposition === "interrupted")
		return "Intent still has an approval ref; pass --force to discard the approval and remove its files";
	return "Intent approved or queued; pass --force to discard the approval and remove its files";
}

function commandFailed(result: ProcessResult): boolean {
	return result.timedOut || result.exitCode !== 0;
}

async function verifyRequiredPathsTracked(
	request: IntentRemoveRequest,
	intentPath: string,
	intentDir: string,
): Promise<IntentRemoveResult | null> {
	const result = await runGit(
		request,
		request.checkout,
		["ls-files", "-z", "--", intentDir, request.acceptancePath],
		undefined,
		GIT_MAX_OUTPUT_LIMIT_BYTES,
	);
	if (!result.ok)
		return portFailure(
			"environment/remove_commit_failed",
			"Could not check whether the Intent files are tracked",
			result.error,
		);
	if (commandFailed(result.value))
		return fail(
			"environment/remove_commit_failed",
			3,
			result.value.timedOut
				? "Git ls-files timed out while removing the Intent."
				: `Git ls-files failed with exit ${String(result.value.exitCode)}.`,
		);
	const paths = splitNul(result.value.stdout);
	if (paths === null)
		return fail(
			"environment/remove_commit_failed",
			3,
			"Git ls-files returned malformed path data.",
		);
	const intentBytes = ENCODER.encode(intentPath);
	const acceptanceBytes = ENCODER.encode(request.acceptancePath);
	if (
		!paths.some((path) => sameBytes(path, intentBytes)) ||
		!paths.some((path) => sameBytes(path, acceptanceBytes))
	)
		return fail(
			"intent/remove_requires_commit",
			2,
			"Intent files must be tracked to record their removal",
		);
	return null;
}

async function removePathsAndCommit(
	request: IntentRemoveRequest,
	intentDir: string,
): Promise<Result<string>> {
	const removed = await runGit(request, request.checkout, [
		"rm",
		"-r",
		"-f",
		"--",
		intentDir,
		request.acceptancePath,
	]);
	if (!removed.ok) return removed;
	if (commandFailed(removed.value))
		return {
			ok: false,
			error: {
				code: removed.value.timedOut ? "timeout" : "unavailable",
				message: removed.value.timedOut
					? "Git rm timed out while removing the Intent."
					: `Git rm failed with exit ${String(removed.value.exitCode)}.`,
				retryable: true,
			},
		};
	const cleaned = await runGit(request, request.checkout, [
		"clean",
		"-fdx",
		"--",
		intentDir,
	]);
	if (!cleaned.ok) return cleaned;
	if (commandFailed(cleaned.value))
		return {
			ok: false,
			error: {
				code: cleaned.value.timedOut ? "timeout" : "unavailable",
				message: cleaned.value.timedOut
					? "Git clean timed out while removing the Intent."
					: `Git clean failed with exit ${String(cleaned.value.exitCode)}.`,
				retryable: true,
			},
		};

	const committed = await runGit(request, request.checkout, [
		"commit",
		"--only",
		"--message",
		`Remove Intent ${request.slug}`,
		"--",
		intentDir,
		request.acceptancePath,
	]);
	if (!committed.ok) return committed;
	if (commandFailed(committed.value))
		return {
			ok: false,
			error: {
				code: committed.value.timedOut ? "timeout" : "unavailable",
				message: committed.value.timedOut
					? "Git commit timed out while removing the Intent."
					: `Git commit failed with exit ${String(committed.value.exitCode)}.`,
				retryable: true,
			},
		};
	const head = await runGit(
		request,
		request.checkout,
		["rev-parse", "--verify", "HEAD"],
		undefined,
		256,
	);
	if (!head.ok) return head;
	if (commandFailed(head.value))
		return {
			ok: false,
			error: {
				code: head.value.timedOut ? "timeout" : "unavailable",
				message: "Could not read the removal commit id.",
				retryable: true,
			},
		};
	let commit: string;
	try {
		commit = DECODER.decode(head.value.stdout).trimEnd();
	} catch {
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "Git returned an invalid removal commit id.",
				retryable: false,
			},
		};
	}
	if (!OBJECT_ID.test(commit))
		return {
			ok: false,
			error: {
				code: "invalid_input",
				message: "Git returned an invalid removal commit id.",
				retryable: false,
			},
		};
	return { ok: true, value: commit };
}

async function compareDeleteApprovalRef(
	request: IntentRemoveRequest,
	ref: ApprovalRef,
): Promise<IntentRemoveResult | null> {
	const deleted = await runGit(request, request.origin, [
		"update-ref",
		"--no-deref",
		"-d",
		ref.name,
		ref.target,
	]);
	if (!deleted.ok)
		return portFailure(
			"environment/approval_ref_changed",
			"Could not compare-and-delete the approval ref",
			deleted.error,
		);
	if (!commandFailed(deleted.value)) return null;
	return fail(
		"environment/approval_ref_changed",
		3,
		"approval ref changed while removing the Intent; review the ref before retrying",
	);
}

/** Remove an Intent with a path-limited user commit and approval-ref CAS. */
export async function removeIntent(
	request: IntentRemoveRequest,
): Promise<IntentRemoveResult> {
	if (!isValidIntentSlug(request.slug))
		return fail(
			"intent/invalid_slug",
			70,
			"Slug must use lowercase letters, digits, and dashes.",
		);
	if (!relativeAcceptancePath(request.slug, request.acceptancePath))
		return fail(
			"environment/remove_commit_failed",
			3,
			"Acceptance source path is invalid.",
		);

	const intentDir = `.kogen/intents/${request.slug}`;
	const intentPath = `${intentDir}/intent.md`;
	let source: Result<Uint8Array>;
	try {
		source = await request.filesystem.readFile({
			root: request.checkout,
			path: intentPath,
			maxBytes: 2 * 1024 * 1024,
		});
	} catch (cause) {
		return portFailure(
			"environment/remove_state_unavailable",
			"Could not read the Intent file",
			{
				code: "unknown",
				message:
					cause instanceof Error ? cause.message : "Filesystem port failed",
				retryable: true,
				cause,
			},
		);
	}
	if (!source.ok) {
		if (source.error.code === "not_found")
			return fail("intent/not_found", 2, "Intent does not exist");
		return portFailure(
			"environment/remove_state_unavailable",
			"Could not read the Intent file",
			source.error,
		);
	}

	const currentRef = await approvalRef(request);
	if (!currentRef.ok)
		return portFailure(
			"environment/approval_ref_invalid",
			"Could not read the Intent approval ref",
			currentRef.error,
		);
	const approvalCommit = currentRef.value?.target ?? null;
	const observed = await lifecycle(request, approvalCommit);
	if (!observed.ok)
		return portFailure(
			"environment/remove_state_unavailable",
			"Could not establish the Intent lifecycle state",
			observed.error,
		);
	if (observed.value.activeBuild)
		return fail(
			"intent/remove_blocked",
			2,
			"Intent is in an active Build and cannot be removed",
		);
	if (currentRef.value !== null && !observed.value.landed && !request.force)
		return fail(
			"intent/remove_requires_force",
			2,
			forceMessage(observed.value.buildDisposition),
		);

	const tracked = await verifyRequiredPathsTracked(
		request,
		intentPath,
		intentDir,
	);
	if (tracked !== null) return tracked;

	// Re-read the guard and ref directly before the first checkout mutation. A
	// queue that starts during preflight must still prevent removal.
	const beforeMutationRef = await approvalRef(request);
	if (!beforeMutationRef.ok)
		return portFailure(
			"environment/approval_ref_invalid",
			"Could not re-read the Intent approval ref",
			beforeMutationRef.error,
		);
	if ((beforeMutationRef.value?.target ?? null) !== approvalCommit)
		return fail(
			"environment/approval_ref_changed",
			3,
			"approval ref changed while removing the Intent; review the ref before retrying",
		);
	const finalLifecycle = await lifecycle(request, approvalCommit);
	if (!finalLifecycle.ok)
		return portFailure(
			"environment/remove_state_unavailable",
			"Could not recheck the Intent lifecycle state",
			finalLifecycle.error,
		);
	if (finalLifecycle.value.activeBuild)
		return fail(
			"intent/remove_blocked",
			2,
			"Intent is in an active Build and cannot be removed",
		);

	const commit = await removePathsAndCommit(request, intentDir);
	if (!commit.ok)
		return portFailure(
			"environment/remove_commit_failed",
			"Could not commit the Intent removal",
			commit.error,
		);
	if (currentRef.value !== null) {
		const deleted = await compareDeleteApprovalRef(request, currentRef.value);
		if (deleted !== null) return deleted;
	} else {
		const afterCommitRef = await approvalRef(request);
		if (!afterCommitRef.ok)
			return portFailure(
				"environment/approval_ref_invalid",
				"Could not verify the Intent approval ref after removal",
				afterCommitRef.error,
			);
		if (afterCommitRef.value !== null)
			return fail(
				"environment/approval_ref_changed",
				3,
				"approval ref changed while removing the Intent; review the ref before retrying",
			);
	}
	return {
		ok: true,
		value: {
			slug: request.slug,
			commit: commit.value,
			deletedApprovalRef: currentRef.value !== null,
		},
	};
}
