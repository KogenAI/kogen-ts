import type { ResolvedRole, RoleResolution } from "../project/roles";
import type { RecipeName } from "../project/schema";

export const LADDER_RUNG_COUNT = 4;
export const LADDER_DEFAULT_MAX_RUNGS = 3;
export const LADDER_EXPERIMENTAL_DEFAULT_MAX_RUNGS = 4;
export const LADDER_DEFAULT_REPEAT_FROM = 2;

const CHATGPT_SOL_MODEL = "gpt-6.1-sol";
const LADDER_RECIPES = new Set<RecipeName>([
	"ladder",
	"ladder-diverse",
	"ladder-luna",
	"ladder-sol-low",
	"ladder-sol-medium",
	"ladder-sol-high",
]);

export interface LadderOptions {
	/** Maximum number of distinct initial rungs. Repeated attempts are separate. */
	readonly maxRungs: number;
	readonly experimentalR4: boolean;
	/** Zero-based rung index; null disables repeats. */
	readonly repeatFrom: number | null;
}

export interface LadderConfigDiagnostic {
	readonly path: string;
	readonly message: string;
}

export type LadderOptionsResult =
	| { readonly ok: true; readonly value: LadderOptions }
	| {
			readonly ok: false;
			readonly diagnostics: readonly LadderConfigDiagnostic[];
	  };

export interface LadderRungDefinition {
	/** One-based position in the initial ladder. */
	readonly index: 1 | 2 | 3 | 4;
	/** The journal/workspace rung identity. Repeat attempts append `-N`. */
	readonly rung: string;
	/** Human-readable model-stage name, also used in attempt summaries. */
	readonly name: string;
	readonly role: ResolvedRole;
	readonly input: "plan" | "request";
}

export interface LadderPlan {
	readonly recipe: RecipeName;
	readonly edgeTests: boolean;
	readonly options: LadderOptions;
	readonly rungs: readonly LadderRungDefinition[];
	readonly repeatsEnabled: boolean;
}

export interface LadderAttempt extends LadderRungDefinition {
	/** One-based count of attempts on this rung: first run is 1, next is 2. */
	readonly attemptNumber: number;
	/** Overall one-based order in this Build. */
	readonly ordinal: number;
	readonly enteredBecause: string;
}

export interface LadderCursor {
	readonly attemptsStarted: number;
	readonly finished: boolean;
}

export type LadderAttemptResult = "green" | "red" | "stopped" | "budget";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode the ladder-only settings that are admitted by the frozen draft.
 * Project YAML conversion remains owned by the project-schema packet.
 */
export function parseLadderOptions(value?: unknown): LadderOptionsResult {
	if (value !== undefined && !isRecord(value))
		return {
			ok: false,
			diagnostics: [
				{
					path: "build.ladder",
					message: "build.ladder must be a map",
				},
			],
		};

	const input = value ?? {};
	if (!isRecord(input)) throw new TypeError("Ladder options must be a map.");
	const diagnostics: LadderConfigDiagnostic[] = [];
	for (const key of Object.keys(input)) {
		if (
			key !== "max_rungs" &&
			key !== "experimental_r4" &&
			key !== "repeat_from"
		)
			diagnostics.push({
				path: `build.ladder.${key}`,
				message: `build.ladder has unknown key ${JSON.stringify(key)}`,
			});
	}

	const maxRungs = input.max_rungs;
	if (
		maxRungs !== undefined &&
		(typeof maxRungs !== "number" ||
			!Number.isSafeInteger(maxRungs) ||
			maxRungs < 1 ||
			maxRungs > LADDER_RUNG_COUNT)
	)
		diagnostics.push({
			path: "build.ladder.max_rungs",
			message: "build.ladder.max_rungs must be an integer from 1 to 4",
		});

	const experimentalR4 = input.experimental_r4;
	if (experimentalR4 !== undefined && typeof experimentalR4 !== "boolean")
		diagnostics.push({
			path: "build.ladder.experimental_r4",
			message: "build.ladder.experimental_r4 must be true or false",
		});

	const repeatFrom = input.repeat_from;
	if (
		repeatFrom !== undefined &&
		repeatFrom !== null &&
		(typeof repeatFrom !== "number" ||
			!Number.isSafeInteger(repeatFrom) ||
			repeatFrom < 0 ||
			repeatFrom >= LADDER_RUNG_COUNT)
	)
		diagnostics.push({
			path: "build.ladder.repeat_from",
			message:
				"build.ladder.repeat_from must be a zero-based rung index from 0 to 3 or null",
		});

	if (diagnostics.length > 0)
		return { ok: false, diagnostics: Object.freeze(diagnostics) };

	const admitsR4 = experimentalR4 === true;
	const resolvedRepeatFrom =
		repeatFrom === undefined
			? LADDER_DEFAULT_REPEAT_FROM
			: repeatFrom === null
				? null
				: typeof repeatFrom === "number"
					? repeatFrom
					: LADDER_DEFAULT_REPEAT_FROM;
	return {
		ok: true,
		value: Object.freeze({
			maxRungs:
				typeof maxRungs === "number"
					? maxRungs
					: admitsR4
						? LADDER_EXPERIMENTAL_DEFAULT_MAX_RUNGS
						: LADDER_DEFAULT_MAX_RUNGS,
			experimentalR4: admitsR4,
			repeatFrom: resolvedRepeatFrom,
		}),
	};
}

