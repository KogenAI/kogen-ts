import type { Result } from "../../contracts/errors";
import type { ResolvedRole, RoleResolution } from "../../project/roles";
import type { RecipeName } from "../../project/schema";
import { roleToolAuthorizationForRecipe } from "../../provider/tools/schema";
import type { BuildCandidate, BuildEffectFailure } from "../controller";

export interface StagedRecipePlan {
	readonly recipe: "staged";
	readonly contextRole: ResolvedRole;
	readonly plannerRole: ResolvedRole;
	readonly builderRole: ResolvedRole;
	readonly reviewerRole: ResolvedRole;
	readonly contextTools: readonly [];
	readonly plannerTools: readonly [];
	readonly builderTools: readonly string[];
	readonly reviewerTools: readonly [];
}

export interface StagedGateObservation {
	readonly status: "green" | "red";
}

export interface StagedCoreResult<Value, Gate extends StagedGateObservation> {
	readonly value: Value;
	readonly candidate: BuildCandidate | null;
	readonly gate: Gate;
}

export type StagedRecipeExecution<Value, Gate extends StagedGateObservation> =
	| {
			readonly kind: "ready";
			readonly context: string;
			readonly core: StagedCoreResult<Value, Gate> & {
				readonly candidate: BuildCandidate;
			};
			readonly review: string;
	  }
	| {
			readonly kind: "red";
			readonly context: string;
			readonly core: StagedCoreResult<Value, Gate>;
	  }
	| {
			readonly kind: "stopped";
			readonly failure: BuildEffectFailure;
	  };

export interface StagedRecipeEffects<
	Value,
	Gate extends StagedGateObservation,
> {
	/** Tool-less context request that runs before the planner. */
	context(input: {
		readonly role: ResolvedRole;
		readonly intentBytes: Uint8Array;
		readonly trackedPaths: readonly string[];
		readonly tools: readonly [];
	}): Promise<Result<string, BuildEffectFailure>>;
	/** Shared plan, builder, and gate path. It returns before landing/commit. */
	runCore(input: {
		readonly context: string;
		readonly contextRole: ResolvedRole;
		readonly plannerRole: ResolvedRole;
		readonly builderRole: ResolvedRole;
		readonly plannerTools: readonly [];
		readonly tools: readonly string[];
	}): Promise<Result<StagedCoreResult<Value, Gate>, BuildEffectFailure>>;
	/** Tool-less review of a green, gate-verified candidate before landing. */
	review(input: {
		readonly role: ResolvedRole;
		readonly context: string;
		readonly candidate: BuildCandidate;
		readonly gate: Gate;
		readonly tools: readonly [];
	}): Promise<Result<string, BuildEffectFailure>>;
}

/**
 * Resolve the staged recipe's centrally configured roles. The extra stages
 * are no-tools requests; the ordinary builder keeps the shell-recipe allowlist.
 */
export function createStagedRecipePlan(input: {
	readonly recipe: RecipeName | `${RecipeName}+edge`;
	readonly roles: RoleResolution;
}): StagedRecipePlan | null {
	if (input.recipe !== "staged") return null;
	const authorization = roleToolAuthorizationForRecipe("staged");
	const builderTools = authorization.builder;
	if (builderTools === undefined) return null;
	const noTools: readonly [] = Object.freeze([]);
	return Object.freeze({
		recipe: "staged",
		contextRole: input.roles.roles.context,
		plannerRole: input.roles.roles.planner,
		builderRole: input.roles.roles.builder,
		reviewerRole: input.roles.roles.reviewer,
		contextTools: noTools,
		plannerTools: noTools,
		builderTools,
		reviewerTools: noTools,
	});
}

/**
 * Execute the staged hooks around the caller's normal Build core. The caller
 * acquires/releases the ordinary origin claim and lands the returned candidate
 * with the ordinary landing CAS. The reviewer result is retained as a note;
 * it cannot rewrite the gate verdict or candidate eligibility.
 */
export async function runStagedRecipe<
	Value,
	Gate extends StagedGateObservation,
>(input: {
	readonly plan: StagedRecipePlan;
	readonly intentBytes: Uint8Array;
	readonly trackedPaths: readonly string[];
	readonly effects: StagedRecipeEffects<Value, Gate>;
}): Promise<StagedRecipeExecution<Value, Gate>> {
	let context: Result<string, BuildEffectFailure>;
	try {
		context = await input.effects.context({
			role: input.plan.contextRole,
			intentBytes: input.intentBytes.slice(),
			trackedPaths: Object.freeze([...input.trackedPaths]),
			tools: input.plan.contextTools,
		});
	} catch (cause) {
		return {
			kind: "stopped",
			failure: stageFailure("context", cause),
		};
	}
	if (!context.ok) return { kind: "stopped", failure: context.error };

	let core: Result<StagedCoreResult<Value, Gate>, BuildEffectFailure>;
	try {
		core = await input.effects.runCore({
			context: context.value,
			contextRole: input.plan.contextRole,
			plannerRole: input.plan.plannerRole,
			builderRole: input.plan.builderRole,
			plannerTools: input.plan.plannerTools,
			tools: input.plan.builderTools,
		});
	} catch (cause) {
		return { kind: "stopped", failure: stageFailure("build", cause) };
	}
	if (!core.ok) return { kind: "stopped", failure: core.error };
	if (core.value.gate.status === "red")
		return { kind: "red", context: context.value, core: core.value };
	if (core.value.candidate === null || core.value.candidate.verdict !== "green")
		return {
			kind: "stopped",
			failure: {
				code: "controller/staged_candidate_invalid",
				message:
					"A green staged gate must return a green, gate-verified candidate.",
				exitCode: 70,
			},
		};

	let review: Result<string, BuildEffectFailure>;
	try {
		review = await input.effects.review({
			role: input.plan.reviewerRole,
			context: context.value,
			candidate: core.value.candidate,
			gate: core.value.gate,
			tools: input.plan.reviewerTools,
		});
	} catch (cause) {
		return { kind: "stopped", failure: stageFailure("review", cause) };
	}
	if (!review.ok) return { kind: "stopped", failure: review.error };
	return {
		kind: "ready",
		context: context.value,
		core: {
			...core.value,
			candidate: core.value.candidate,
		},
		review: review.value,
	};
}

function stageFailure(stage: string, cause: unknown): BuildEffectFailure {
	return {
		code: `environment/staged_${stage}_failed`,
		message:
			cause instanceof Error ? cause.message : `Staged ${stage} stage failed.`,
		exitCode: 3,
	};
}
