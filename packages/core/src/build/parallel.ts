import type { Result } from "../contracts/errors";
import type { RoleResolution } from "../project/roles";
import type { RecipeName } from "../project/schema";
import type { JsonValue } from "../run/journal";
import type {
	SerialLadderAttemptRecord,
	SerialLadderEffects,
	SerialLadderRungResult,
} from "./attempts";
import type { BuildBudget } from "./budget";
import type {
	BuildBaseSnapshot,
	BuildCandidate,
	BuildEffectFailure,
	RungOutcome,
	RungWorkspace,
} from "./controller";
import {
	BUILD_RUNG_WALL_MILLISECONDS,
	type BuildEarlierAttempt,
} from "./develop";
import type { LadderAttempt, LadderPlan } from "./ladder";
import { nextLadderAttempt } from "./ladder";
import type { LoadedBuildApproval } from "./load";
import type { BuildPlan } from "./planner";
import { BUILD_RUNG_REPAIR_LIMIT } from "./repair";

export type ParallelLadderRunInput = Parameters<
	SerialLadderEffects["run"]
>[0] & {
	readonly signal: AbortSignal;
	/** Shared pause-aware Build clock; rung wall checks use active time. */
	readonly budget: BuildBudget;
};

export interface ParallelLadderEffects
	extends Omit<SerialLadderEffects, "run"> {
	run(
		input: ParallelLadderRunInput,
	): Promise<Result<SerialLadderRungResult, BuildEffectFailure>>;
	/** Stop and join the member's provider/process effects after its signal aborts. */
	stopMember(input: {
		readonly runId: string;
		readonly attempt: LadderAttempt;
		readonly workspace: RungWorkspace;
		readonly reason: "winner" | "budget";
	}): Promise<Result<void, BuildEffectFailure>>;
	/** Publish a final base-relative snapshot after the member has stopped. */
	snapshotFinal(input: {
		readonly runId: string;
		readonly attempt: LadderAttempt;
		readonly workspace: RungWorkspace;
		readonly base: BuildBaseSnapshot;
		readonly reason: "winner" | "budget";
	}): Promise<Result<BuildCandidate, BuildEffectFailure>>;
	cleanupWorkspace(input: {
		readonly runId: string;
		readonly workspace: RungWorkspace;
	}): Promise<Result<void, BuildEffectFailure>>;
}

export interface ParallelLadderRequest {
	readonly runId: string;
	readonly approval: LoadedBuildApproval;
	readonly base: BuildBaseSnapshot;
	readonly plan: BuildPlan;
	readonly baseAcceptance: Parameters<
		SerialLadderEffects["run"]
	>[0]["baseAcceptance"];
	readonly roles: RoleResolution;
	readonly ladder: LadderPlan;
	readonly budget: BuildBudget;
	readonly effects: ParallelLadderEffects;
	emit(
		event: string,
		fields?: Readonly<Record<string, JsonValue>>,
	): Promise<void>;
}

export type ParallelLadderResult =
	| {
			readonly kind: "green";
			readonly winner: BuildCandidate;
			readonly candidates: readonly BuildCandidate[];
			readonly attempts: readonly SerialLadderAttemptRecord[];
	  }
	| {
			readonly kind: "red" | "budget";
			readonly candidates: readonly BuildCandidate[];
			readonly attempts: readonly SerialLadderAttemptRecord[];
	  }
	| {
			readonly kind: "stopped";
			readonly failure: BuildEffectFailure;
			readonly candidates: readonly BuildCandidate[];
			readonly attempts: readonly SerialLadderAttemptRecord[];
	  };

interface PreparedMember {
	readonly attempt: LadderAttempt;
	readonly workspace: RungWorkspace | null;
	readonly failure: BuildEffectFailure | null;
}

interface SettledMember {
	readonly prepared: PreparedMember;
	readonly result: Result<SerialLadderRungResult, BuildEffectFailure>;
	readonly completedAt: number;
}

interface RunningMember extends PreparedMember {
	readonly controller: AbortController;
	readonly promise: Promise<SettledMember>;
	completion: SettledMember | null;
}

const empty = (): ParallelLadderResult => ({
	kind: "red",
	candidates: Object.freeze([]),
	attempts: Object.freeze([]),
});

function failure(
	code: string,
	message: string,
	exitCode: BuildEffectFailure["exitCode"] = 70,
): BuildEffectFailure {
	return { code, message, exitCode };
}