interface RungTemplate {
	readonly name: string;
	readonly model: "builder" | "sol-low" | "sol-medium" | "sol-high";
	readonly input: "plan" | "request";
}

const DEFAULT_TEMPLATE: readonly RungTemplate[] = [
	{ name: "builder", model: "builder", input: "plan" },
	{ name: "sol-medium", model: "sol-medium", input: "plan" },
	{ name: "sol-high", model: "sol-high", input: "plan" },
	{ name: "raw-request", model: "sol-high", input: "request" },
];

function templateFor(recipe: RecipeName): readonly RungTemplate[] | null {
	if (!LADDER_RECIPES.has(recipe)) return null;
	if (recipe === "ladder-diverse")
		return DEFAULT_TEMPLATE.map((rung, index) =>
			index === 1
				? { ...rung, name: "sol-medium-raw", input: "request" }
				: rung,
		);
	if (recipe === "ladder-luna")
		return DEFAULT_TEMPLATE.map((rung, index) => ({
			...rung,
			name:
				["builder", "fresh-2", "fresh-3", "raw-request"][index] ?? rung.name,
			model: "builder",
		}));
	if (
		recipe === "ladder-sol-low" ||
		recipe === "ladder-sol-medium" ||
		recipe === "ladder-sol-high"
	) {
		const model =
			recipe === "ladder-sol-low"
				? "sol-low"
				: recipe === "ladder-sol-medium"
					? "sol-medium"
					: "sol-high";
		return DEFAULT_TEMPLATE.map((rung, index) => ({
			...rung,
			name:
				["builder", "fresh-2", "fresh-3", "raw-request"][index] ?? rung.name,
			model,
		}));
	}
	return DEFAULT_TEMPLATE;
}

function roleForTemplate(
	template: RungTemplate,
	roles: RoleResolution,
): ResolvedRole {
	const builder = roles.roles.builder;
	if (template.model === "builder" || roles.provider === "grok") return builder;

	const effort = template.model.slice("sol-".length);
	const effective = Object.freeze({
		provider: "chatgpt" as const,
		model: CHATGPT_SOL_MODEL,
		effort,
	});
	return Object.freeze({
		...builder,
		requested: Object.freeze({ model: CHATGPT_SOL_MODEL, effort }),
		source: Object.freeze({
			model: "default" as const,
			effort: "default" as const,
		}),
		effective,
	});
}

function recipeParts(value: RecipeName | `${RecipeName}+edge`): {
	readonly recipe: RecipeName;
	readonly edgeTests: boolean;
} {
	if (value.endsWith("+edge"))
		return {
			recipe: value.slice(0, -"+edge".length) as RecipeName,
			edgeTests: true,
		};
	return { recipe: value as RecipeName, edgeTests: false };
}

