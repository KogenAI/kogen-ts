import type { Result } from "../../contracts/errors";
import type { ResolvedRole, RoleResolution } from "../../project/roles";
import type { RecipeName } from "../../project/schema";
import { roleToolAuthorizationForRecipe } from "../../provider/tools/schema";
import type { BuildEffectFailure } from "../controller";
import { createLadderPlan } from "../ladder";

export const DIRECT_RECIPE_NAMES = [
	"direct",
	"direct-escalate",
	"direct-shell",
	"escalate-shell",
] as const satisfies readonly RecipeName[];

export type DirectRecipeName = (typeof DIRECT_RECIPE_NAMES)[number];
export type DirectRecipeInput = {
	readonly recipe: DirectRecipeName;
	readonly rung: string;
	readonly name: string;
	readonly index: number;
	readonly role: ResolvedRole;
	readonly input: "request";
	readonly plan: null;
	readonly tools: readonly string[];
};

export interface DirectRecipePlan {
	readonly recipe: DirectRecipeName;
	readonly planning: "none";
	readonly toolMode: "direct" | "shell";
	readonly attempts: readonly DirectRecipeInput[];
}

export interface DirectAttemptObservation<Candidate> {
	/** Verdict from the shared Build gate after this attempt's final snapshot. */
	readonly verdict: "green" | "red" | "stopped" | "budget";
	readonly candidate: Candidate | null;
	readonly reason: string;
}

export type DirectRecipeExecution<Candidate> =
	| {
			readonly kind: "green";
			readonly candidate: Candidate;
			readonly attempt: DirectRecipeInput;
			readonly attemptsRun: number;
			readonly candidates: readonly {
				readonly attempt: DirectRecipeInput;
				readonly candidate: Candidate;
			}[];
	  }
	| {
			readonly kind: "exhausted";
			readonly candidate: Candidate | null;
			readonly reason: string;
			readonly attemptsRun: number;
			readonly candidates: readonly {
				readonly attempt: DirectRecipeInput;
				readonly candidate: Candidate;
			}[];
	  }
	| {
			readonly kind: "stopped" | "budget";
			readonly candidate: Candidate | null;
			readonly reason: string;
			readonly attemptsRun: number;
			readonly candidates: readonly {
				readonly attempt: DirectRecipeInput;
				readonly candidate: Candidate;
			}[];
	  }
	| {
			readonly kind: "failed";
			readonly failure: BuildEffectFailure;
			readonly attemptsRun: number;
			readonly candidates: readonly {
				readonly attempt: DirectRecipeInput;
				readonly candidate: Candidate;
			}[];
	  };

function isDirectRecipe(recipe: string): recipe is DirectRecipeName {
	return (DIRECT_RECIPE_NAMES as readonly string[]).includes(recipe);
}

/**
 * Resolve a no-plan recipe. `direct-escalate` and `escalate-shell` reuse the
 * centrally defined ladder model profiles, while every attempt receives the
 * approved Request instead of a generated plan. The caller still owns the
 * Build claim, workspace, gate, and landing effects.
 */
export function createDirectRecipePlan(input: {
	readonly recipe: RecipeName | `${RecipeName}+edge`;
	readonly roles: RoleResolution;
}): DirectRecipePlan | null {
	// The frozen contract permits +edge on ladder recipes only.
	const recipe = input.recipe;
	if (recipe.endsWith("+edge")) return null;
	if (!isDirectRecipe(recipe)) return null;
	if (input.roles.roles.builder.name !== "builder") return null;

	const escalating =
		recipe === "direct-escalate" || recipe === "escalate-shell";
	const toolMode =
		recipe === "direct" || recipe === "direct-escalate" ? "direct" : "shell";
	const tools = roleToolAuthorizationForRecipe(recipe).builder;
	if (tools === undefined) return null;
	const ladder = escalating
		? createLadderPlan({ recipe: "ladder", roles: input.roles })
		: null;
	const profiles = ladder?.rungs ?? [
		{
			rung: "R1",
			name: "builder",
			role: input.roles.roles.builder,
		},
	];
	const attempts = profiles.map((profile, index) =>
		Object.freeze({
			recipe,
			rung: profile.rung,
			name: profile.name,
			index: index + 1,
			role: profile.role,
			input: "request" as const,
			plan: null,
			tools,
		}),
	);
	return Object.freeze({
		recipe,
		planning: "none",
		toolMode,
		attempts: Object.freeze(attempts),
	});
}

/**
 * Run direct attempts through the caller's shared rung/gate effect. A red
 * attempt advances only when the recipe admits another profile; stopped and
 * budget results retain their ordinary Build meanings. Landing stays with the
 * outer Build controller, which also owns the per-origin claim.
 */
export async function runDirectRecipe<Candidate>(input: {
	readonly plan: DirectRecipePlan;
	readonly runAttempt: (
		attempt: DirectRecipeInput,
	) => Promise<Result<DirectAttemptObservation<Candidate>, BuildEffectFailure>>;
}): Promise<DirectRecipeExecution<Candidate>> {
	let lastCandidate: Candidate | null = null;
	let lastReason = "direct recipe exhausted";
	let attemptsRun = 0;
	const candidates: {
		readonly attempt: DirectRecipeInput;
		readonly candidate: Candidate;
	}[] = [];
	for (const attempt of input.plan.attempts) {
		attemptsRun += 1;
		let result: Result<DirectAttemptObservation<Candidate>, BuildEffectFailure>;
		try {
			result = await input.runAttempt(attempt);
		} catch (cause) {
			return {
				kind: "failed",
				failure: {
					code: "environment/direct_attempt_failed",
					message:
						cause instanceof Error
							? cause.message
							: "Direct Build attempt failed.",
					exitCode: 3,
				},
				attemptsRun,
				candidates: Object.freeze([...candidates]),
			};
		}
		if (!result.ok)
			return {
				kind: "failed",
				failure: result.error,
				attemptsRun,
				candidates: Object.freeze([...candidates]),
			};
		const observation = result.value;
		lastCandidate = observation.candidate;
		lastReason = observation.reason;
		if (observation.candidate !== null)
			candidates.push({ attempt, candidate: observation.candidate });
		if (observation.verdict === "green") {
			if (observation.candidate === null)
				return {
					kind: "failed",
					failure: {
						code: "controller/direct_candidate_missing",
						message: "A green direct attempt returned no verified candidate.",
						exitCode: 70,
					},
					attemptsRun,
					candidates: Object.freeze([...candidates]),
				};
			return {
				kind: "green",
				candidate: observation.candidate,
				attempt,
				attemptsRun,
				candidates: Object.freeze([...candidates]),
			};
		}
		if (observation.verdict === "stopped" || observation.verdict === "budget")
			return {
				kind: observation.verdict,
				candidate: observation.candidate,
				reason: observation.reason,
				attemptsRun,
				candidates: Object.freeze([...candidates]),
			};
	}
	return {
		kind: "exhausted",
		candidate: lastCandidate,
		reason: lastReason,
		attemptsRun,
		candidates: Object.freeze([...candidates]),
	};
}
