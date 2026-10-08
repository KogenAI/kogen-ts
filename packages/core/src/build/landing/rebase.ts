import type { PortError, Result } from "../../contracts/errors";
import type { JsonValue } from "../../run/journal";
import type { RunRecord } from "../../run/store";
import type { LandingCommit } from "./commit";

export const LANDING_REPAIR_ALLOWANCE_MILLISECONDS = 10 * 60 * 1_000;

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export class LandingRepairAllowance {
	readonly limitMilliseconds: number;
	private used = 0;

	constructor(limitMilliseconds = LANDING_REPAIR_ALLOWANCE_MILLISECONDS) {
		if (!Number.isSafeInteger(limitMilliseconds) || limitMilliseconds < 0)
			throw new RangeError(
				"Landing repair allowance must be a non-negative safe integer.",
			);
		this.limitMilliseconds = limitMilliseconds;
	}

	get usedMilliseconds(): number {
		return this.used;
	}

	get remainingMilliseconds(): number {
		return this.limitMilliseconds - this.used;
	}

	/** Charge active model work without charging deterministic Git or gate work. */
	consume(activeMilliseconds: number): boolean {
		if (!Number.isSafeInteger(activeMilliseconds) || activeMilliseconds < 0)
			throw new RangeError(
				"Landing repair time must be a non-negative safe integer.",
			);
		if (activeMilliseconds > this.remainingMilliseconds) {
			this.used = this.limitMilliseconds;
			return false;
		}
		this.used += activeMilliseconds;
		return true;
	}
}

export interface WinningBuildConversation<State> {
	/** Stable identity for the R1 conversation; repairs may update state, not id. */
	readonly id: string;
	readonly state: State;
}

export interface LandingBaseSnapshot {
	readonly commit: string;
	readonly tree: string;
}

export type LandingRebaseAttempt =
	| { readonly kind: "ready" }
	| { readonly kind: "conflict"; readonly paths: readonly string[] };

export type LandingGuardResult =
	| { readonly kind: "pass" }
	| { readonly kind: "red"; readonly feedback: string };

export interface LandingVerificationResult {
	readonly status: "green" | "red";
	readonly tree: string;
	readonly count: number | null;
	readonly feedback: string;
}

export type LandingRepairResult<State> =
	| {
			readonly kind: "completed";
			readonly conversation: WinningBuildConversation<State>;
			readonly activeMilliseconds: number;
	  }
	| {
			readonly kind: "provider_failure";
			readonly failure: PortError;
			readonly activeMilliseconds: number;
	  }
	| {
			readonly kind: "allowance_exhausted";
			readonly activeMilliseconds: number;
	  };

export interface LandingRebasePorts<State> {
	resolveBase(): Promise<Result<LandingBaseSnapshot>>;
	rebase(input: {
		readonly base: LandingBaseSnapshot;
		readonly candidate: LandingCommit;
	}): Promise<Result<LandingRebaseAttempt>>;
	guard(input: {
		readonly base: LandingBaseSnapshot;
	}): Promise<Result<LandingGuardResult>>;
	verify(input: {
		readonly base: LandingBaseSnapshot;
	}): Promise<Result<LandingVerificationResult>>;
	repair(input: {
		readonly rung: string;
		readonly conversation: WinningBuildConversation<State>;
		readonly feedback: string;
		readonly remainingAllowanceMilliseconds: number;
	}): Promise<Result<LandingRepairResult<State>>>;
	commit(input: {
		readonly base: LandingBaseSnapshot;
		readonly verifiedTree: string;
		readonly previousCandidate: LandingCommit;
	}): Promise<Result<LandingCommit>>;
	emit(
		event: string,
		fields: Readonly<Record<string, JsonValue>>,
	): Promise<void>;
}

