import { basename, dirname, isAbsolute } from "node:path";
import type { PortError, Result } from "../../contracts/errors";
import type { GitPort, ProcessResult } from "../../contracts/ports";
import {
	type FileSystemHostRequest,
	FileSystemStatus,
	readControllerFileBytes,
} from "../../fs/read";
import {
	GIT_DEFAULT_TIMEOUT_MS,
	GIT_MAX_OUTPUT_LIMIT_BYTES,
} from "../../git/command";
import {
	appendRunEventBeforeSnapshot,
	applyRunEventToRecord,
	createJournalEvent,
	type LandingCasPersistence,
	type LandingRecord,
	persistLandingPreparedBeforeCas,
	type RunRecord,
	validateRunRecord,
} from "../../run/store";
import type { LandingCommit } from "./commit";
import {
	applyLandingCheckoutSync,
	type LandingCheckoutSyncPlan,
	planLandingCheckoutSync,
} from "./sync";
import {
	initialLandingState,
	type LandingState,
	landingTransition,
} from "./transition";

const DECODER = new TextDecoder("utf-8", { fatal: true });
const RUN_ID = /^[a-f0-9]{32}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type LandingPublishFailure = PortError;

export type LandingPublishOutcome =
	| {
			readonly kind: "not_landed";
			readonly reason: "branch_locked" | "base_moved" | "ref_conflict";
			readonly currentBase: string | null;
			readonly record: RunRecord;
	  }
	| {
			readonly kind: "landed";
			readonly record: RunRecord;
			readonly candidateCommit: string;
			readonly incomingRef: string;
			readonly warnings: readonly string[];
			readonly cleanupPending: boolean;
			readonly terminalRecordPersisted: boolean;
			readonly cleanupFailurePersisted: boolean;
	  };

export interface LandingPublishRequest {
	readonly origin: string;
	readonly runDirectory: string;
	readonly run: RunRecord;
	readonly candidate: LandingCommit;
	readonly filesystem: FileSystemHostRequest;
	/** This must use the public Git configuration path. */
	readonly git: Pick<GitPort, "command">;
	readonly now?: () => number;
}

function error(
	code: PortError["code"],
	message: string,
	retryable = false,
	cause?: unknown,
): PortError {
	return {
		code,
		message,
		retryable,
		...(cause === undefined ? {} : { cause }),
	};
}

async function git(
	port: Pick<GitPort, "command">,
	repository: string,
	argv: readonly string[],
	outputLimitBytes = GIT_MAX_OUTPUT_LIMIT_BYTES,
): Promise<Result<ProcessResult>> {
	try {
		return await port.command({
			repository,
			argv,
			timeoutMilliseconds: GIT_DEFAULT_TIMEOUT_MS,
			outputLimitBytes,
		});
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"unavailable",
				`Git ${argv[0] ?? "command"} failed.`,
				true,
				cause,
			),
		};
	}
}

