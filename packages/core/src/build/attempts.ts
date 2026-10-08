import type { Result } from "../contracts/errors";
import type { RoleResolution } from "../project/roles";
import type { RecipeName } from "../project/schema";
import type { JsonValue } from "../run/journal";
import type {
	BaseAcceptanceObservation,
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
import {
	advanceLadderCursor,
	initialLadderCursor,
	type LadderAttempt,
	type LadderPlan,
	nextLadderAttempt,
} from "./ladder";
import type { LoadedBuildApproval } from "./load";
import type { BuildPlan } from "./planner";
import { BUILD_RUNG_REPAIR_LIMIT } from "./repair";

export interface SerialLadderRungResult {
	readonly outcome: RungOutcome;
	/** Recent gate output used to explain this attempt to the next rung. */
	readonly failureLines: readonly string[];
}

export interface SerialLadderAttemptRecord {
	readonly attempt: LadderAttempt;
	readonly workspace: RungWorkspace;
	readonly outcome: RungOutcome;
	readonly summary: BuildEarlierAttempt;
}

export interface SerialLadderEffects {
	createWorkspace(input: {
		readonly runId: string;
		readonly attempt: LadderAttempt;
		readonly base: BuildBaseSnapshot;
		readonly approval: LoadedBuildApproval;
	}): Promise<Result<RungWorkspace, BuildEffectFailure>>;
	setup(workspace: RungWorkspace): Promise<Result<void, BuildEffectFailure>>;
	run(input: {
		readonly runId: string;
		readonly attempt: LadderAttempt;
		readonly workspace: RungWorkspace;
		readonly approval: LoadedBuildApproval;
		readonly base: BuildBaseSnapshot;
		readonly recipe: RecipeName | `${RecipeName}+edge`;
		readonly plan: BuildPlan | null;
		readonly baseAcceptance: BaseAcceptanceObservation;
		readonly earlierAttempts: readonly BuildEarlierAttempt[];
		readonly repairsLeft: number;
		readonly wallMilliseconds: number;
		readonly remainingBuildBudgetMilliseconds: () => number;
		readonly roles: RoleResolution;
		emit(
			event: string,
			fields?: Readonly<Record<string, JsonValue>>,
		): Promise<void>;
	}): Promise<Result<SerialLadderRungResult, BuildEffectFailure>>;
}

export interface SerialLadderRequest {
	readonly runId: string;
	readonly approval: LoadedBuildApproval;
	readonly base: BuildBaseSnapshot;
	readonly plan: BuildPlan;
	readonly baseAcceptance: BaseAcceptanceObservation;
	readonly roles: RoleResolution;
	readonly ladder: LadderPlan;
	readonly effects: SerialLadderEffects;
	/** Active time only; provider pauses are already excluded by this owner. */
	readonly remainingBuildBudgetMilliseconds: () => number;
	emit(
		event: string,
		fields?: Readonly<Record<string, JsonValue>>,
	): Promise<void>;
}

export type SerialLadderResult =
	| {
			readonly kind: "green";
			readonly winner: BuildCandidate;
			readonly attempts: readonly SerialLadderAttemptRecord[];
	  }
	| {
			readonly kind: "exhausted" | "budget";
			readonly candidates: readonly BuildCandidate[];
			readonly attempts: readonly SerialLadderAttemptRecord[];
	  }
	| {
			readonly kind: "stopped";
			readonly failure: BuildEffectFailure;
			readonly candidates: readonly BuildCandidate[];
			readonly attempts: readonly SerialLadderAttemptRecord[];
	  };

function stopped(
	failure: BuildEffectFailure,
	attempts: readonly SerialLadderAttemptRecord[],
	candidates: readonly BuildCandidate[],
): SerialLadderResult {
	return {
		kind: "stopped",
		failure,
		attempts: Object.freeze([...attempts]),
		candidates: Object.freeze([...candidates]),
	};
}

function effectFailure(cause: unknown, operation: string): BuildEffectFailure {
	return {
		code: "environment/ladder_effect_failed",
		message:
			cause instanceof Error
				? `${operation}: ${cause.message}`
				: `${operation}: ladder effect failed.`,
		exitCode: 3,
	};
}

function invalidInput(message: string): BuildEffectFailure {
	return {
		code: "controller/ladder_input_invalid",
		message,
		exitCode: 70,
	};
}

function failureLines(lines: readonly string[]): readonly string[] {
	return Object.freeze(
		lines.slice(-5).map((line) => {
			if (typeof line !== "string") return "";
			return Array.from(line).slice(0, 180).join("");
		}),
	);
}

function summaryFor(
	attempt: LadderAttempt,
	outcome: RungOutcome,
	lines: readonly string[],
): BuildEarlierAttempt {
	return Object.freeze({
		rung: attempt.rung,
		model: attempt.role.effective.model,
		reason: outcome.reason,
		failures: failureLines(lines),
	});
}

function sameWorkspace(left: RungWorkspace, right: RungWorkspace): boolean {
	return left.id === right.id && left.root === right.root;
}

function validWorkspace(value: RungWorkspace): boolean {
	return (
		typeof value.id === "string" &&
		value.id.length > 0 &&
		typeof value.root === "string" &&
		value.root.length > 0
	);
}

function budget(
	request: SerialLadderRequest,
):
	| { readonly ok: true; readonly remaining: number }
	| { readonly ok: false; readonly failure: BuildEffectFailure } {
	let remaining: number;
	try {
		remaining = request.remainingBuildBudgetMilliseconds();
	} catch (cause) {
		return {
			ok: false,
			failure: effectFailure(cause, "Read Build budget"),
		};
	}
	if (!Number.isSafeInteger(remaining) || remaining < 0)
		return {
			ok: false,
			failure: invalidInput("Remaining Build budget is invalid."),
		};
	return { ok: true, remaining };
}

/**
 * Run the serial ladder against injected workspace/rung effects. Each attempt
 * gets a new workspace and a fresh six-repair allowance. Only the plan and
 * clipped summaries cross rung boundaries; candidate workspaces/diffs do not.
 */
export async function runSerialLadder(
	request: SerialLadderRequest,
): Promise<SerialLadderResult> {
	const attempts: SerialLadderAttemptRecord[] = [];
	const candidates: BuildCandidate[] = [];
	const usedWorkspaceIds = new Set<string>();
	const usedWorkspaceRoots = new Set<string>();
	let cursor = initialLadderCursor();
	if (request.plan.difficulty === "hard" && request.ladder.rungs.length > 1)
		return stopped(
			{
				code: "controller/parallel_ladder_required",
				message:
					"A hard ladder with more than one admitted rung must start through the parallel Build policy.",
				exitCode: 70,
			},
			attempts,
			candidates,
		);

	while (true) {
		const attempt = nextLadderAttempt(request.ladder, cursor);
		if (attempt === null)
			return {
				kind: "exhausted",
				candidates: Object.freeze([...candidates]),
				attempts: Object.freeze([...attempts]),
			};

		const available = budget(request);
		if (!available.ok) return stopped(available.failure, attempts, candidates);
		if (available.remaining === 0)
			return {
				kind: "budget",
				candidates: Object.freeze([...candidates]),
				attempts: Object.freeze([...attempts]),
			};
		const wallMilliseconds = Math.min(
			available.remaining,
			BUILD_RUNG_WALL_MILLISECONDS,
		);
		const previous = attempts.at(-1);
		const enteredBecause = previous?.outcome.reason ?? attempt.enteredBecause;

		try {
			await request.emit("rung_started", {
				rung: attempt.rung,
				model: attempt.role.effective.model,
				effort: attempt.role.effective.effort,
				entered_because: enteredBecause,
				wall_ms: wallMilliseconds,
			});
		} catch (cause) {
			return stopped(
				effectFailure(cause, "Record rung start"),
				attempts,
				candidates,
			);
		}

		let workspaceResult: Awaited<
			ReturnType<SerialLadderEffects["createWorkspace"]>
		>;
		try {
			workspaceResult = await request.effects.createWorkspace({
				runId: request.runId,
				attempt,
				base: request.base,
				approval: request.approval,
			});
		} catch (cause) {
			return stopped(
				effectFailure(cause, "Create rung workspace"),
				attempts,
				candidates,
			);
		}
		if (!workspaceResult.ok)
			return stopped(workspaceResult.error, attempts, candidates);
		const workspace = workspaceResult.value;
		if (!validWorkspace(workspace))
			return stopped(
				invalidInput("Rung workspace identity or root is invalid."),
				attempts,
				candidates,
			);
		if (
			usedWorkspaceIds.has(workspace.id) ||
			usedWorkspaceRoots.has(workspace.root)
		)
			return stopped(
				{
					code: "controller/ladder_workspace_reused",
					message: "Each ladder attempt must use a fresh workspace.",
					exitCode: 70,
				},
				attempts,
				candidates,
			);
		usedWorkspaceIds.add(workspace.id);
		usedWorkspaceRoots.add(workspace.root);

		let setup: Awaited<ReturnType<SerialLadderEffects["setup"]>>;
		try {
			setup = await request.effects.setup(workspace);
			if (!setup.ok) setup = await request.effects.setup(workspace);
		} catch (cause) {
			return stopped(
				effectFailure(cause, "Set up rung workspace"),
				attempts,
				candidates,
			);
		}
		if (!setup.ok)
			return stopped(
				{
					code: "environment/setup_failed",
					message: setup.error.message,
					exitCode: setup.error.exitCode,
				},
				attempts,
				candidates,
			);

		let rungResult: Awaited<ReturnType<SerialLadderEffects["run"]>>;
		try {
			rungResult = await request.effects.run({
				runId: request.runId,
				attempt,
				workspace,
				approval: request.approval,
				base: request.base,
				recipe: request.ladder.edgeTests
					? (`${request.ladder.recipe}+edge` as `${RecipeName}+edge`)
					: request.ladder.recipe,
				plan: attempt.input === "plan" ? request.plan : null,
				baseAcceptance: request.baseAcceptance,
				earlierAttempts: Object.freeze(
					attempts.map((record) => record.summary),
				),
				repairsLeft: BUILD_RUNG_REPAIR_LIMIT,
				wallMilliseconds,
				remainingBuildBudgetMilliseconds:
					request.remainingBuildBudgetMilliseconds,
				roles: request.roles,
				emit: request.emit,
			});
		} catch (cause) {
			return stopped(
				effectFailure(cause, "Run builder rung"),
				attempts,
				candidates,
			);
		}
		if (!rungResult.ok) return stopped(rungResult.error, attempts, candidates);
		const outcome = rungResult.value.outcome;
		if (
			outcome.candidate !== null &&
			(!sameWorkspace(outcome.candidate.workspace, workspace) ||
				outcome.candidate.rung !== attempt.rung)
		)
			return stopped(
				invalidInput(
					"Rung candidate does not match its attempt and fresh workspace.",
				),
				attempts,
				candidates,
			);
		if (outcome.kind === "green" && outcome.candidate === null)
			return stopped(
				invalidInput("A green rung did not return its verified candidate."),
				attempts,
				candidates,
			);

		const summary = summaryFor(attempt, outcome, rungResult.value.failureLines);
		const completed = Object.freeze({
			attempt,
			workspace,
			outcome,
			summary,
		});
		attempts.push(completed);
		if (outcome.candidate !== null) candidates.push(outcome.candidate);

		try {
			await request.emit("rung_finished", {
				rung: attempt.rung,
				reason: outcome.reason,
				verdict: outcome.kind,
			});
		} catch (cause) {
			return stopped(
				effectFailure(cause, "Record rung finish"),
				attempts,
				candidates,
			);
		}

		if (outcome.kind === "green")
			return {
				kind: "green",
				winner: outcome.candidate as BuildCandidate,
				attempts: Object.freeze([...attempts]),
			};
		if (outcome.kind === "stopped") {
			if (outcome.reason === "budget")
				return {
					kind: "budget",
					candidates: Object.freeze([...candidates]),
					attempts: Object.freeze([...attempts]),
				};
			return stopped(
				outcome.failure ?? {
					code: outcome.reason,
					message: outcome.reason,
					exitCode: 4,
				},
				attempts,
				candidates,
			);
		}
		if (outcome.reason === "budget")
			return {
				kind: "budget",
				candidates: Object.freeze([...candidates]),
				attempts: Object.freeze([...attempts]),
			};

		cursor = advanceLadderCursor(request.ladder, cursor, "red");
	}
}