export type LandingRebaseOutcome<State> =
	| {
			readonly kind: "ready";
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

export interface LandingRebaseRequest<State> {
	readonly run: RunRecord;
	readonly rung: string;
	readonly candidate: LandingCommit;
	/** Last fully verified candidate, retained if this re-gate cannot go green. */
	readonly bestCandidate: LandingCommit;
	readonly conversation: WinningBuildConversation<State>;
	readonly allowance: LandingRepairAllowance;
}

function stop<State>(
	request: LandingRebaseRequest<State>,
	failure: PortError,
): LandingRebaseOutcome<State> {
	return {
		kind: "stopped",
		failure,
		bestCandidate: request.bestCandidate,
		conversation: request.conversation,
		record: request.run,
	};
}

function park<State>(
	request: LandingRebaseRequest<State>,
	reason: string,
): LandingRebaseOutcome<State> {
	return {
		kind: "parked",
		reason,
		bestCandidate: request.bestCandidate,
		conversation: request.conversation,
		record: request.run,
	};
}

function validateConversation<State>(
	conversation: WinningBuildConversation<State>,
): boolean {
	return (
		typeof conversation.id === "string" &&
		conversation.id.length > 0 &&
		!/[\r\n\0]/u.test(conversation.id)
	);
}

function isBoundCandidate(
	candidate: LandingCommit,
	base: LandingBaseSnapshot,
	verifiedTree: string,
): boolean {
	return (
		isLandingCommit(candidate) &&
		candidate.parent.length === base.commit.length &&
		candidate.commit.length === base.commit.length &&
		candidate.parent === base.commit &&
		candidate.tree === verifiedTree
	);
}

function isLandingCommit(candidate: LandingCommit): boolean {
	return (
		OBJECT_ID.test(candidate.commit) &&
		OBJECT_ID.test(candidate.tree) &&
		OBJECT_ID.test(candidate.parent) &&
		candidate.commit.length === candidate.tree.length &&
		candidate.commit.length === candidate.parent.length &&
		candidate.objectFormat ===
			(candidate.commit.length === 40 ? "sha1" : "sha256")
	);
}

function validBase(base: LandingBaseSnapshot): boolean {
	return (
		OBJECT_ID.test(base.commit) &&
		OBJECT_ID.test(base.tree) &&
		base.commit.length === base.tree.length
	);
}

function validVerification(verification: LandingVerificationResult): boolean {
	return (
		(verification.status === "green" || verification.status === "red") &&
		OBJECT_ID.test(verification.tree) &&
		(verification.count === null ||
			(Number.isSafeInteger(verification.count) && verification.count >= 0)) &&
		typeof verification.feedback === "string"
	);
}

/** Rebase, guard and fully re-gate while retaining the winning conversation. */
export async function rebaseAndVerifyLanding<State>(
	request: LandingRebaseRequest<State>,
	ports: LandingRebasePorts<State>,
): Promise<LandingRebaseOutcome<State>> {
	if (
		!validateConversation(request.conversation) ||
		!/^R[1-9][0-9]*$/u.test(request.rung) ||
		!isLandingCommit(request.candidate) ||
		!isLandingCommit(request.bestCandidate) ||
		request.run.status !== "running"
	)
		return stop(request, {
			code: "invalid_input",
			message: "Moved-base landing inputs are invalid.",
			retryable: false,
		});

	let conversation = request.conversation;
	try {
		while (true) {
			const activeRequest = { ...request, conversation };
			const baseResult = await ports.resolveBase();
			if (!baseResult.ok) return stop(activeRequest, baseResult.error);
			const base = baseResult.value;
			if (!validBase(base))
				return stop(activeRequest, {
					code: "unavailable",
					message: "Moved-base resolver returned invalid Git ids.",
					retryable: false,
				});

			await ports.emit("landing_rebase", {
				from: request.candidate.parent,
				to: base.commit,
			});
			const rebased = await ports.rebase({
				base,
				candidate: request.candidate,
			});
			if (!rebased.ok) return stop(activeRequest, rebased.error);
			if (rebased.value.kind === "conflict") {
				const paths = [...rebased.value.paths];
				const repair = await runRepair(
					activeRequest,
					ports,
					conversation,
					`Moved-base rebase conflict in: ${paths.join(", ") || "unknown paths"}`,
					{ paths },
				);
				if (repair.kind !== "continue") return repair.outcome;
				conversation = repair.conversation;
				continue;
			}

			const guard = await ports.guard({ base });
			if (!guard.ok) return stop(activeRequest, guard.error);
			if (guard.value.kind === "red") {
				const repair = await runRepair(
					activeRequest,
					ports,
					conversation,
					guard.value.feedback,
					{ guard: "red" },
				);
				if (repair.kind !== "continue") return repair.outcome;
				conversation = repair.conversation;
				continue;
			}

			const verification = await ports.verify({ base });
			if (!verification.ok) return stop(activeRequest, verification.error);
			if (!validVerification(verification.value))
				return stop(activeRequest, {
					code: "unavailable",
					message: "Moved-base gate returned an invalid result.",
					retryable: false,
				});
			if (verification.value.tree.length !== base.commit.length)
				return stop(activeRequest, {
					code: "unavailable",
					message:
						"Moved-base gate returned a tree in another Git object format.",
					retryable: false,
				});
			await ports.emit("verification", {
				rung: request.rung,
				result: verification.value.status,
				count: verification.value.count,
				tree: verification.value.tree,
			});
			if (verification.value.status === "red") {
				const repair = await runRepair(
					activeRequest,
					ports,
					conversation,
					verification.value.feedback,
					{ result: "red", count: verification.value.count },
				);
				if (repair.kind !== "continue") return repair.outcome;
				conversation = repair.conversation;
				continue;
			}

			const committed = await ports.commit({
				base,
				verifiedTree: verification.value.tree,
				previousCandidate: request.candidate,
			});
			if (!committed.ok) return stop(activeRequest, committed.error);
			if (!isBoundCandidate(committed.value, base, verification.value.tree))
				return stop(activeRequest, {
					code: "unavailable",
					message:
						"Moved-base landing commit is not bound to the green verified tree and new parent.",
					retryable: false,
				});
			return {
				kind: "ready",
				candidate: committed.value,
				bestCandidate: committed.value,
				conversation,
				record: request.run,
			};
		}
	} catch (cause) {
		return stop(
			{ ...request, conversation },
			{
				code: "unavailable",
				message: "Moved-base landing effect failed.",
				retryable: true,
				cause,
			},
		);
	}
}

type RepairOutcome<State> =
	| {
			readonly kind: "continue";
			readonly conversation: WinningBuildConversation<State>;
	  }
	| { readonly kind: "done"; readonly outcome: LandingRebaseOutcome<State> };

async function runRepair<State>(
	request: LandingRebaseRequest<State>,
	ports: LandingRebasePorts<State>,
	conversation: WinningBuildConversation<State>,
	feedback: string,
	fields: Readonly<Record<string, JsonValue>>,
): Promise<RepairOutcome<State>> {
	const remaining = request.allowance.remainingMilliseconds;
	if (remaining === 0)
		return {
			kind: "done",
			outcome: park(request, "landing_allowance_exhausted"),
		};
	await ports.emit("repair", {
		rung: request.rung,
		landing: true,
		...fields,
	});
	const result = await ports.repair({
		rung: request.rung,
		conversation,
		feedback,
		remainingAllowanceMilliseconds: remaining,
	});
	if (!result.ok) return { kind: "done", outcome: stop(request, result.error) };
	let withinAllowance: boolean;
	try {
		withinAllowance = request.allowance.consume(
			result.value.activeMilliseconds,
		);
	} catch (cause) {
		return {
			kind: "done",
			outcome: stop(request, {
				code: "unavailable",
				message: "Moved-base repair returned invalid active-time accounting.",
				retryable: false,
				cause,
			}),
		};
	}
	if (!withinAllowance || result.value.kind === "allowance_exhausted")
		return {
			kind: "done",
			outcome: park(request, "landing_allowance_exhausted"),
		};
	if (result.value.kind === "provider_failure")
		return { kind: "done", outcome: stop(request, result.value.failure) };
	if (result.value.activeMilliseconds === 0)
		return {
			kind: "done",
			outcome: stop(request, {
				code: "unavailable",
				message: "Moved-base repair did not report active model time.",
				retryable: false,
			}),
		};
	if (
		!validateConversation(result.value.conversation) ||
		result.value.conversation.id !== conversation.id
	)
		return {
			kind: "done",
			outcome: stop(request, {
				code: "unavailable",
				message: "Moved-base repair changed the winning conversation.",
				retryable: false,
			}),
		};
	return { kind: "continue", conversation: result.value.conversation };
}