function commandText(
	result: Result<ProcessResult>,
	command: string,
): Result<string> {
	if (!result.ok) return result;
	if (result.value.timedOut || result.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Git ${command} failed with exit ${String(result.value.exitCode)}.`,
				true,
			),
		};
	try {
		return { ok: true, value: DECODER.decode(result.value.stdout) };
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"unavailable",
				`Git ${command} returned invalid UTF-8.`,
				false,
				cause,
			),
		};
	}
}

function validObjectId(value: string, length: number): boolean {
	return value.length === length && /^[a-f0-9]+$/u.test(value);
}

async function exactRef(
	port: Pick<GitPort, "command">,
	origin: string,
	ref: string,
): Promise<Result<string | null>> {
	const symbolic = await git(
		port,
		origin,
		["symbolic-ref", "--quiet", ref],
		1024,
	);
	if (!symbolic.ok) return symbolic;
	if (symbolic.value.timedOut)
		return {
			ok: false,
			error: error("timeout", "Git ref lookup timed out.", true),
		};
	if (symbolic.value.exitCode === 0)
		return {
			ok: false,
			error: error("invalid_input", `Landing ref ${ref} must not be symbolic.`),
		};
	if (symbolic.value.exitCode !== 1)
		return {
			ok: false,
			error: error("unavailable", `Git could not inspect ref ${ref}.`, true),
		};
	const listed = await git(
		port,
		origin,
		["for-each-ref", "--format=%(refname)%00%(objectname)", ref],
		4096,
	);
	const output = commandText(listed, "ref lookup");
	if (!output.ok) return output;
	const text = output.value.endsWith("\n")
		? output.value.slice(0, -1)
		: output.value;
	if (text.length === 0) return { ok: true, value: null };
	const split = text.indexOf("\0");
	const name = split < 0 ? undefined : text.slice(0, split);
	const objectId = split < 0 ? undefined : text.slice(split + 1);
	if (
		name !== ref ||
		objectId === undefined ||
		!OBJECT_ID.test(objectId) ||
		text.includes("\n")
	)
		return {
			ok: false,
			error: error("unavailable", `Git returned an invalid value for ${ref}.`),
		};
	return { ok: true, value: objectId };
}

async function candidateMatches(
	request: LandingPublishRequest,
	landing: LandingRecord,
): Promise<Result<boolean>> {
	const output = await git(
		request.git,
		request.origin,
		["cat-file", "-p", landing.candidate_commit],
		64 * 1024,
	);
	const text = commandText(output, "candidate verification");
	if (!text.ok) return text;
	const split = text.value.indexOf("\n\n");
	if (split < 0)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Landing candidate has invalid commit headers.",
			),
		};
	const headers = text.value.slice(0, split).split("\n");
	const treeLines = headers.filter((line) => line.startsWith("tree "));
	const parentLines = headers.filter((line) => line.startsWith("parent "));
	return {
		ok: true,
		value:
			treeLines.length === 1 &&
			treeLines[0] === `tree ${landing.final_tree}` &&
			parentLines.length === 1 &&
			parentLines[0] === `parent ${landing.expected_parent}`,
	};
}

async function branchLockExists(
	request: LandingPublishRequest,
	branchRef: string,
): Promise<Result<boolean>> {
	const lockPathResult = await git(
		request.git,
		request.origin,
		["rev-parse", "--path-format=absolute", "--git-path", `${branchRef}.lock`],
		4096,
	);
	const lockPathText = commandText(lockPathResult, "branch lock path lookup");
	if (!lockPathText.ok) return lockPathText;
	const lockPath = lockPathText.value.trimEnd();
	if (!isAbsolute(lockPath) || /[\r\n\0]/u.test(lockPath))
		return {
			ok: false,
			error: error("unavailable", "Git returned an invalid branch lock path."),
		};
	const read = await readControllerFileBytes(request.filesystem, {
		root: new TextEncoder().encode(dirname(lockPath)),
		path: new TextEncoder().encode(basename(lockPath)),
		maxBytes: 4096,
	});
	if (read.ok) return { ok: true, value: true };
	if (read.error.code === "not_found") return { ok: true, value: false };
	if (
		typeof read.error.cause === "object" &&
		read.error.cause !== null &&
		"status" in read.error.cause &&
		read.error.cause.status === FileSystemStatus.tooLarge
	)
		return { ok: true, value: true };
	return {
		ok: false,
		error: error(
			"unavailable",
			`Could not safely determine whether the target branch is locked: ${read.error.message}`,
			true,
		),
	};
}

async function updateRef(
	port: Pick<GitPort, "command">,
	origin: string,
	argv: readonly string[],
): Promise<Result<void>> {
	const result = await git(port, origin, argv, 4096);
	if (!result.ok) return result;
	if (result.value.timedOut)
		return {
			ok: false,
			error: error(
				"timeout",
				`Git ${argv[0] ?? "update-ref"} timed out.`,
				true,
			),
		};
	if (result.value.exitCode !== 0)
		return {
			ok: false,
			error: error(
				"unavailable",
				`Git ${argv[0] ?? "update-ref"} failed.`,
				true,
			),
		};
	return { ok: true, value: undefined };
}

function landingEvent(request: LandingPublishRequest, landing: LandingRecord) {
	return createJournalEvent(
		"landing_prepared",
		{
			landing: {
				approval_commit: landing.approval_commit,
				run_id: landing.run_id,
				expected_parent: landing.expected_parent,
				final_tree: landing.final_tree,
				candidate_commit: landing.candidate_commit,
			},
		},
		request.now ?? Date.now,
	);
}

function validRequest(request: LandingPublishRequest): PortError | null {
	if (
		!isAbsolute(request.origin) ||
		!isAbsolute(request.runDirectory) ||
		request.origin.includes("\0") ||
		request.runDirectory.includes("\0") ||
		!validateRunRecord(request.run) ||
		request.run.status !== "running" ||
		!RUN_ID.test(request.run.run_id) ||
		!OBJECT_ID.test(request.candidate.commit) ||
		!OBJECT_ID.test(request.candidate.tree) ||
		request.candidate.commit.length !== request.candidate.tree.length ||
		request.candidate.parent.length !== request.candidate.commit.length
	)
		return error("invalid_input", "Landing publication inputs are invalid.");
	return null;
}

async function persistEvent(
	request: LandingPublishRequest,
	current: RunRecord,
	eventName: string,
	fields: Readonly<Record<string, string | number | boolean>>,
): Promise<{ readonly record: RunRecord; readonly persisted: boolean }> {
	const event = createJournalEvent(eventName, fields, request.now ?? Date.now);
	const result = await appendRunEventBeforeSnapshot(
		request.filesystem,
		request.runDirectory,
		current,
		event,
	);
	if (result.ok) return { record: result.value.record, persisted: true };
	if (result.error.eventState === "durable") {
		try {
			return {
				record: applyRunEventToRecord(current, event),
				persisted: false,
			};
		} catch {
			// The journal remains authoritative when a snapshot could not be replaced.
		}
	}
	return { record: current, persisted: false };
}

export async function publishLanding(
	request: LandingPublishRequest,
): Promise<Result<LandingPublishOutcome, LandingPublishFailure>> {
	const invalid = validRequest(request);
	if (invalid) return { ok: false, error: invalid };
	const branchRef = `refs/heads/${request.run.target_branch}`;
	const incomingRef = `refs/kogen/incoming/${request.run.run_id}`;
	const refFormat = await git(
		request.git,
		request.origin,
		["check-ref-format", branchRef],
		1024,
	);
	if (
		!refFormat.ok ||
		refFormat.value.timedOut ||
		refFormat.value.exitCode !== 0
	)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Landing target branch is not a valid Git branch.",
			),
		};
	const objectIdLength = request.candidate.objectFormat === "sha1" ? 40 : 64;
	if (
		!validObjectId(request.candidate.commit, objectIdLength) ||
		!validObjectId(request.candidate.tree, objectIdLength) ||
		!validObjectId(request.candidate.parent, objectIdLength)
	)
		return {
			ok: false,
			error: error(
				"invalid_input",
				"Landing object ids do not match the repository format.",
			),
		};
	const landing: LandingRecord = {
		approval_commit: request.run.approval_commit,
		run_id: request.run.run_id,
		expected_parent: request.candidate.parent,
		final_tree: request.candidate.tree,
		candidate_commit: request.candidate.commit,
	};
	const commitResult = await appendRunEventBeforeSnapshot(
		request.filesystem,
		request.runDirectory,
		request.run,
		createJournalEvent(
			"commit_result",
			{
				commit: request.candidate.commit,
				tree: request.candidate.tree,
			},
			request.now ?? Date.now,
		),
	);
	if (!commitResult.ok)
		return {
			ok: false,
			error: error(
				"io",
				`Could not durably record the landing commit result: ${commitResult.error.error.message}`,
				true,
			),
		};
	let state: LandingState = initialLandingState(landing);
	let persisted: LandingCasPersistence<
		| {
				readonly kind: "not_landed";
				readonly reason: "branch_locked" | "base_moved" | "ref_conflict";
				readonly currentBase: string | null;
		  }
		| {
				readonly kind: "base_cas_succeeded";
				readonly checkoutPlan: LandingCheckoutSyncPlan;
		  }
	>;
	try {
		persisted = await persistLandingPreparedBeforeCas(
			request.filesystem,
			request.runDirectory,
			commitResult.value.record,
			landingEvent(request, landing),
			async () => {
				state = landingTransition(state, { type: "record_persisted" }).state;
				const matches = await candidateMatches(request, landing);
				if (!matches.ok) throw new Error(matches.error.message);
				if (!matches.value)
					throw new Error(
						"Landing candidate tree or sole parent does not match the verified result.",
					);
				const lock = await branchLockExists(request, branchRef);
				if (!lock.ok) throw new Error(lock.error.message);
				if (lock.value)
					return {
						kind: "not_landed",
						reason: "branch_locked",
						currentBase: request.candidate.parent,
					};
				const currentBase = await exactRef(
					request.git,
					request.origin,
					branchRef,
				);
				if (!currentBase.ok) throw new Error(currentBase.error.message);
				if (currentBase.value !== request.candidate.parent)
					return {
						kind: "not_landed",
						reason: "base_moved",
						currentBase: currentBase.value,
					};
				const planned = await planLandingCheckoutSync(request.git, {
					origin: request.origin,
					branch: request.run.target_branch,
					expectedParent: request.candidate.parent,
					candidateCommit: request.candidate.commit,
				});
				if (!planned.ok) throw new Error(planned.error.message);
				const existingIncoming = await exactRef(
					request.git,
					request.origin,
					incomingRef,
				);
				if (!existingIncoming.ok)
					throw new Error(existingIncoming.error.message);
				if (
					existingIncoming.value !== null &&
					existingIncoming.value !== request.candidate.commit
				)
					return {
						kind: "not_landed",
						reason: "ref_conflict",
						currentBase: currentBase.value,
					};
				if (existingIncoming.value === null) {
					const createdIncoming = await updateRef(request.git, request.origin, [
						"update-ref",
						incomingRef,
						request.candidate.commit,
						"0".repeat(objectIdLength),
					]);
					if (!createdIncoming.ok) {
						const afterFailure = await exactRef(
							request.git,
							request.origin,
							incomingRef,
						);
						if (
							!afterFailure.ok ||
							afterFailure.value !== request.candidate.commit
						)
							throw new Error(createdIncoming.error.message);
					}
				}
				state = landingTransition(state, { type: "incoming_published" }).state;
				const moved = await updateRef(request.git, request.origin, [
					"update-ref",
					branchRef,
					request.candidate.commit,
					request.candidate.parent,
				]);
				if (!moved.ok) {
					const afterFailure = await exactRef(
						request.git,
						request.origin,
						branchRef,
					);
					if (!afterFailure.ok) throw new Error(moved.error.message);
					if (afterFailure.value !== request.candidate.commit) {
						if (afterFailure.value !== request.candidate.parent)
							return {
								kind: "not_landed",
								reason: "base_moved",
								currentBase: afterFailure.value,
							};
						throw new Error(moved.error.message);
					}
				}
				state = landingTransition(state, {
					type: "base_cas_succeeded",
				}).state;
				return { kind: "base_cas_succeeded", checkoutPlan: planned.value };
			},
		);
	} catch (cause) {
		return {
			ok: false,
			error: error(
				"unavailable",
				`Landing stopped after the durable landing record: ${cause instanceof Error ? cause.message : "Git or landing effect failed"}`,
				true,
				cause,
			),
		};
	}
	if (!persisted.ok)
		return {
			ok: false,
			error: error(
				"io",
				`Could not durably record landing before ref publication: ${persisted.error.error.message}`,
				true,
			),
		};
	const recordAfterPrepared = persisted.record;
	const attempt = persisted.casResult;
	if (attempt.kind === "not_landed")
		return {
			ok: true,
			value: { ...attempt, record: recordAfterPrepared },
		};
	const checkoutPlan = attempt.checkoutPlan;
	const terminal = await persistEvent(
		request,
		recordAfterPrepared,
		"finished",
		{
			status: "landed",
		},
	);
	let runRecord = terminal.record;
	const warnings =
		checkoutPlan === null
			? []
			: [...(await applyLandingCheckoutSync(request.git, checkoutPlan))];
	state = landingTransition(state, {
		type: "checkouts_synchronized",
		warnings,
	}).state;
	for (const message of warnings) {
		const warningRecord = await persistEvent(
			request,
			runRecord,
			"landing_warning",
			{
				sha: request.candidate.commit,
				branch: request.run.target_branch,
				warning: message,
			},
		);
		runRecord = warningRecord.record;
	}
	const deleted = await updateRef(request.git, request.origin, [
		"update-ref",
		"-d",
		incomingRef,
		request.candidate.commit,
	]);
	let cleanupPending = false;
	let cleanupFailurePersisted = true;
	if (!deleted.ok) {
		const existingIncoming = await exactRef(
			request.git,
			request.origin,
			incomingRef,
		);
		if (!existingIncoming.ok || existingIncoming.value !== null) {
			cleanupPending = true;
			const cleanupTransition = landingTransition(state, {
				type: "cleanup_failed",
				warning: `incoming ref cleanup failed: ${deleted.error.message}`,
			});
			state = cleanupTransition.state;
			const failureRecord = await persistEvent(
				request,
				runRecord,
				"cleanup_failure",
				{
					action: "delete_incoming_ref",
					ref: incomingRef,
				},
			);
			runRecord = failureRecord.record;
			cleanupFailurePersisted = failureRecord.persisted;
		}
	}
	if (!cleanupPending)
		state = landingTransition(state, { type: "incoming_deleted" }).state;
	return {
		ok: true,
		value: {
			kind: "landed",
			record: runRecord,
			candidateCommit: request.candidate.commit,
			incomingRef,
			warnings,
			cleanupPending: cleanupPending || runRecord.cleanup_pending,
			terminalRecordPersisted: terminal.persisted,
			cleanupFailurePersisted,
		},
	};
}
