import type { Result } from "../contracts/errors";
import type { ResolvedRole } from "../project/roles";

export const BUILD_PLAN_TIMEOUT_MS = 900_000;
export const BUILD_PLAN_FILE_LIST_LIMIT = 160_000;

export type BuildDifficulty = "easy" | "hard";

export interface BuildPlan {
	readonly difficulty: BuildDifficulty;
	/** The complete planner response, retained as the rung's shared plan. */
	readonly text: string;
	readonly wordCount: number;
	readonly trackedPaths: readonly string[];
	readonly role: ResolvedRole;
}

export interface PlannerCompletionRequest {
	readonly role: ResolvedRole;
	readonly intentBytes: Uint8Array;
	readonly trackedPaths: readonly string[];
	readonly timeoutMilliseconds: 900_000;
	readonly tools: readonly [];
	readonly toolChoice: "none";
	readonly modelFallback: false;
}

export interface PlannerCompletionFailure {
	readonly code: string;
	readonly message: string;
	readonly exitCode: 3 | 4;
}

export interface PlannerCompletionPort {
	complete(
		request: PlannerCompletionRequest,
	): Promise<Result<{ readonly text: string }, PlannerCompletionFailure>>;
}

export interface BuildPlanFailure {
	readonly code: "candidate/plan_invalid" | "candidate/plan_too_long" | string;
	readonly message: string;
	readonly exitCode: 1 | 3 | 4;
}

export interface BuildPlannerRequest {
	readonly intentBytes: Uint8Array;
	readonly trackedPaths: readonly string[];
	readonly role: ResolvedRole;
	readonly maxWords: number;
	readonly completion: PlannerCompletionPort;
}

function validSingleLine(value: string): boolean {
	return value.length > 0 && !/[\r\n\0]/u.test(value);
}

/** Keep only whole Git paths, preserving Git's byte-sorted input order. */
export function boundedBuildFileList(
	paths: readonly string[],
	limit = BUILD_PLAN_FILE_LIST_LIMIT,
): readonly string[] {
	if (!Number.isSafeInteger(limit) || limit < 1)
		throw new RangeError("Build planner file-list limit must be positive.");
	const selected: string[] = [];
	let length = 0;
	for (const path of paths) {
		if (!validSingleLine(path))
			throw new TypeError(
				"Git returned a path that cannot be placed in the planner input.",
			);
		const separator = selected.length === 0 ? 0 : 1;
		const pathLength = [...path].length;
		if (length + separator + pathLength > limit) break;
		selected.push(path);
		length += separator + pathLength;
	}
	return Object.freeze(selected);
}

function wordCount(text: string): number {
	const trimmed = text.trim();
	return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

function parsePlan(text: string):
	| {
			readonly ok: true;
			readonly difficulty: BuildDifficulty;
			readonly wordCount: number;
	  }
	| {
			readonly ok: false;
			readonly code: "candidate/plan_invalid" | "candidate/plan_too_long";
			readonly message: string;
	  } {
	const lines = text.split("\n").map((line) => line.replace(/\r$/u, ""));
	const first = lines[0];
	if (first !== "Difficulty: easy" && first !== "Difficulty: hard")
		return {
			ok: false,
			code: "candidate/plan_invalid",
			message:
				"Planner response must begin with Difficulty: easy or Difficulty: hard.",
		};
	const expected = [
		"## Acceptance criteria",
		"## Technical approach",
		"## Implementation steps",
	];
	let previous = 0;
	for (const heading of expected) {
		const positions = lines.flatMap((line, index) =>
			line === heading ? [index] : [],
		);
		if (
			positions.length !== 1 ||
			positions[0] === undefined ||
			positions[0] <= previous
		)
			return {
				ok: false,
				code: "candidate/plan_invalid",
				message: `Planner response must contain ${heading} once and in order.`,
			};
		previous = positions[0];
	}
	const planWords = wordCount(`Implementation plan:\n${text}`);
	return {
		ok: true,
		difficulty: first === "Difficulty: hard" ? "hard" : "easy",
		wordCount: planWords,
	};
}

/** Make the single no-tools planner request and validate its plan and difficulty. */
export async function createBuildPlan(
	request: BuildPlannerRequest,
): Promise<Result<BuildPlan, BuildPlanFailure>> {
	if (
		!Number.isSafeInteger(request.maxWords) ||
		request.maxWords < 300 ||
		request.maxWords > 2_000
	)
		return {
			ok: false,
			error: {
				code: "candidate/plan_invalid",
				exitCode: 3,
				message: "build.plan_max_words must be an integer from 300 to 2000.",
			},
		};
	if (request.role.name !== "planner" || request.role.overloadFallback !== null)
		return {
			ok: false,
			error: {
				code: "candidate/plan_invalid",
				exitCode: 3,
				message:
					"Build planner requires the centrally resolved planner role without fallback.",
			},
		};
	let trackedPaths: readonly string[];
	try {
		trackedPaths = boundedBuildFileList(request.trackedPaths);
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "candidate/plan_invalid",
				exitCode: 3,
				message:
					cause instanceof Error
						? cause.message
						: "Build file list is invalid.",
			},
		};
	}
	let completion: Awaited<ReturnType<PlannerCompletionPort["complete"]>>;
	try {
		completion = await request.completion.complete({
			role: request.role,
			intentBytes: request.intentBytes.slice(),
			trackedPaths,
			timeoutMilliseconds: BUILD_PLAN_TIMEOUT_MS,
			tools: [],
			toolChoice: "none",
			modelFallback: false,
		});
	} catch (cause) {
		return {
			ok: false,
			error: {
				code: "environment/planner_failed",
				exitCode: 3,
				message:
					cause instanceof Error ? cause.message : "Planner request failed.",
			},
		};
	}
	if (!completion.ok) return { ok: false, error: completion.error };
	const parsed = parsePlan(completion.value.text);
	if (!parsed.ok)
		return {
			ok: false,
			error: { ...parsed, exitCode: 1 },
		};
	if (parsed.wordCount > request.maxWords)
		return {
			ok: false,
			error: {
				code: "candidate/plan_too_long",
				exitCode: 1,
				message: `Planner response has ${parsed.wordCount} words; build.plan_max_words is ${request.maxWords}.`,
			},
		};
	return {
		ok: true,
		value: {
			difficulty: parsed.difficulty,
			text: completion.value.text,
			wordCount: parsed.wordCount,
			trackedPaths,
			role: request.role,
		},
	};
}
