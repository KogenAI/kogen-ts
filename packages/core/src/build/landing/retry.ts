import type { PortError, Result } from "../../contracts/errors";
import type { JsonValue } from "../../run/journal";
import type { RunRecord } from "../../run/store";
import type { LandingCommit } from "./commit";
import type { LandingPublishOutcome } from "./publish";
import {
	type LandingRebaseOutcome,
	LandingRepairAllowance,
	type WinningBuildConversation,
} from "./rebase";

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export const LANDING_RETRY_DELAYS_MILLISECONDS = Object.freeze([
	1_000, 2_000, 4_000,
]);

export interface LandingRetryPorts<State> {
	publish(input: {
		readonly run: RunRecord;
		readonly candidate: LandingCommit;
	}): Promise<Result<LandingPublishOutcome>>;
	/** Delete this run's old incoming ref with an expected-value CAS; missing is OK. */
	discardIncoming(input: {
		readonly runId: string;
		readonly candidate: LandingCommit;
	}): Promise<Result<void>>;
	rebase(input: {
		readonly run: RunRecord;
		readonly rung: string;
		readonly candidate: LandingCommit;
		readonly bestCandidate: LandingCommit;
		readonly conversation: WinningBuildConversation<State>;
		readonly allowance: LandingRepairAllowance;
	}): Promise<LandingRebaseOutcome<State>>;
	emit(
		event: "landing_retry",
		fields: Readonly<Record<string, JsonValue>>,
	): Promise<void>;
	sleep(milliseconds: number): Promise<void>;
}

export interface LandingRetryRequest<State> {
	readonly run: RunRecord;
	readonly rung: string;
	readonly candidate: LandingCommit;
	readonly conversation: WinningBuildConversation<State>;
	readonly allowance?: LandingRepairAllowance;
}

export type LandingRetryOutcome<State> =
	| {
			readonly kind: "landed";
			readonly publish: Extract<
				LandingPublishOutcome,
				{ readonly kind: "landed" }
			>;
			readonly candidate: LandingCommit;
			readonly bestCandidate: LandingCommit;
			readonly conversation: WinningBuildConversation<State>;
			readonly record: RunRecord;
	  }
	| {
			readonly kind: "parked";
			readonly reason: string;
			readonly bestCandidate: LandingCommit;
			readonly conversation: WinningBuildConversation<State>;
			readonly record: RunRecord;
	  }
	| {
			readonly kind: "stopped";
			readonly failure: PortError;
			readonly bestCandidate: LandingCommit;
			readonly conversation: WinningBuildConversation<State>;
			readonly record: RunRecord;
	  };

function stop<State>(
	_request: LandingRetryRequest<State>,
	run: RunRecord,
	bestCandidate: LandingCommit,
	conversation: WinningBuildConversation<State>,
	failure: PortError,
): LandingRetryOutcome<State> {
	return {
		kind: "stopped",
		failure,
		bestCandidate,
		conversation,
		record: run,
	};
}

function park<State>(
	run: RunRecord,
	bestCandidate: LandingCommit,
	conversation: WinningBuildConversation<State>,
	reason: string,
): LandingRetryOutcome<State> {
	return {
		kind: "parked",
		reason,
		bestCandidate,
		conversation,
		record: run,
	};
}

function isSameLanding(
	candidate: LandingCommit,
	other: LandingCommit,
): boolean {
	return candidate.parent === other.parent && candidate.tree === other.tree;
}

function isLandingCommit(candidate: LandingCommit): boolean {
	return (
		OBJECT_ID.test(candidate.commit) &&
		OBJECT_ID.test(candidate.parent) &&
		OBJECT_ID.test(candidate.tree) &&
		candidate.commit.length === candidate.parent.length &&
		candidate.commit.length === candidate.tree.length &&
		candidate.objectFormat ===
			(candidate.commit.length === 40 ? "sha1" : "sha256")
	);
}

function isConversation<State>(
	conversation: WinningBuildConversation<State>,
): boolean {
	return (
		typeof conversation.id === "string" &&
		conversation.id.length > 0 &&
		!/[\r\n\0]/u.test(conversation.id)
	);
}

