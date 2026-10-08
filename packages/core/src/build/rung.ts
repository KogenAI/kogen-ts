import type { ClockPort } from "../contracts/clock";
import type { Result } from "../contracts/errors";
import { formatGateFeedback } from "../gate/feedback";
import type { GateVerificationResult } from "../gate/verify";
import { countVerificationFailures } from "../gate/verify";
import type { ResolvedRole, RoleResolution } from "../project/roles";
import type { SessionState } from "../provider/session/transition";
import type { ToolDispatchOptions } from "../provider/tools/dispatch";
import type { JsonValue } from "../run/journal";
import type {
	BuildCandidate,
	BuildEffectFailure,
	RungOutcome,
	RungWorkspace,
} from "./controller";
import {
	BUILD_RUNG_TURN_LIMIT,
	BUILD_RUNG_WALL_MILLISECONDS,
	type BuildDeveloperEffectFailure,
	type BuildDeveloperPort,
	type BuildProtectedRestorePort,
	type DevelopResult,
	developBuild,
	type RungTreePort,
} from "./develop";
import type { LoadedBuildApproval } from "./load";
import type { BuildPlan } from "./planner";
import {
	appendBuildControllerNote,
	BUILD_RUNG_REPAIR_LIMIT,
	buildRepairMessage,
	decideRepair,
	initialRepairProgress,
	isAcceptanceOnlyFailure,
	type RepairProgress,
} from "./repair";

export interface BuildRungVerificationPort {
	/** Run the protected-manifest guard and the real gate on the current workspace. */
	verify(input: {
		readonly runId: string;
		readonly workspace: RungWorkspace;
		readonly baseCommit: string;
		readonly reason: "finish" | "turn_cap" | "wall_cap" | "budget";
	}): Promise<Result<GateVerificationResult, BuildEffectFailure>>;
}

export interface BuildAuditAdviceItem {
	readonly id: string;
	readonly verdict: "valid" | "over_strict" | "contradicts";
	readonly reason: string;
}

export interface BuildAuditAdvice {
	readonly items: readonly BuildAuditAdviceItem[];
}

export interface BuildRungAuditPort {
	advise(input: {
		readonly runId: string;
		readonly workspace: RungWorkspace;
		readonly baseCommit: string;
		readonly request: LoadedBuildApproval["intentBytes"];
		readonly approval: LoadedBuildApproval;
		readonly plan: BuildPlan;
		readonly verification: GateVerificationResult;
		readonly candidateTree: string;
		readonly role: ResolvedRole;
	}): Promise<Result<BuildAuditAdvice, BuildEffectFailure>>;
}

export interface BuildRungMachineRequest {
	readonly runId: string;
	readonly rung: string;
	readonly workspace: RungWorkspace;
	readonly approval: LoadedBuildApproval;
	readonly baseCommit: string;
	readonly plan: BuildPlan;
	readonly roles: RoleResolution;
	readonly session: SessionState;
	readonly developer: BuildDeveloperPort;
	readonly tools: ToolDispatchOptions;
	readonly tree: RungTreePort;
	readonly protection: BuildProtectedRestorePort;
	readonly verification: BuildRungVerificationPort;
	readonly audit: BuildRungAuditPort;
	readonly clock: Pick<ClockPort, "monotonicMilliseconds">;
	/** Remaining active Build budget; provider pauses are excluded by its owner. */
	readonly remainingBuildBudgetMilliseconds: () => number;
	readonly wallMilliseconds?: number;
	readonly turnLimit?: number;
	readonly emit: (
		event: string,
		fields?: Readonly<Record<string, JsonValue>>,
	) => Promise<void>;
}

interface VerificationSnapshot {
	readonly result: GateVerificationResult;
	readonly treeIdentity: string;
}

function asBuildFailure(
	failure: BuildDeveloperEffectFailure | BuildEffectFailure,
): BuildEffectFailure {
	return {
		code: failure.code,
		message: failure.message,
		exitCode: failure.exitCode,
	};
}

function stopped(
	reason: string,
	failure: BuildEffectFailure,
	candidate: BuildCandidate | null = null,
): RungOutcome {
	return { kind: "stopped", reason, failure, candidate };
}