/** Resolve the initial rungs and provider-consistent built-in model profiles. */
export function createLadderPlan(input: {
	readonly recipe: RecipeName | `${RecipeName}+edge`;
	readonly roles: RoleResolution;
	readonly options?: LadderOptions;
}): LadderPlan | null {
	const { recipe, edgeTests } = recipeParts(input.recipe);
	const template = templateFor(recipe);
	if (template === null) return null;
	const optionsResult = parseLadderOptions(
		input.options === undefined
			? undefined
			: {
					max_rungs: input.options.maxRungs,
					experimental_r4: input.options.experimentalR4,
					repeat_from: input.options.repeatFrom,
				},
	);
	if (!optionsResult.ok) return null;
	const options = optionsResult.value;
	const admitted = options.experimentalR4
		? template
		: template.slice(0, LADDER_RUNG_COUNT - 1);
	const selected = admitted.slice(0, options.maxRungs);
	const rungs = selected.map((rung, index) =>
		Object.freeze({
			index: (index + 1) as LadderRungDefinition["index"],
			rung: `R${index + 1}`,
			name: rung.name,
			role: roleForTemplate(rung, input.roles),
			input: rung.input,
		}),
	);
	return Object.freeze({
		recipe,
		edgeTests,
		options,
		rungs: Object.freeze(rungs),
		repeatsEnabled:
			rungs.length === LADDER_RUNG_COUNT && options.repeatFrom !== null,
	});
}

export function initialLadderCursor(): LadderCursor {
	return Object.freeze({ attemptsStarted: 0, finished: false });
}

/** Return the next initial or repeated rung without changing the cursor. */
export function nextLadderAttempt(
	plan: LadderPlan,
	cursor: LadderCursor,
): LadderAttempt | null {
	if (
		!Number.isSafeInteger(cursor.attemptsStarted) ||
		cursor.attemptsStarted < 0 ||
		typeof cursor.finished !== "boolean"
	)
		throw new TypeError("Ladder cursor is invalid.");
	if (cursor.finished) return null;

	const ordinal = cursor.attemptsStarted + 1;
	if (cursor.attemptsStarted < plan.rungs.length) {
		const rung = plan.rungs[cursor.attemptsStarted];
		if (rung === undefined) return null;
		return Object.freeze({
			...rung,
			attemptNumber: 1,
			ordinal,
			enteredBecause: cursor.attemptsStarted === 0 ? "first" : "escalation",
		});
	}
	if (!plan.repeatsEnabled || plan.options.repeatFrom === null) return null;

	const repeatFrom = plan.options.repeatFrom;
	const cycleLength = plan.rungs.length - repeatFrom;
	if (cycleLength < 1) return null;
	const repeatedAttempt = cursor.attemptsStarted - plan.rungs.length;
	const rungOffset = repeatedAttempt % cycleLength;
	const rungIndex = repeatFrom + rungOffset;
	const attemptNumber = Math.floor(repeatedAttempt / cycleLength) + 2;
	const rung = plan.rungs[rungIndex];
	if (rung === undefined) return null;
	return Object.freeze({
		...rung,
		rung: `${rung.rung}-${attemptNumber}`,
		name: `${rung.name}-${attemptNumber}`,
		attemptNumber,
		ordinal,
		enteredBecause: "repeat",
	});
}

/** A green, stopped, or budget-ended rung terminates this serial schedule. */
export function advanceLadderCursor(
	plan: LadderPlan,
	cursor: LadderCursor,
	result: LadderAttemptResult,
): LadderCursor {
	if (nextLadderAttempt(plan, cursor) === null)
		throw new TypeError("Cannot advance a completed ladder schedule.");
	if (result === "green" || result === "stopped" || result === "budget")
		return Object.freeze({
			attemptsStarted: cursor.attemptsStarted + 1,
			finished: true,
		});
	return Object.freeze({
		attemptsStarted: cursor.attemptsStarted + 1,
		finished: false,
	});
}