/** Retry transient landing failures, then rebase and re-gate before retrying. */
export async function retryLanding<State>(
	request: LandingRetryRequest<State>,
	ports: LandingRetryPorts<State>,
): Promise<LandingRetryOutcome<State>> {
	let run = request.run;
	let candidate = request.candidate;
	let bestCandidate = request.candidate;
	let conversation = request.conversation;
	const allowance = request.allowance ?? new LandingRepairAllowance();
	let delayIndex = 0;
	let totalRetries = 0;
	let lastRebasedLanding: LandingCommit | null = null;
	if (
		!/^[a-f0-9]{32}$/u.test(run.run_id) ||
		run.status !== "running" ||
		!/^R[1-9][0-9]*$/u.test(request.rung) ||
		!isLandingCommit(candidate) ||
		!isConversation(conversation)
	)
		return stop(request, run, bestCandidate, conversation, {
			code: "invalid_input",
			message: "Landing retry inputs are invalid.",
			retryable: false,
		});

	while (true) {
		let attempted: Result<LandingPublishOutcome>;
		try {
			attempted = await ports.publish({ run, candidate });
		} catch (cause) {
			return stop(request, run, bestCandidate, conversation, {
				code: "unavailable",
				message: "Landing publish effect failed.",
				retryable: true,
				cause,
			});
		}
		if (!attempted.ok)
			return stop(request, run, bestCandidate, conversation, attempted.error);
		if (attempted.value.kind === "landed") {
			if (attempted.value.record.run_id !== run.run_id)
				return stop(request, run, bestCandidate, conversation, {
					code: "unavailable",
					message: "Landing publish returned a different run identity.",
					retryable: false,
				});
			return {
				kind: "landed",
				publish: attempted.value,
				candidate,
				bestCandidate: candidate,
				conversation,
				record: attempted.value.record,
			};
		}

		if (
			attempted.value.record.run_id !== run.run_id ||
			attempted.value.record.status !== "running"
		)
			return stop(request, run, bestCandidate, conversation, {
				code: "unavailable",
				message: "Landing retry returned an invalid active run record.",
				retryable: false,
			});

		run = attempted.value.record;
		if (attempted.value.reason === "ref_conflict")
			return stop(request, run, bestCandidate, conversation, {
				code: "conflict",
				message:
					"The run's incoming landing ref conflicts with another candidate.",
				retryable: false,
			});

		const delay = LANDING_RETRY_DELAYS_MILLISECONDS[delayIndex];
		if (delay !== undefined) {
			if (!Number.isSafeInteger(totalRetries + 1))
				return stop(request, run, bestCandidate, conversation, {
					code: "unavailable",
					message: "Landing retry count exceeded the safe integer range.",
					retryable: false,
				});
			totalRetries += 1;
			try {
				await ports.emit("landing_retry", {
					attempt: totalRetries,
					delay_ms: delay,
					reason: attempted.value.reason,
					expected_parent: candidate.parent,
					current_base: attempted.value.currentBase,
				});
				await ports.sleep(delay);
			} catch (cause) {
				return stop(request, run, bestCandidate, conversation, {
					code: "unavailable",
					message: "Landing retry wait or journal effect failed.",
					retryable: true,
					cause,
				});
			}
			delayIndex += 1;
			continue;
		}
		if (
			attempted.value.reason === "branch_locked" &&
			lastRebasedLanding !== null &&
			isSameLanding(candidate, lastRebasedLanding)
		)
			return park(run, bestCandidate, conversation, "landing_lock_persisted");

		let discarded: Result<void>;
		try {
			discarded = await ports.discardIncoming({
				runId: run.run_id,
				candidate,
			});
		} catch (cause) {
			return stop(request, run, bestCandidate, conversation, {
				code: "unavailable",
				message: "Could not safely discard the stale incoming landing ref.",
				retryable: true,
				cause,
			});
		}
		if (!discarded.ok)
			return stop(request, run, bestCandidate, conversation, discarded.error);

		let rebased: LandingRebaseOutcome<State>;
		try {
			rebased = await ports.rebase({
				run,
				rung: request.rung,
				candidate,
				bestCandidate,
				conversation,
				allowance,
			});
		} catch (cause) {
			return stop(request, run, bestCandidate, conversation, {
				code: "unavailable",
				message: "Moved-base rebase effect failed.",
				retryable: true,
				cause,
			});
		}
		if (
			!isLandingCommit(rebased.bestCandidate) ||
			rebased.record.run_id !== run.run_id ||
			rebased.record.status !== "running" ||
			!isConversation(rebased.conversation) ||
			rebased.conversation.id !== conversation.id
		)
			return stop(request, run, bestCandidate, conversation, {
				code: "unavailable",
				message: "Moved-base repair changed its run or winning candidate.",
				retryable: false,
			});
		if (rebased.kind === "parked")
			return park(
				rebased.record,
				rebased.bestCandidate,
				rebased.conversation,
				rebased.reason,
			);
		if (rebased.kind === "stopped")
			return stop(
				request,
				rebased.record,
				rebased.bestCandidate,
				rebased.conversation,
				rebased.failure,
			);
		if (!isLandingCommit(rebased.candidate))
			return stop(request, run, bestCandidate, conversation, {
				code: "unavailable",
				message: "Moved-base repair returned an invalid verified candidate.",
				retryable: false,
			});

		run = rebased.record;
		candidate = rebased.candidate;
		bestCandidate = rebased.bestCandidate;
		conversation = rebased.conversation;
		lastRebasedLanding = candidate;
		delayIndex = 0;
	}
}