function candidate(
	request: BuildRungMachineRequest,
	treeIdentity: string,
	verdict: BuildCandidate["verdict"],
): BuildCandidate {
	return {
		rung: request.rung,
		workspace: request.workspace,
		verifiedTree: treeIdentity,
		verdict,
	};
}

function monotonicNow(clock: Pick<ClockPort, "monotonicMilliseconds">): number {
	const value = clock.monotonicMilliseconds();
	if (!Number.isFinite(value) || value < 0)
		throw new RangeError("Rung clock returned an invalid monotonic time.");
	return value;
}

async function savedBaseTree(
	request: BuildRungMachineRequest,
): Promise<Result<string, BuildEffectFailure>> {
	const snapshot = await request.tree.snapshot(request.baseCommit);
	if (!snapshot.ok) return { ok: false, error: asBuildFailure(snapshot.error) };
	if (
		snapshot.value.baseCommit !== request.baseCommit ||
		snapshot.value.identity.length === 0
	)
		return {
			ok: false,
			error: {
				code: "controller/tree_identity_invalid",
				message: "Workspace snapshot was not bound to the saved Build base.",
				exitCode: 70,
			},
		};
	return { ok: true, value: snapshot.value.identity };
}

async function verifyCurrentTree(
	request: BuildRungMachineRequest,
	develop: DevelopResult,
): Promise<Result<VerificationSnapshot, BuildEffectFailure>> {
	if (
		develop.reason !== "finish" &&
		develop.reason !== "turn_cap" &&
		develop.reason !== "wall_cap" &&
		develop.reason !== "budget"
	)
		return {
			ok: false,
			error: {
				code: "controller/verification_without_cap_or_finish",
				message: "Rung verification was requested for a non-verifiable state.",
				exitCode: 70,
			},
		};
	const verification = await request.verification.verify({
		runId: request.runId,
		workspace: request.workspace,
		baseCommit: request.baseCommit,
		reason: develop.reason,
	});
	if (!verification.ok)
		return { ok: false, error: asBuildFailure(verification.error) };
	const snapshot = await savedBaseTree(request);
	if (!snapshot.ok) return snapshot;
	return {
		ok: true,
		value: { result: verification.value, treeIdentity: snapshot.value },
	};
}

function jsonAuditItems(items: readonly BuildAuditAdviceItem[]): JsonValue {
	return items.map((item) => ({
		id: item.id,
		verdict: item.verdict,
		reason: item.reason,
	}));
}

function validAuditAdvice(
	verification: GateVerificationResult,
	advice: BuildAuditAdvice,
): {
	readonly items: readonly BuildAuditAdviceItem[];
	readonly warning: boolean;
} {
	const failing = new Set(
		verification.acceptance.items
			.filter((item) => item.status !== "pass")
			.map((item) => item.id),
	);
	const seen = new Set<string>();
	const items: BuildAuditAdviceItem[] = [];
	let warning = false;
	for (const item of advice.items) {
		if (
			!failing.has(item.id) ||
			seen.has(item.id) ||
			(item.verdict !== "valid" &&
				item.verdict !== "over_strict" &&
				item.verdict !== "contradicts") ||
			typeof item.reason !== "string"
		) {
			warning = true;
			continue;
		}
		seen.add(item.id);
		items.push({
			id: item.id,
			verdict: item.verdict,
			reason: item.reason,
		});
	}
	if (seen.size !== failing.size) warning = true;
	return { items: Object.freeze(items), warning };
}

function auditFeedback(items: readonly BuildAuditAdviceItem[]): string {
	if (items.length === 0) return "";
	const lines = [
		"",
		"Auditor advice (observational only; all approved acceptance items remain binding):",
	];
	for (const item of items)
		lines.push(`${item.id}: ${item.verdict} — ${item.reason}`);
	return lines.join("\n");
}

function verificationEventFields(
	request: BuildRungMachineRequest,
	verification: VerificationSnapshot,
): Readonly<Record<string, JsonValue>> {
	return {
		rung: request.rung,
		result: verification.result.status,
		count: countVerificationFailures(verification.result),
		tree: verification.treeIdentity,
		acceptance: verification.result.acceptance.items.map((item) => ({
			id: item.id,
			status: item.status,
			demoted: false,
		})),
	};
}

function repairProgress(progress: RepairProgress): RepairProgress {
	return {
		repairsUsed: progress.repairsUsed,
		previousRedCount: progress.previousRedCount,
		consecutiveRedWithoutCount: progress.consecutiveRedWithoutCount,
	};
}

