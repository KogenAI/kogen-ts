import type { PortError, Result } from "../contracts/errors";
import type { GitPort, ProcessResult } from "../contracts/ports";
import type { FileSystemHostRequest } from "../fs/read";
import type { PrivateGitRepository } from "../git/repository";
import { PROJECT_CLAIM_REF } from "../queue/claim";
import type { ProcessIdentityPort, QueueOwnerIdentity } from "../queue/lock";
import type { JournalEvent } from "../run/journal";
import {
	appendRunEventBeforeSnapshot,
	createJournalEvent,
	type RecoveryRecord,
	type RunRecord,
	type RunStatus,
	validateRunRecord,
	writeRunSnapshot,
} from "../run/store";
import { snapshotWorkspace } from "../workspace/snapshot";
import {
	type RecoveryIssue,
	type RecoveryOutcome,
	recoveryMayRemoveIncoming,
	recoveryMayRemoveWorkspace,
	recoveryOutcomeTransition,
	recoveryOwnerDecision,
	recoveryWorkspaceTransition,
} from "./transition";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_GIT_OUTPUT = 900 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const RUN_ID = /^[a-f0-9]{32}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export interface RecoveryWorkspaceTarget {
	/** Stable, ref-safe workspace identity recorded in events/run.json. */
	readonly id: string;
	readonly baseCommit: string;
	readonly sourceRepository: string;
	/** Private Git metadata is outside this workspace; its index is controller-owned. */
	readonly repository: PrivateGitRepository;
	/** Safely determines whether a previous cleanup already removed this workspace. */
	present(): Promise<Result<boolean>>;
	/** Must stop at filesystem boundaries and never follow a workspace symlink. */
	remove(): Promise<Result<void>>;
}

export interface RecoveryArchiveRequest {
	readonly runId: string;
	readonly workspace: string;
	readonly base: string;
	readonly tree: string;
	readonly repository: PrivateGitRepository;
}

export interface RecoveryArchivePublication {
	readonly tree: string;
	readonly archive: string;
}

/**
 * Archive effects are a lossless fallback when Git ref publication fails. A
 * successful publish must be create-only and durable (including its manifest);
 * listComplete must validate the manifest and every archived tree entry before
 * returning an identity. Both methods are idempotent for this exact request.
 */
export interface RecoveryArchivePort {
	/** Lists every complete prior archive for this run/workspace/base identity. */
	listComplete(input: {
		readonly runId: string;
		readonly workspace: string;
		readonly base: string;
	}): Promise<Result<readonly RecoveryArchivePublication[]>>;
	publishCreateOnly(request: RecoveryArchiveRequest): Promise<Result<string>>;
}

export interface RecoverDeadRunRequest {
	readonly record: RunRecord;
	readonly runDirectory: string;
	readonly origin: string;
	readonly latestEvent: JournalEvent | null;
	/** Last durable terminal journal row, even when cleanup events followed it. */
	readonly recordedOutcome?: {
		readonly status: RunStatus;
		readonly reason: string;
	} | null;
	readonly workspaces: readonly RecoveryWorkspaceTarget[];
	readonly filesystem: FileSystemHostRequest;
	/** Controller Git port; it must use private, hook-free Git configuration. */
	readonly git: GitPort;
	readonly identity: ProcessIdentityPort;
	/** Stops any remaining run-owned child writers before a workspace snapshot. */
	stopWriters(record: RunRecord): Promise<Result<void>>;
	readonly archive?: RecoveryArchivePort;
	readonly now?: () => number;
}

export type RecoveryReport =
	| {
			readonly kind: "recovered";
			readonly outcome: RecoveryOutcome;
			readonly record: RunRecord;
	  }
	| {
			readonly kind: "cleanup_pending";
			readonly outcome: RecoveryOutcome;
			readonly record: RunRecord;
			readonly failures: readonly RecoveryIssue[];
	  }
	| { readonly kind: "live_owner"; readonly record: RunRecord }
	| { readonly kind: "owner_unknown"; readonly record: RunRecord }
	| {
			readonly kind: "deferred";
			readonly record: RunRecord;
			readonly issue: RecoveryIssue;
	  };

interface GitCommitInfo {
	readonly tree: string;
	readonly parents: readonly string[];
	readonly message: string;
}

type ExistingPublication =
	| { readonly kind: "recovery"; readonly record: RecoveryRecord }
	| { readonly kind: "candidate" }
	| null;

function failure(
	code: PortError["code"],
	message: string,
	cause?: unknown,
): PortError {
	return {
		code,
		message,
		retryable: code === "io" || code === "timeout" || code === "unavailable",
		...(cause === undefined ? {} : { cause }),
	};
}

function errorResult<T>(error: PortError): Result<T> {
	return { ok: false, error };
}

async function safeCall<T>(
	call: () => Promise<Result<T>>,
	message: string,
): Promise<Result<T>> {
	try {
		return await call();
	} catch (cause) {
		return errorResult(failure("unknown", message, cause));
	}
}