function stopped(
	problem: BuildEffectFailure,
	attempts: readonly SerialLadderAttemptRecord[] = [],
	candidates: readonly BuildCandidate[] = [],
): ParallelLadderResult {
	return {
		kind: "stopped",
		failure: problem,
		attempts: Object.freeze([...attempts]),
		candidates: Object.freeze([...candidates]),
	};
}

function serializedEmitter(
	write: ParallelLadderRequest["emit"],
): ParallelLadderRequest["emit"] {
	let tail: Promise<void> = Promise.resolve();
	let failed = false;
	let firstFailure: unknown;
	return (event, fields = {}) => {
		const operation = tail.then(async () => {
			if (failed) throw firstFailure;
			try {
				await write(event, fields);
			} catch (cause) {
				failed = true;
				firstFailure = cause;
				throw cause;
			}
		});
		tail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};
}

function validWorkspace(workspace: RungWorkspace): boolean {
	return (
		typeof workspace.id === "string" &&
		workspace.id.length > 0 &&
		typeof workspace.root === "string" &&
		workspace.root.length > 0
	);
}

function candidateMatches(
	candidate: BuildCandidate,
	attempt: LadderAttempt,
	workspace: RungWorkspace,
): boolean {
	return (
		candidate.rung === attempt.rung &&
		candidate.workspace.id === workspace.id &&
		candidate.workspace.root === workspace.root &&
		candidate.verifiedTree.length > 0
	);
}

function summary(
	attempt: LadderAttempt,
	outcome: RungOutcome,
	lines: readonly string[],
): BuildEarlierAttempt {
	return Object.freeze({
		rung: attempt.rung,
		model: attempt.role.effective.model,
		reason: outcome.reason,
		failures: Object.freeze(
			lines.slice(-5).map((line) => Array.from(line).slice(0, 180).join("")),
		),
	});
}

function compareCompletion(left: SettledMember, right: SettledMember): number {
	return (
		left.completedAt - right.completedAt ||
		left.prepared.attempt.ordinal - right.prepared.attempt.ordinal
	);
}

function outcomeOf(member: SettledMember): RungOutcome {
	if (!member.result.ok)
		return {
			kind: "stopped",
			reason: member.result.error.code,
			failure: member.result.error,
			candidate: null,
		};
	return member.result.value.outcome;
}

function candidatesOf(
	attempts: readonly SerialLadderAttemptRecord[],
): readonly BuildCandidate[] {
	return Object.freeze(
		attempts.flatMap((record) =>
			record.outcome.candidate === null ? [] : [record.outcome.candidate],
		),
	);
}

function recordFor(
	member: SettledMember,
	selectedOutcome = outcomeOf(member),
): SerialLadderAttemptRecord | null {
	const workspace = member.prepared.workspace;
	if (workspace === null) return null;
	return Object.freeze({
		attempt: member.prepared.attempt,
		workspace,
		outcome: selectedOutcome,
		summary: summary(
			member.prepared.attempt,
			selectedOutcome,
			member.result.ok ? member.result.value.failureLines : [],
		),
	});
}

async function emitFinished(
	emit: ParallelLadderRequest["emit"],
	records: readonly SerialLadderAttemptRecord[],
): Promise<void> {
	for (const record of records)
		await emit("rung_finished", {
			rung: record.attempt.rung,
			reason: record.outcome.reason,
			verdict: record.outcome.kind,
		});
}

async function prepare(
	request: ParallelLadderRequest,
	attempt: LadderAttempt,
): Promise<PreparedMember> {
	let created: Awaited<ReturnType<SerialLadderEffects["createWorkspace"]>>;
	try {
		created = await request.effects.createWorkspace({
			runId: request.runId,
			attempt,
			base: request.base,
			approval: request.approval,
		});
	} catch (cause) {
		return {
			attempt,
			workspace: null,
			failure: failure(
				"environment/ladder_effect_failed",
				cause instanceof Error ? cause.message : "Create workspace failed.",
				3,
			),
		};
	}
	if (!created.ok) return { attempt, workspace: null, failure: created.error };
	const workspace = created.value;
	if (!validWorkspace(workspace))
		return {
			attempt,
			workspace,
			failure: failure(
				"controller/ladder_workspace_invalid",
				"Invalid workspace.",
			),
		};
	try {
		let setup = await request.effects.setup(workspace);
		if (!setup.ok) setup = await request.effects.setup(workspace);
		if (!setup.ok)
			return {
				attempt,
				workspace,
				failure: failure("environment/setup_failed", setup.error.message, 3),
			};
	} catch (cause) {
		return {
			attempt,
			workspace,
			failure: failure(
				"environment/ladder_effect_failed",
				cause instanceof Error ? cause.message : "Set up workspace failed.",
				3,
			),
		};
	}
	return { attempt, workspace, failure: null };
}