/** Run the persistent develop → verify → repair loop for one Build rung. */
export async function runRungMachine(
	request: BuildRungMachineRequest,
): Promise<RungOutcome> {
	const wallMilliseconds =
		request.wallMilliseconds ?? BUILD_RUNG_WALL_MILLISECONDS;
	const turnLimit = request.turnLimit ?? BUILD_RUNG_TURN_LIMIT;
	if (
		!Number.isSafeInteger(wallMilliseconds) ||
		wallMilliseconds < 1 ||
		!Number.isSafeInteger(turnLimit) ||
		turnLimit < 1 ||
		turnLimit > BUILD_RUNG_TURN_LIMIT ||
		request.session.effectiveRole !== "builder" ||
		request.session.rung !== request.rung
	)
		return stopped("controller/rung_input_invalid", {
			code: "controller/rung_input_invalid",
			message: "Build rung state or limits are invalid.",
			exitCode: 70,
		});

	let startMonotonicMilliseconds: number;
	try {
		startMonotonicMilliseconds = monotonicNow(request.clock);
	} catch (cause) {
		return stopped("controller/rung_clock_invalid", {
			code: "controller/rung_clock_invalid",
			message: cause instanceof Error ? cause.message : "Rung clock failed.",
			exitCode: 70,
		});
	}
	const initialTree = await savedBaseTree(request);
	if (!initialTree.ok)
		return stopped(initialTree.error.code, initialTree.error);
	let session = request.session;
	let turns = 0;
	let emptyFinishCount = 0;
	let protectedRestoreCount = 0;
	let turnBudgetNoteSent = false;
	let repair = initialRepairProgress();
	let pendingDevelopResult: DevelopResult | null = null;

	while (true) {
		if (pendingDevelopResult === null) {
			const developed = await developBuild({
				baseCommit: request.baseCommit,
				initialTreeIdentity: initialTree.value,
				session,
				developer: request.developer,
				tools: request.tools,
				tree: request.tree,
				protection: request.protection,
				clock: request.clock,
				startMonotonicMilliseconds,
				wallMilliseconds,
				turnLimit,
				startingTurn: turns,
				emptyFinishCount,
				protectedRestoreCount,
				turnBudgetNoteSent,
				remainingBuildBudgetMilliseconds:
					request.remainingBuildBudgetMilliseconds,
				emit: request.emit,
			});
			if (!developed.ok)
				return stopped(developed.error.code, asBuildFailure(developed.error));
			pendingDevelopResult = developed.value;
		}
		const developerResult = pendingDevelopResult;
		pendingDevelopResult = null;
		session = developerResult.session;
		turns = developerResult.turns;
		emptyFinishCount = developerResult.emptyFinishCount;
		protectedRestoreCount = developerResult.protectedRestoreCount;
		turnBudgetNoteSent = developerResult.turnBudgetNoteSent;

		if (developerResult.kind === "provider_failure") {
			const reason = `provider/${developerResult.providerFailure ?? "unknown"}`;
			return stopped(reason, {
				code: reason,
				message: reason,
				exitCode: 4,
			});
		}
		if (developerResult.reason === "protected_restore_limit") {
			return {
				kind: "red",
				reason: "protected_restore_limit",
				candidate: candidate(request, developerResult.treeIdentity, "red"),
			};
		}

		const checked = await verifyCurrentTree(request, developerResult);
		if (!checked.ok) return stopped(checked.error.code, checked.error);
		const verified = checked.value;
		if (verified.result.status === "green")
			return {
				kind: "green",
				reason: "green",
				candidate: candidate(request, verified.treeIdentity, "green"),
			};

		const capReason =
			developerResult.kind === "capped" ? developerResult.reason : null;
		if (capReason !== null) {
			return {
				kind: "red",
				reason: capReason,
				candidate: candidate(request, verified.treeIdentity, "red"),
			};
		}

		const decision = decideRepair(repair, verified.result);
		if (decision.kind === "end")
			return {
				kind: "red",
				reason: decision.reason,
				candidate: candidate(request, verified.treeIdentity, "red"),
			};

		await request.emit(
			"verification",
			verificationEventFields(request, verified),
		);
		let advice: readonly BuildAuditAdviceItem[] = [];
		let auditWarning = false;
		if (isAcceptanceOnlyFailure(verified.result)) {
			const observed = await request.audit.advise({
				runId: request.runId,
				workspace: request.workspace,
				baseCommit: request.baseCommit,
				request: request.approval.intentBytes.slice(),
				approval: request.approval,
				plan: request.plan,
				verification: verified.result,
				candidateTree: verified.treeIdentity,
				role: request.roles.roles.auditor,
			});
			if (observed.ok) {
				const validated = validAuditAdvice(verified.result, observed.value);
				advice = validated.items;
				auditWarning = validated.warning;
				await request.emit("audit", {
					rung: request.rung,
					items: jsonAuditItems(advice),
					warning: auditWarning,
					demoted: false,
				});
			} else {
				auditWarning = true;
				await request.emit("audit", {
					rung: request.rung,
					items: [],
					warning: true,
					demoted: false,
				});
			}
		}

		const count = decision.count;
		await request.emit("repair", {
			rung: request.rung,
			count,
			repairs_left: BUILD_RUNG_REPAIR_LIMIT - decision.progress.repairsUsed,
		});
		const feedback = formatGateFeedback(verified.result);
		session = appendBuildControllerNote(
			session,
			buildRepairMessage(feedback + auditFeedback(advice)),
		);
		repair = repairProgress(decision.progress);
		// The pre-repair identity is compared after the same conversation resumes.
		const nextDeveloper = await developBuild({
			baseCommit: request.baseCommit,
			initialTreeIdentity: initialTree.value,
			session,
			developer: request.developer,
			tools: request.tools,
			tree: request.tree,
			protection: request.protection,
			clock: request.clock,
			startMonotonicMilliseconds,
			wallMilliseconds,
			turnLimit,
			startingTurn: turns,
			emptyFinishCount,
			protectedRestoreCount,
			turnBudgetNoteSent,
			remainingBuildBudgetMilliseconds:
				request.remainingBuildBudgetMilliseconds,
			emit: request.emit,
		});
		if (!nextDeveloper.ok)
			return stopped(
				nextDeveloper.error.code,
				asBuildFailure(nextDeveloper.error),
			);
		const afterRepair = nextDeveloper.value;
		if (afterRepair.kind === "provider_failure") {
			const reason = `provider/${afterRepair.providerFailure ?? "unknown"}`;
			return stopped(reason, { code: reason, message: reason, exitCode: 4 });
		}
		session = afterRepair.session;
		turns = afterRepair.turns;
		emptyFinishCount = afterRepair.emptyFinishCount;
		protectedRestoreCount = afterRepair.protectedRestoreCount;
		turnBudgetNoteSent = afterRepair.turnBudgetNoteSent;

		if (afterRepair.reason === "protected_restore_limit")
			return {
				kind: "red",
				reason: "protected_restore_limit",
				candidate: candidate(request, afterRepair.treeIdentity, "red"),
			};
		const afterRepairTree = await savedBaseTree(request);
		if (!afterRepairTree.ok)
			return stopped(afterRepairTree.error.code, afterRepairTree.error);
		if (
			afterRepair.kind === "finished" &&
			afterRepairTree.value === verified.treeIdentity
		) {
			return {
				kind: "red",
				reason: "unchanged",
				candidate: candidate(request, verified.treeIdentity, "red"),
			};
		}
		// Caps verify the final tree even if it matches the prior red tree.
		if (afterRepair.kind === "capped") {
			const finalVerification = await verifyCurrentTree(request, afterRepair);
			if (!finalVerification.ok)
				return stopped(finalVerification.error.code, finalVerification.error);
			if (finalVerification.value.result.status === "green")
				return {
					kind: "green",
					reason: "green",
					candidate: candidate(
						request,
						finalVerification.value.treeIdentity,
						"green",
					),
				};
			return {
				kind: "red",
				reason: afterRepair.reason,
				candidate: candidate(
					request,
					finalVerification.value.treeIdentity,
					"red",
				),
			};
		}
		if (!afterRepair.finishRequested) {
			return stopped("controller/develop_finished_without_finish", {
				code: "controller/develop_finished_without_finish",
				message: "Developer loop ended without finish or a resource cap.",
				exitCode: 70,
			});
		}
		// Carry the same returned conversation state into the next verify cycle.
		pendingDevelopResult = afterRepair;
	}
}