async function originGit(
	git: GitPort,
	origin: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = MAX_GIT_OUTPUT,
): Promise<Result<ProcessResult>> {
	try {
		return await git.command({
			repository: origin,
			argv,
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		return errorResult(
			failure("unknown", `Git ${argv[0] ?? "command"} failed.`, cause),
		);
	}
}

async function privateGit(
	repository: PrivateGitRepository,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = MAX_GIT_OUTPUT,
): Promise<Result<ProcessResult>> {
	try {
		return await repository.command(argv, {
			...(stdin === undefined ? {} : { stdin }),
			timeoutMilliseconds: GIT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		return errorResult(
			failure("unknown", `Git ${argv[0] ?? "command"} failed.`, cause),
		);
	}
}

function commandFailure(
	result: ProcessResult,
	operation: string,
): PortError | null {
	if (result.timedOut) return failure("timeout", `Git ${operation} timed out.`);
	if (result.exitCode !== 0)
		return failure(
			"unavailable",
			`Git ${operation} failed with exit ${String(result.exitCode)}.`,
		);
	return null;
}

async function checkedGit(
	git: GitPort,
	origin: string,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = MAX_GIT_OUTPUT,
): Promise<Result<ProcessResult>> {
	const result = await originGit(git, origin, argv, stdin, outputLimitBytes);
	if (!result.ok) return result;
	const error = commandFailure(result.value, argv[0] ?? "command");
	return error === null ? result : errorResult(error);
}

async function checkedPrivateGit(
	repository: PrivateGitRepository,
	argv: readonly string[],
	stdin?: Uint8Array,
	outputLimitBytes = MAX_GIT_OUTPUT,
): Promise<Result<ProcessResult>> {
	const result = await privateGit(repository, argv, stdin, outputLimitBytes);
	if (!result.ok) return result;
	const error = commandFailure(result.value, argv[0] ?? "command");
	return error === null ? result : errorResult(error);
}

function text(bytes: Uint8Array, label: string): Result<string> {
	try {
		return { ok: true, value: decoder.decode(bytes) };
	} catch (cause) {
		return errorResult(
			failure("invalid_input", `Git returned invalid ${label} text.`, cause),
		);
	}
}

function objectId(value: string): boolean {
	return OBJECT_ID.test(value);
}

function parseCommit(bytes: Uint8Array): Result<GitCommitInfo> {
	let split = -1;
	for (let index = 0; index + 1 < bytes.byteLength; index += 1) {
		if (bytes[index] === 10 && bytes[index + 1] === 10) {
			split = index;
			break;
		}
	}
	if (split < 0)
		return errorResult(
			failure("invalid_input", "Git commit has no message separator."),
		);
	const header = new TextDecoder("latin1")
		.decode(bytes.subarray(0, split))
		.split("\n");
	const treeLine = header.find((line) => line.startsWith("tree "));
	const tree = treeLine?.slice(5);
	const parents = header
		.filter((line) => line.startsWith("parent "))
		.map((line) => line.slice(7));
	if (
		tree === undefined ||
		!objectId(tree) ||
		parents.some((parent) => !objectId(parent))
	)
		return errorResult(
			failure("invalid_input", "Git commit tree or parent is malformed."),
		);
	const message = text(bytes.subarray(split + 2), "commit message");
	if (!message.ok) return message;
	return { ok: true, value: { tree, parents, message: message.value } };
}

async function readCommit(
	git: GitPort,
	origin: string,
	commit: string,
): Promise<Result<GitCommitInfo>> {
	if (!objectId(commit))
		return errorResult(
			failure("invalid_input", "Git ref contains an invalid object id."),
		);
	const result = await checkedGit(
		git,
		origin,
		["cat-file", "commit", commit],
		undefined,
		64 * 1024,
	);
	if (!result.ok) return result;
	return parseCommit(result.value.stdout);
}

function recoveryRefPrefix(runId: string): string {
	return `refs/kogen/candidates/${runId}/`;
}

async function listRunRefs(
	git: GitPort,
	origin: string,
	runId: string,
): Promise<
	Result<readonly { readonly ref: string; readonly commit: string }[]>
> {
	const prefix = recoveryRefPrefix(runId);
	const result = await checkedGit(
		git,
		origin,
		["for-each-ref", "--format=%(refname) %(objectname)", prefix],
		undefined,
		64 * 1024,
	);
	if (!result.ok) return result;
	const decoded = text(result.value.stdout, "ref listing");
	if (!decoded.ok) return decoded;
	const refs: { ref: string; commit: string }[] = [];
	for (const line of decoded.value.split("\n")) {
		if (line.length === 0) continue;
		const match = /^(\S+) ([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(line);
		if (match === null || !match[1]?.startsWith(prefix))
			return errorResult(
				failure("invalid_input", "Git returned a malformed candidate ref."),
			);
		refs.push({ ref: match[1], commit: match[2] ?? "" });
	}
	return { ok: true, value: refs };
}

function recoveryMessage(
	runId: string,
	workspace: string,
	base: string,
	tree: string,
): string {
	return [
		"Kogen recovery snapshot",
		"",
		`Kogen-Run: ${runId}`,
		`Kogen-Workspace: ${workspace}`,
		`Kogen-Base: ${base}`,
		`Kogen-Tree: ${tree}`,
		"Kogen-Verification: unverified",
		"",
	].join("\n");
}

function recoveryRecord(
	workspace: string,
	base: string,
	tree: string,
	ref: string,
): RecoveryRecord {
	return {
		workspace,
		base,
		tree,
		ref,
		archive: null,
		verification: "unverified",
	};
}

async function findExistingPublication(
	git: GitPort,
	origin: string,
	input: {
		readonly runId: string;
		readonly workspace: string;
		readonly base: string;
		readonly tree: string;
	},
): Promise<Result<ExistingPublication>> {
	const refs = await listRunRefs(git, origin, input.runId);
	if (!refs.ok) return refs;
	const workspaceRefPrefix = `${recoveryRefPrefix(input.runId)}recovery-${input.workspace}`;
	for (const entry of refs.value) {
		const info = await readCommit(git, origin, entry.commit);
		if (!info.ok) continue;
		if (
			(entry.ref === workspaceRefPrefix ||
				entry.ref === `${workspaceRefPrefix}-${input.tree}`) &&
			info.value.parents.length === 1 &&
			info.value.parents[0] === input.base &&
			info.value.tree === input.tree &&
			info.value.message ===
				recoveryMessage(input.runId, input.workspace, input.base, input.tree)
		) {
			return {
				ok: true,
				value: {
					kind: "recovery",
					record: recoveryRecord(
						input.workspace,
						input.base,
						input.tree,
						entry.ref,
					),
				},
			};
		}
		if (
			!entry.ref.slice(workspaceRefPrefix.length).startsWith("-") &&
			info.value.tree === input.tree &&
			info.value.parents.length === 1 &&
			info.value.parents[0] === input.base &&
			!entry.ref.includes("/recovery-")
		)
			return { ok: true, value: { kind: "candidate" } };
	}
	return { ok: true, value: null };
}

async function listExistingRecoveryRecords(
	git: GitPort,
	origin: string,
	input: {
		readonly runId: string;
		readonly workspace: string;
		readonly base: string;
	},
): Promise<Result<readonly RecoveryRecord[]>> {
	const refs = await listRunRefs(git, origin, input.runId);
	if (!refs.ok) return refs;
	const prefix = `${recoveryRefPrefix(input.runId)}recovery-${input.workspace}`;
	const records: RecoveryRecord[] = [];
	for (const entry of refs.value) {
		if (entry.ref !== prefix && !entry.ref.startsWith(`${prefix}-`)) continue;
		const info = await readCommit(git, origin, entry.commit);
		if (!info.ok) continue;
		if (
			info.value.parents.length !== 1 ||
			info.value.parents[0] !== input.base ||
			info.value.message !==
				recoveryMessage(
					input.runId,
					input.workspace,
					input.base,
					info.value.tree,
				) ||
			(entry.ref !== prefix && entry.ref !== `${prefix}-${info.value.tree}`)
		)
			continue;
		records.push(
			recoveryRecord(input.workspace, input.base, info.value.tree, entry.ref),
		);
	}
	return { ok: true, value: records };
}

function recordAlreadyContains(
	record: RunRecord,
	recovery: RecoveryRecord,
): boolean {
	return record.recovery.some(
		(entry) =>
			entry.workspace === recovery.workspace &&
			entry.base === recovery.base &&
			entry.tree === recovery.tree &&
			entry.ref === recovery.ref &&
			entry.archive === recovery.archive,
	);
}

async function persistRecoveryRecord(
	request: RecoverDeadRunRequest,
	current: RunRecord,
	recovery: RecoveryRecord,
): Promise<Result<RunRecord>> {
	if (recordAlreadyContains(current, recovery))
		return { ok: true, value: current };
	const event = createJournalEvent(
		"recovery_preserved",
		{
			workspace: recovery.workspace,
			base: recovery.base,
			tree: recovery.tree,
			ref: recovery.ref,
			archive: recovery.archive,
			verification: "unverified",
		},
		request.now,
	);
	const persisted = await appendRunEventBeforeSnapshot(
		request.filesystem,
		request.runDirectory,
		current,
		event,
	);
	if (!persisted.ok)
		return errorResult(
			persisted.error.error ??
				failure("io", "Could not persist recovery record."),
		);
	return { ok: true, value: persisted.value.record };
}

async function persistCleanupFailure(
	request: RecoverDeadRunRequest,
	current: RunRecord,
	issue: RecoveryIssue,
): Promise<Result<RunRecord>> {
	const event = createJournalEvent(
		"cleanup_failure",
		{
			workspace: issue.workspace,
			stage: issue.stage,
			failure: issue.error.code,
		},
		request.now,
	);
	const persisted = await appendRunEventBeforeSnapshot(
		request.filesystem,
		request.runDirectory,
		current,
		event,
	);
	if (!persisted.ok)
		return errorResult(
			failure(
				"io",
				"Could not durably record cleanup_failure.",
				persisted.error,
			),
		);
	return { ok: true, value: persisted.value.record };
}

async function persistOutcome(
	request: RecoverDeadRunRequest,
	current: RunRecord,
	outcome: RecoveryOutcome,
): Promise<Result<RunRecord>> {
	const event = createJournalEvent(
		outcome.reconciled ? "reconciled" : "finished",
		{ status: outcome.status, reason: outcome.reason },
		request.now,
	);
	const persisted = await appendRunEventBeforeSnapshot(
		request.filesystem,
		request.runDirectory,
		current,
		event,
	);
	if (!persisted.ok)
		return errorResult(
			failure("io", "Could not persist recovery outcome.", persisted.error),
		);
	return { ok: true, value: persisted.value.record };
}

async function targetBranchContainsCandidate(
	request: RecoverDeadRunRequest,
): Promise<Result<boolean>> {
	const landing = request.record.landing;
	if (landing === null) return { ok: true, value: false };
	const branch = request.record.target_branch.startsWith("refs/heads/")
		? request.record.target_branch
		: `refs/heads/${request.record.target_branch}`;
	const tipResult = await checkedGit(
		request.git,
		request.origin,
		["rev-parse", "--verify", "--end-of-options", `${branch}^{commit}`],
		undefined,
		128,
	);
	if (!tipResult.ok) return tipResult;
	const tipText = text(tipResult.value.stdout, "branch object id");
	if (!tipText.ok) return tipText;
	const tip = tipText.value.trimEnd();
	if (!objectId(tip))
		return errorResult(
			failure("invalid_input", "Target branch has an invalid commit id."),
		);
	const ancestry = await originGit(
		request.git,
		request.origin,
		["merge-base", "--is-ancestor", landing.candidate_commit, tip],
		undefined,
		128,
	);
	if (!ancestry.ok) return ancestry;
	if (ancestry.value.timedOut)
		return errorResult(
			failure("timeout", "Git candidate ancestry check timed out."),
		);
	if (ancestry.value.exitCode === 0) return { ok: true, value: true };
	if (ancestry.value.exitCode === 1) return { ok: true, value: false };
	return errorResult(
		failure("unavailable", "Git candidate ancestry check failed."),
	);
}

async function listCandidateRefs(
	request: RecoverDeadRunRequest,
): Promise<
	Result<readonly { readonly ref: string; readonly commit: string }[]>
> {
	return listRunRefs(request.git, request.origin, request.record.run_id);
}

async function hasMatchingCandidateSnapshot(
	request: RecoverDeadRunRequest,
	workspace: RecoveryWorkspaceTarget,
	tree: string,
): Promise<Result<boolean>> {
	const refs = await listCandidateRefs(request);
	if (!refs.ok) return refs;
	for (const entry of refs.value) {
		if (entry.ref.includes("/recovery-")) continue;
		const commit = await readCommit(request.git, request.origin, entry.commit);
		if (!commit.ok) continue;
		if (
			commit.value.tree === tree &&
			commit.value.parents.length === 1 &&
			commit.value.parents[0] === workspace.baseCommit
		)
			return { ok: true, value: true };
	}
	return { ok: true, value: false };
}

function parseClaimTreeEntry(bytes: Uint8Array): Result<string> {
	if (bytes.byteLength === 0 || bytes[bytes.byteLength - 1] !== 0)
		return errorResult(
			failure("invalid_input", "Project claim tree is malformed."),
		);
	let separator = -1;
	for (let index = 0; index < bytes.byteLength; index += 1) {
		if (bytes[index] === 9) {
			separator = index;
			break;
		}
	}
	if (separator < 0)
		return errorResult(
			failure("invalid_input", "Project claim tree is malformed."),
		);
	const header = String.fromCharCode(...bytes.subarray(0, separator));
	const path = String.fromCharCode(
		...bytes.subarray(separator + 1, bytes.byteLength - 1),
	);
	const match = /^100644 blob ([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(header);
	if (path !== ".kogen/claim" || match?.[1] === undefined)
		return errorResult(
			failure("invalid_input", "Project claim tree is malformed."),
		);
	return { ok: true, value: match[1] };
}

/** Release only the exact project claim still naming this run. */
export async function releaseRecoveryClaimIfOwned(
	git: GitPort,
	origin: string,
	runId: string,
): Promise<Result<"released" | "not_owner">> {
	if (!RUN_ID.test(runId))
		return errorResult(failure("invalid_input", "Recovery run id is invalid."));
	const currentResult = await originGit(
		git,
		origin,
		["rev-parse", "--verify", "--quiet", "--end-of-options", PROJECT_CLAIM_REF],
		undefined,
		128,
	);
	if (!currentResult.ok) return currentResult;
	if (currentResult.value.timedOut)
		return errorResult(failure("timeout", "Project claim read timed out."));
	if (currentResult.value.exitCode === 1)
		return { ok: true, value: "not_owner" };
	if (currentResult.value.exitCode !== 0)
		return errorResult(failure("unavailable", "Could not read project claim."));
	const currentText = text(currentResult.value.stdout, "claim object id");
	if (!currentText.ok) return currentText;
	const commit = currentText.value.trimEnd();
	if (!objectId(commit))
		return errorResult(
			failure("invalid_input", "Project claim id is malformed."),
		);
	const claimCommit = await checkedGit(
		git,
		origin,
		["cat-file", "commit", commit],
		undefined,
		64 * 1024,
	);
	if (!claimCommit.ok) return claimCommit;
	const parsedCommit = parseCommit(claimCommit.value.stdout);
	if (!parsedCommit.ok) return parsedCommit;
	if (parsedCommit.value.parents.length !== 0)
		return errorResult(
			failure("invalid_input", "Project claim is not parentless."),
		);
	const tree = await checkedGit(
		git,
		origin,
		["ls-tree", "-r", "-z", "--full-tree", parsedCommit.value.tree],
		undefined,
		1024,
	);
	if (!tree.ok) return tree;
	const blob = parseClaimTreeEntry(tree.value.stdout);
	if (!blob.ok) return blob;
	const claimBytes = await checkedGit(
		git,
		origin,
		["cat-file", "blob", blob.value],
		undefined,
		128,
	);
	if (!claimBytes.ok) return claimBytes;
	const body = text(claimBytes.value.stdout, "claim blob");
	if (!body.ok) return body;
	const message = `Kogen project claim\n\nKogen-Run: ${runId}\n`;
	if (body.value !== `${runId}\n` || parsedCommit.value.message !== message)
		return { ok: true, value: "not_owner" };
	const remove = await originGit(
		git,
		origin,
		["update-ref", "-d", PROJECT_CLAIM_REF, commit],
		undefined,
		4096,
	);
	if (!remove.ok) return remove;
	if (remove.value.timedOut)
		return errorResult(failure("timeout", "Project claim release timed out."));
	if (remove.value.exitCode === 0) return { ok: true, value: "released" };
	const after = await originGit(
		git,
		origin,
		["rev-parse", "--verify", "--quiet", "--end-of-options", PROJECT_CLAIM_REF],
		undefined,
		128,
	);
	if (!after.ok) return after;
	if (after.value.exitCode === 1) return { ok: true, value: "not_owner" };
	return errorResult(
		failure("conflict", "Project claim changed during recovery release."),
	);
}

async function publishRecoveryRef(
	request: RecoverDeadRunRequest,
	workspace: RecoveryWorkspaceTarget,
	tree: string,
): Promise<Result<RecoveryRecord>> {
	const runId = request.record.run_id;
	const refs = await listRunRefs(request.git, request.origin, runId);
	if (!refs.ok) return refs;
	const prefix = `${recoveryRefPrefix(runId)}recovery-${workspace.id}`;
	const primary = prefix;
	const alternate = `${prefix}-${tree}`;
	const message = recoveryMessage(
		runId,
		workspace.id,
		workspace.baseCommit,
		tree,
	);
	const commitResult = await checkedPrivateGit(
		workspace.repository,
		[
			"-c",
			"user.name=Kogen Recovery",
			"-c",
			"user.email=recovery@kogen.invalid",
			"commit-tree",
			tree,
			"-p",
			workspace.baseCommit,
		],
		encoder.encode(message),
		128,
	);
	if (!commitResult.ok) return commitResult;
	const commitText = text(commitResult.value.stdout, "recovery commit id");
	if (!commitText.ok) return commitText;
	const commit = commitText.value.trimEnd();
	if (!objectId(commit))
		return errorResult(
			failure("invalid_input", "Git returned an invalid recovery commit id."),
		);
	const fetched = await checkedGit(request.git, request.origin, [
		"fetch",
		"--no-tags",
		"--no-recurse-submodules",
		workspace.repository.gitDirectory,
		commit,
	]);
	if (!fetched.ok) return fetched;
	const zero = "0".repeat(commit.length);
	const primaryExists = refs.value.some((entry) => entry.ref === primary);
	const targets = primaryExists ? [alternate] : [primary, alternate];
	for (const target of targets) {
		const refreshed = await listRunRefs(request.git, request.origin, runId);
		if (!refreshed.ok) return refreshed;
		if (refreshed.value.some((entry) => entry.ref === target)) {
			const existing = await findExistingPublication(
				request.git,
				request.origin,
				{
					runId,
					workspace: workspace.id,
					base: workspace.baseCommit,
					tree,
				},
			);
			if (existing.ok && existing.value?.kind === "recovery")
				return { ok: true, value: existing.value.record };
			continue;
		}
		const installed = await originGit(
			request.git,
			request.origin,
			["update-ref", target, commit, zero],
			undefined,
			4096,
		);
		if (!installed.ok) return installed;
		if (installed.value.timedOut)
			return errorResult(
				failure("timeout", "Recovery ref publication timed out."),
			);
		if (installed.value.exitCode === 0)
			return {
				ok: true,
				value: recoveryRecord(workspace.id, workspace.baseCommit, tree, target),
			};
		const raced = await findExistingPublication(request.git, request.origin, {
			runId,
			workspace: workspace.id,
			base: workspace.baseCommit,
			tree,
		});
		if (!raced.ok) return raced;
		if (raced.value?.kind === "recovery")
			return { ok: true, value: raced.value.record };
	}
	return errorResult(
		failure("conflict", "Create-only recovery ref raced with another value."),
	);
}

async function persistWorkspacePreservation(
	request: RecoverDeadRunRequest,
	current: RunRecord,
	workspace: RecoveryWorkspaceTarget,
): Promise<
	Result<{ readonly record: RunRecord; readonly cleanupAllowed: boolean }>
> {
	const present = await safeCall(
		() => workspace.present(),
		"Workspace presence check failed.",
	);
	if (!present.ok) return present;
	if (!present.value)
		return { ok: true, value: { record: current, cleanupAllowed: false } };
	const snapshot = await snapshotWorkspace({
		repository: workspace.repository,
		sourceRepository: workspace.sourceRepository,
		baseCommit: workspace.baseCommit,
		filesystem: request.filesystem,
	});
	if (!snapshot.ok) return snapshot;
	const existingRefs = await listExistingRecoveryRecords(
		request.git,
		request.origin,
		{
			runId: current.run_id,
			workspace: workspace.id,
			base: workspace.baseCommit,
		},
	);
	if (!existingRefs.ok) return existingRefs;
	for (const artifact of existingRefs.value) {
		const persisted = await persistRecoveryRecord(request, current, artifact);
		if (!persisted.ok) return persisted;
		current = persisted.value;
	}
	let archivePublications: readonly RecoveryArchivePublication[] = [];
	if (request.archive !== undefined) {
		const listed = await safeCall(
			() =>
				request.archive?.listComplete({
					runId: current.run_id,
					workspace: workspace.id,
					base: workspace.baseCommit,
				}) ?? Promise.resolve({ ok: true, value: [] }),
			"Recovery archive listing failed.",
		);
		if (!listed.ok) return listed;
		archivePublications = listed.value;
		for (const publication of archivePublications) {
			if (!objectId(publication.tree) || publication.archive.length === 0)
				return errorResult(
					failure("invalid_input", "Recovery archive manifest is malformed."),
				);
			const artifact: RecoveryRecord = {
				workspace: workspace.id,
				base: workspace.baseCommit,
				tree: null,
				ref: null,
				archive: publication.archive,
				verification: "unverified",
			};
			const persisted = await persistRecoveryRecord(request, current, artifact);
			if (!persisted.ok) return persisted;
			current = persisted.value;
		}
	}
	const candidate = await hasMatchingCandidateSnapshot(
		request,
		workspace,
		snapshot.value.tree,
	);
	if (!candidate.ok) return candidate;
	const prior = await findExistingPublication(request.git, request.origin, {
		runId: current.run_id,
		workspace: workspace.id,
		base: workspace.baseCommit,
		tree: snapshot.value.tree,
	});
	if (!prior.ok) return prior;
	const decision = recoveryWorkspaceTransition({
		tree: snapshot.value.tree,
		baseTree: snapshot.value.baseTree,
		hasMatchingDurableSnapshot:
			candidate.value ||
			prior.value?.kind === "candidate" ||
			prior.value?.kind === "recovery" ||
			archivePublications.some(
				(publication) => publication.tree === snapshot.value.tree,
			),
	});
	if (decision.kind === "already_durable") {
		return { ok: true, value: { record: current, cleanupAllowed: true } };
	}
	const archiveRequest: RecoveryArchiveRequest = {
		runId: current.run_id,
		workspace: workspace.id,
		base: workspace.baseCommit,
		tree: snapshot.value.tree,
		repository: workspace.repository,
	};
	if (request.archive !== undefined) {
		const priorArchive = archivePublications.find(
			(publication) => publication.tree === snapshot.value.tree,
		);
		if (priorArchive !== undefined) {
			const artifact: RecoveryRecord = {
				workspace: workspace.id,
				base: workspace.baseCommit,
				tree: null,
				ref: null,
				archive: priorArchive.archive,
				verification: "unverified",
			};
			const persisted = await persistRecoveryRecord(request, current, artifact);
			if (!persisted.ok) return persisted;
			return {
				ok: true,
				value: { record: persisted.value, cleanupAllowed: true },
			};
		}
	}
	const publishedRef = await publishRecoveryRef(
		request,
		workspace,
		snapshot.value.tree,
	);
	if (publishedRef.ok) {
		const persisted = await persistRecoveryRecord(
			request,
			current,
			publishedRef.value,
		);
		if (!persisted.ok) return persisted;
		return {
			ok: true,
			value: { record: persisted.value, cleanupAllowed: true },
		};
	}
	if (request.archive !== undefined) {
		const archived = await safeCall(
			() =>
				request.archive?.publishCreateOnly(archiveRequest) ??
				Promise.reject(new Error("archive port disappeared")),
			"Recovery archive publication failed.",
		);
		if (archived.ok) {
			const verified = await safeCall(
				() =>
					request.archive?.listComplete({
						runId: current.run_id,
						workspace: workspace.id,
						base: workspace.baseCommit,
					}) ?? Promise.resolve({ ok: true, value: [] }),
				"Recovery archive verification failed.",
			);
			const match = verified.ok
				? verified.value.find(
						(publication) =>
							publication.tree === snapshot.value.tree &&
							publication.archive === archived.value,
					)
				: undefined;
			if (match !== undefined) {
				const artifact: RecoveryRecord = {
					workspace: workspace.id,
					base: workspace.baseCommit,
					tree: null,
					ref: null,
					archive: archived.value,
					verification: "unverified",
				};
				const persisted = await persistRecoveryRecord(
					request,
					current,
					artifact,
				);
				if (!persisted.ok) return persisted;
				return {
					ok: true,
					value: { record: persisted.value, cleanupAllowed: true },
				};
			}
		}
	}
	return publishedRef;
}

function latestJournalOutcome(
	event: JournalEvent | null,
): { status: RunStatus; reason: string } | null {
	if (
		event === null ||
		(event.event !== "finished" && event.event !== "reconciled")
	)
		return null;
	const status = event.status;
	const reason = event.reason;
	if (
		(status === "landed" ||
			status === "failed" ||
			status === "parked" ||
			status === "stopped") &&
		typeof reason === "string"
	)
		return { status, reason };
	return null;
}

async function candidateIsOnBase(
	request: RecoverDeadRunRequest,
	journalOutcome: ReturnType<typeof latestJournalOutcome>,
): Promise<Result<boolean>> {
	if (request.record.status !== "running" || journalOutcome !== null)
		return { ok: true, value: false };
	return targetBranchContainsCandidate(request);
}

async function persistCleanupComplete(
	request: RecoverDeadRunRequest,
	current: RunRecord,
): Promise<Result<RunRecord>> {
	const event = createJournalEvent(
		"recovery_cleanup_complete",
		{},
		request.now,
	);
	const appended = await appendRunEventBeforeSnapshot(
		request.filesystem,
		request.runDirectory,
		current,
		event,
	);
	if (!appended.ok)
		return errorResult(
			failure(
				"io",
				"Could not record completed recovery cleanup.",
				appended.error,
			),
		);
	const next = { ...appended.value.record, cleanup_pending: false };
	const written = await writeRunSnapshot(
		request.filesystem,
		request.runDirectory,
		next,
	);
	if (!written.ok)
		return errorResult(
			failure("io", "Could not clear recovery cleanup_pending.", written.error),
		);
	return { ok: true, value: next };
}

/**
 * Recover one stale Build. Every destructive workspace operation follows a
 * durable tree/ref or archive result and a `recovery_preserved` snapshot event.
 */
export async function recoverDeadRun(
	request: RecoverDeadRunRequest,
): Promise<Result<RecoveryReport>> {
	const { record } = request;
	if (
		!validateRunRecord(record) ||
		!RUN_ID.test(record.run_id) ||
		!Number.isSafeInteger(record.owner_pid) ||
		record.owner_pid <= 0 ||
		!request.origin.startsWith("/") ||
		request.origin.includes("\0") ||
		!request.runDirectory.startsWith("/") ||
		request.runDirectory.includes("\0")
	)
		return errorResult(
			failure("invalid_input", "Run owner identity is invalid."),
		);
	const workspaceIds = request.workspaces.map((workspace) => workspace.id);
	if (new Set(workspaceIds).size !== workspaceIds.length)
		return errorResult(
			failure("invalid_input", "Recovery workspace ids must be unique."),
		);
	let ownerObservation: Awaited<ReturnType<ProcessIdentityPort["inspect"]>>;
	try {
		ownerObservation = await request.identity.inspect(record.owner_pid);
	} catch {
		return { ok: true, value: { kind: "owner_unknown", record } };
	}
	if (!ownerObservation.ok)
		return { ok: true, value: { kind: "owner_unknown", record } };
	const owner: QueueOwnerIdentity = {
		pid: record.owner_pid,
		startedMs: record.owner_started_ms,
	};
	const ownerDecision = recoveryOwnerDecision(owner, ownerObservation.value);
	if (ownerDecision === "live")
		return { ok: true, value: { kind: "live_owner", record } };
	if (ownerDecision === "unknown")
		return { ok: true, value: { kind: "owner_unknown", record } };
	const stopped = await safeCall(
		() => request.stopWriters(record),
		"Could not stop run-owned workspace writers.",
	);
	if (!stopped.ok)
		return {
			ok: true,
			value: {
				kind: "deferred",
				record,
				issue: {
					workspace: "run",
					stage: "stop_writers",
					error: stopped.error,
				},
			},
		};
	const journalOutcome =
		latestJournalOutcome(request.latestEvent) ??
		request.recordedOutcome ??
		null;
	const onBase = await candidateIsOnBase(request, journalOutcome);
	if (!onBase.ok)
		return {
			ok: true,
			value: {
				kind: "deferred",
				record,
				issue: { workspace: "run", stage: "snapshot", error: onBase.error },
			},
		};
	const lastEvent = request.latestEvent?.event ?? null;
	const outcome = recoveryOutcomeTransition({
		record,
		lastEvent,
		journalOutcome,
		onBase: onBase.value,
	});
	let current = record;
	if (record.status === "running") {
		const outcomeRecord = await persistOutcome(request, current, outcome);
		if (!outcomeRecord.ok)
			return {
				ok: true,
				value: {
					kind: "deferred",
					record: current,
					issue: {
						workspace: "run",
						stage: "record",
						error: outcomeRecord.error,
					},
				},
			};
		current = outcomeRecord.value;
	}
	const issues: RecoveryIssue[] = [];
	const cleanupEligible: boolean[] = [];
	for (const workspace of request.workspaces) {
		if (!WORKSPACE_ID.test(workspace.id)) {
			const issue: RecoveryIssue = {
				workspace: workspace.id,
				stage: "snapshot",
				error: failure(
					"invalid_input",
					"Recovery workspace id is not ref-safe.",
				),
			};
			issues.push(issue);
			cleanupEligible.push(false);
			const logged = await persistCleanupFailure(request, current, issue);
			if (!logged.ok) return errorResult(logged.error);
			current = logged.value;
			continue;
		}
		const preserved = await persistWorkspacePreservation(
			request,
			current,
			workspace,
		);
		if (!preserved.ok) {
			const issue: RecoveryIssue = {
				workspace: workspace.id,
				stage:
					preserved.error.message.includes("ref") ||
					preserved.error.message.includes("archive")
						? "publication"
						: "snapshot",
				error: preserved.error,
			};
			issues.push(issue);
			cleanupEligible.push(false);
			const logged = await persistCleanupFailure(request, current, issue);
			if (!logged.ok) return errorResult(logged.error);
			current = logged.value;
			continue;
		}
		current = preserved.value.record;
		cleanupEligible.push(
			preserved.value.cleanupAllowed &&
				recoveryMayRemoveWorkspace(preserved.value.cleanupAllowed),
		);
	}
	const released = await releaseRecoveryClaimIfOwned(
		request.git,
		request.origin,
		current.run_id,
	);
	if (!released.ok) {
		const issue: RecoveryIssue = {
			workspace: "run",
			stage: "claim_release",
			error: released.error,
		};
		issues.push(issue);
		const logged = await persistCleanupFailure(request, current, issue);
		if (!logged.ok) return errorResult(logged.error);
		current = logged.value;
	}
	for (const [index, workspace] of request.workspaces.entries()) {
		if (!cleanupEligible[index]) continue;
		const removed = await safeCall(
			() => workspace.remove(),
			"Workspace cleanup failed.",
		);
		if (removed.ok) continue;
		const issue: RecoveryIssue = {
			workspace: workspace.id,
			stage: "workspace_cleanup",
			error: removed.error,
		};
		issues.push(issue);
		const logged = await persistCleanupFailure(request, current, issue);
		if (!logged.ok) return errorResult(logged.error);
		current = logged.value;
	}
	if (recoveryMayRemoveIncoming(outcome, current)) {
		const removedIncoming = await removeIncomingRef(request, current);
		if (!removedIncoming.ok) {
			const issue: RecoveryIssue = {
				workspace: "run",
				stage: "incoming_cleanup",
				error: removedIncoming.error,
			};
			issues.push(issue);
			const logged = await persistCleanupFailure(request, current, issue);
			if (!logged.ok) return errorResult(logged.error);
			current = logged.value;
		}
	}
	if (issues.length > 0)
		return {
			ok: true,
			value: {
				kind: "cleanup_pending",
				outcome,
				record: current,
				failures: issues,
			},
		};
	if (current.cleanup_pending) {
		const cleared = await persistCleanupComplete(request, current);
		if (!cleared.ok)
			return {
				ok: true,
				value: {
					kind: "cleanup_pending",
					outcome,
					record: current,
					failures: [
						{ workspace: "run", stage: "record", error: cleared.error },
					],
				},
			};
		current = cleared.value;
	}
	return { ok: true, value: { kind: "recovered", outcome, record: current } };
}

async function removeIncomingRef(
	request: RecoverDeadRunRequest,
	current: RunRecord,
): Promise<Result<void>> {
	const landing = current.landing;
	if (landing === null) return { ok: true, value: undefined };
	const ref = `refs/kogen/incoming/${current.run_id}`;
	const existing = await originGit(
		request.git,
		request.origin,
		["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
		undefined,
		128,
	);
	if (!existing.ok) return existing;
	if (existing.value.timedOut)
		return errorResult(failure("timeout", "Incoming ref read timed out."));
	if (existing.value.exitCode === 1) return { ok: true, value: undefined };
	if (existing.value.exitCode !== 0)
		return errorResult(failure("unavailable", "Could not read incoming ref."));
	const idText = text(existing.value.stdout, "incoming object id");
	if (!idText.ok) return idText;
	const commit = idText.value.trimEnd();
	if (commit !== landing.candidate_commit)
		return errorResult(
			failure("conflict", "Incoming ref no longer names the landed candidate."),
		);
	const removed = await originGit(
		request.git,
		request.origin,
		["update-ref", "-d", ref, commit],
		undefined,
		4096,
	);
	if (!removed.ok) return removed;
	if (removed.value.timedOut)
		return errorResult(failure("timeout", "Incoming ref cleanup timed out."));
	if (removed.value.exitCode === 0) return { ok: true, value: undefined };
	const after = await originGit(
		request.git,
		request.origin,
		["rev-parse", "--verify", "--quiet", "--end-of-options", ref],
		undefined,
		128,
	);
	if (!after.ok) return after;
	if (after.value.exitCode === 1) return { ok: true, value: undefined };
	return errorResult(
		failure("conflict", "Incoming ref changed during cleanup."),
	);
}