/**
 * Run the first two hard rungs concurrently. A green result wins by earliest
 * completion; exact ties prefer the lower rung ordinal. The losing workspace
 * is stopped, snapshotted after stop, and only then cleaned up.
 */
export async function runParallelHardRungs(
	request: ParallelLadderRequest,
): Promise<ParallelLadderResult> {
	const emit = serializedEmitter(request.emit);
	if (request.plan.difficulty !== "hard")
		return stopped(
			failure(
				"controller/parallel_requires_hard_plan",
				"Parallel rungs require a hard plan.",
			),
		);
	if (request.ladder.rungs.length < 2)
		return stopped(
			failure(
				"controller/parallel_rungs_unavailable",
				"The ladder does not admit both R1 and R2.",
			),
		);
	const first = nextLadderAttempt(request.ladder, {
		attemptsStarted: 0,
		finished: false,
	});
	const second = nextLadderAttempt(request.ladder, {
		attemptsStarted: 1,
		finished: false,
	});
	if (first?.rung !== "R1" || second?.rung !== "R2")
		return stopped(
			failure(
				"controller/parallel_ladder_invalid",
				"Hard parallel execution requires R1 and R2.",
			),
		);
	const attempts = [first, second] as const;
	const remaining = request.budget.remainingMilliseconds();
	if (remaining === 0) return { ...empty(), kind: "budget" };
	const wallMilliseconds = Math.min(remaining, BUILD_RUNG_WALL_MILLISECONDS);

	try {
		await emit("parallel_started", {
			attempts: attempts.map((attempt) => ({
				rung: attempt.rung,
				model: attempt.role.effective.model,
				effort: attempt.role.effective.effort,
			})),
		});
		for (const attempt of attempts)
			await emit("rung_started", {
				rung: attempt.rung,
				model: attempt.role.effective.model,
				effort: attempt.role.effective.effort,
				entered_because: "hard_parallel",
				wall_ms: wallMilliseconds,
			});
	} catch (cause) {
		return stopped(
			failure(
				"environment/ladder_effect_failed",
				cause instanceof Error
					? cause.message
					: "Record parallel start failed.",
				3,
			),
		);
	}

	const prepared = await Promise.all(
		attempts.map((attempt) => prepare(request, attempt)),
	);
	const identities = new Set<string>();
	const roots = new Set<string>();
	for (const member of prepared) {
		const workspace = member.workspace;
		if (workspace === null) continue;
		if (identities.has(workspace.id) || roots.has(workspace.root))
			return stopped(
				failure(
					"controller/ladder_workspace_reused",
					"Parallel rungs must use independent workspaces.",
				),
			);
		identities.add(workspace.id);
		roots.add(workspace.root);
	}

	let resolveCompletion!: () => void;
	let completionSignal = new Promise<void>((resolve) => {
		resolveCompletion = resolve;
	});
	const completions: SettledMember[] = [];
	const members: RunningMember[] = prepared.map((member) => {
		const controller = new AbortController();
		const running: RunningMember = {
			...member,
			controller,
			completion: null,
			promise: Promise.resolve().then(async () => {
				let result: Result<SerialLadderRungResult, BuildEffectFailure>;
				if (member.failure !== null || member.workspace === null)
					result = {
						ok: false,
						error:
							member.failure ??
							failure(
								"controller/ladder_workspace_invalid",
								"Workspace missing.",
							),
					};
				else {
					try {
						result = await request.effects.run({
							runId: request.runId,
							attempt: member.attempt,
							workspace: member.workspace,
							approval: request.approval,
							base: request.base,
							recipe: request.ladder.edgeTests
								? (`${request.ladder.recipe}+edge` as `${RecipeName}+edge`)
								: request.ladder.recipe,
							plan: member.attempt.input === "plan" ? request.plan : null,
							baseAcceptance: request.baseAcceptance,
							earlierAttempts: Object.freeze([]),
							repairsLeft: BUILD_RUNG_REPAIR_LIMIT,
							wallMilliseconds,
							remainingBuildBudgetMilliseconds: () =>
								request.budget.remainingMilliseconds(),
							roles: request.roles,
							emit,
							signal: controller.signal,
							budget: request.budget,
						});
					} catch (cause) {
						result = {
							ok: false,
							error: failure(
								"environment/ladder_effect_failed",
								cause instanceof Error ? cause.message : "Run rung failed.",
								3,
							),
						};
					}
				}
				const settled: SettledMember = {
					prepared: member,
					result,
					completedAt: request.budget.activeMonotonicMilliseconds(),
				};
				running.completion = settled;
				completions.push(settled);
				resolveCompletion();
				completionSignal = new Promise<void>((resolve) => {
					resolveCompletion = resolve;
				});
				return settled;
			}),
		};
		return running;
	});

	const budgetAbort = new AbortController();
	const budgetWatch = request.budget.waitUntilExhausted(budgetAbort.signal);
	let budgetExpired = false;
	let winner: SettledMember | null = null;
	while (members.some((member) => member.completion === null)) {
		const next = await Promise.race([
			completionSignal.then(() => "member" as const),
			budgetWatch.then((result) => {
				return result === "expired"
					? ("budget" as const)
					: ("cancelled" as const);
			}),
		]);
		if (next === "cancelled") break;
		if (next === "budget") budgetExpired = true;
		await Promise.resolve();
		const ready = completions.splice(0);
		const green = ready.filter((member) => outcomeOf(member).kind === "green");
		if (green.length > 0) {
			winner = green.sort(compareCompletion)[0] ?? null;
			break;
		}
		if (budgetExpired) break;
	}
	budgetAbort.abort();

	if (winner !== null) {
		await Promise.resolve();
		const settledGreens = members
			.map((member) => member.completion)
			.filter(
				(member): member is SettledMember =>
					member !== null && outcomeOf(member).kind === "green",
			)
			.sort(compareCompletion);
		winner = settledGreens[0] ?? winner;
		const loser = members.find(
			(member) => member.attempt.ordinal !== winner?.prepared.attempt.ordinal,
		);
		const failKeepingSnapshots = (
			problem: BuildEffectFailure,
		): ParallelLadderResult => {
			const partialRecords = members
				.map((member) =>
					member.completion === null ? null : recordFor(member.completion),
				)
				.filter(
					(record): record is SerialLadderAttemptRecord => record !== null,
				)
				.sort((left, right) => left.attempt.ordinal - right.attempt.ordinal);
			return stopped(problem, partialRecords, candidatesOf(partialRecords));
		};
		if (loser !== undefined) {
			let finalLoser = loser.completion;
			let wasCancelled = false;
			if (finalLoser === null && loser.failure !== null) {
				finalLoser = await loser.promise;
			} else if (finalLoser === null && loser.workspace !== null) {
				wasCancelled = true;
				loser.controller.abort("parallel_winner");
				const stoppedMember = await request.effects.stopMember({
					runId: request.runId,
					attempt: loser.attempt,
					workspace: loser.workspace,
					reason: "winner",
				});
				if (!stoppedMember.ok) return failKeepingSnapshots(stoppedMember.error);
				finalLoser = await loser.promise;
			}
			if (loser.workspace !== null) {
				let loserOutcome =
					finalLoser === null
						? {
								kind: "stopped" as const,
								reason: "stopped_before_run",
								candidate: null,
							}
						: outcomeOf(finalLoser);
				if (wasCancelled) {
					const snapshot = await request.effects.snapshotFinal({
						runId: request.runId,
						attempt: loser.attempt,
						workspace: loser.workspace,
						base: request.base,
						reason: "winner",
					});
					if (!snapshot.ok) return failKeepingSnapshots(snapshot.error);
					if (!candidateMatches(snapshot.value, loser.attempt, loser.workspace))
						return failKeepingSnapshots(
							failure(
								"controller/cancel_snapshot_invalid",
								"Cancelled rung snapshot did not match its attempt and workspace.",
							),
						);
					loserOutcome = {
						kind: "stopped",
						reason: "cancelled_after_parallel_winner",
						candidate: snapshot.value,
					};
				}
				if (finalLoser !== null) {
					finalLoser = {
						...finalLoser,
						result: {
							ok: true,
							value: {
								outcome: loserOutcome,
								failureLines: finalLoser.result.ok
									? finalLoser.result.value.failureLines
									: [],
							},
						},
					};
					loser.completion = finalLoser;
				}
				const cleanup = await request.effects.cleanupWorkspace({
					runId: request.runId,
					workspace: loser.workspace,
				});
				if (!cleanup.ok) return failKeepingSnapshots(cleanup.error);
			}
		}
		const records = members
			.map((member) =>
				member.completion === null ? null : recordFor(member.completion),
			)
			.filter((record): record is SerialLadderAttemptRecord => record !== null)
			.sort((left, right) => left.attempt.ordinal - right.attempt.ordinal);
		const candidates = candidatesOf(records);
		const winnerOutcome = outcomeOf(winner);
		if (winnerOutcome.kind !== "green" || winnerOutcome.candidate === null)
			return stopped(
				failure(
					"controller/parallel_winner_invalid",
					"Parallel green result has no candidate.",
				),
				records,
				candidates,
			);
		try {
			await emitFinished(emit, records);
		} catch (cause) {
			return stopped(
				failure(
					"environment/ladder_effect_failed",
					cause instanceof Error ? cause.message : "Record rung finish failed.",
					3,
				),
				records,
				candidates,
			);
		}
		return {
			kind: "green",
			winner: winnerOutcome.candidate,
			candidates,
			attempts: Object.freeze(records),
		};
	}

	if (budgetExpired || request.budget.remainingMilliseconds() === 0) {
		let stopResults: (SettledMember | null)[];
		try {
			stopResults = await Promise.all(
				members.map(async (member): Promise<SettledMember | null> => {
					if (member.completion !== null) return member.completion;
					if (member.failure !== null || member.workspace === null) {
						await member.promise;
						return member.completion;
					}
					member.controller.abort("build_budget_exhausted");
					const halted = await request.effects.stopMember({
						runId: request.runId,
						attempt: member.attempt,
						workspace: member.workspace,
						reason: "budget",
					});
					if (!halted.ok) throw new Error(halted.error.message);
					const settled = await member.promise;
					const snapshot = await request.effects.snapshotFinal({
						runId: request.runId,
						attempt: member.attempt,
						workspace: member.workspace,
						base: request.base,
						reason: "budget",
					});
					if (!snapshot.ok) throw new Error(snapshot.error.message);
					if (
						!candidateMatches(snapshot.value, member.attempt, member.workspace)
					)
						throw new Error(
							"Budget cancellation snapshot did not match its rung.",
						);
					const replacement: SettledMember = {
						...settled,
						result: {
							ok: true,
							value: {
								outcome: {
									kind: "red",
									reason: "budget",
									candidate: snapshot.value,
								},
								failureLines: settled.result.ok
									? settled.result.value.failureLines
									: [],
							},
						},
					};
					member.completion = replacement;
					return replacement;
				}),
			);
		} catch (cause) {
			return stopped(
				failure(
					"environment/ladder_cancel_failed",
					cause instanceof Error
						? cause.message
						: "Could not stop and snapshot hard rungs.",
					3,
				),
			);
		}
		const records = stopResults
			.map((member) => (member === null ? null : recordFor(member)))
			.filter((record): record is SerialLadderAttemptRecord => record !== null)
			.sort((left, right) => left.attempt.ordinal - right.attempt.ordinal);
		try {
			await emitFinished(emit, records);
		} catch (cause) {
			return stopped(
				failure(
					"environment/ladder_effect_failed",
					cause instanceof Error
						? cause.message
						: "Record budget-stopped rung finish failed.",
					3,
				),
				records,
				candidatesOf(records),
			);
		}
		return {
			kind: "budget",
			candidates: candidatesOf(records),
			attempts: Object.freeze(records),
		};
	}

	const records = members
		.map((member) =>
			member.completion === null ? null : recordFor(member.completion),
		)
		.filter((record): record is SerialLadderAttemptRecord => record !== null)
		.sort((left, right) => left.attempt.ordinal - right.attempt.ordinal);
	const outcomes = records.map((record) => record.outcome);
	const stoppedOutcome = outcomes.find((outcome) => outcome.kind === "stopped");
	try {
		await emitFinished(emit, records);
	} catch (cause) {
		return stopped(
			failure(
				"environment/ladder_effect_failed",
				cause instanceof Error ? cause.message : "Record rung finish failed.",
				3,
			),
			records,
			candidatesOf(records),
		);
	}
	if (stoppedOutcome !== undefined)
		return stopped(
			stoppedOutcome.failure ??
				failure(stoppedOutcome.reason, stoppedOutcome.reason, 4),
			records,
			candidatesOf(records),
		);
	return {
		kind: "red",
		candidates: candidatesOf(records),
		attempts: Object.freeze(records),
	};
}
