import type { Result } from "../contracts/errors";
import { parseIntent } from "../intent/parse";
import type { BuildCandidate, BuildEffectFailure } from "./controller";

export interface OptionalEdgeBuildSettings {
	readonly recipe?: string;
	readonly edgeTests?: boolean;
}

/** Edge generation is opt-in by config or by the frozen ladder suffix. */
export function optionalEdgeTestsEnabled(
	settings: OptionalEdgeBuildSettings | null | undefined,
): boolean {
	return (
		settings?.edgeTests === true ||
		(typeof settings?.recipe === "string" && settings.recipe.endsWith("+edge"))
	);
}

export interface EdgeTestCandidateInput {
	readonly candidate: BuildCandidate;
	/** Original Build attempt order; ties and cross-test order use this value. */
	readonly ordinal: number;
}

export interface EdgeCandidateIdentity {
	readonly ordinal: number;
	readonly rung: string;
}

export interface EdgeTestRunResult {
	readonly verdict: "green" | "red";
	/** The candidate must remain byte-for-byte at this verified tree. */
	readonly verifiedTree: string;
	readonly failureLines: readonly string[];
}

/**
 * Effects are deliberately injected. Generation receives only the approved
 * Request and attempt identity; it cannot use a candidate's implementation as
 * an alternate source of requirements.
 */
export interface EdgeTestEffects {
	generate(input: {
		readonly requestBytes: Uint8Array;
		readonly author: EdgeCandidateIdentity;
	}): Promise<Result<Uint8Array, BuildEffectFailure>>;
	run(input: {
		readonly target: BuildCandidate;
		readonly suiteAuthor: EdgeCandidateIdentity;
		readonly suiteBytes: Uint8Array;
	}): Promise<Result<EdgeTestRunResult, BuildEffectFailure>>;
}

export interface EdgeTestObservation {
	readonly targetOrdinal: number;
	readonly targetRung: string;
	readonly suiteOrdinal: number;
	readonly suiteRung: string;
	readonly verdict: "green" | "red";
	readonly failureLines: readonly string[];
}

export interface EdgeCandidateEvaluation extends EdgeTestCandidateInput {
	readonly edgeStatus: "passed" | "failed" | "not_run";
	/** False means this candidate must not be passed to landing as green. */
	readonly landable: boolean;
	readonly observations: readonly EdgeTestObservation[];
}

export type EdgeTestEvaluation =
	| {
			readonly kind: "disabled" | "checked";
			readonly candidates: readonly EdgeCandidateEvaluation[];
	  }
	| {
			readonly kind: "stopped";
			readonly failure: BuildEffectFailure;
			readonly candidates: readonly EdgeCandidateEvaluation[];
	  };

export interface OptionalEdgeTestsRequest {
	readonly enabled: boolean;
	readonly intentBytes: Uint8Array;
	readonly candidates: readonly EdgeTestCandidateInput[];
	readonly effects: EdgeTestEffects;
}

export interface EdgeSelectionDecision {
	readonly kind: "disabled" | "checked";
	readonly candidates: readonly EdgeCandidateEvaluation[];
	readonly selected: EdgeCandidateEvaluation | null;
	/** Selection may retain a red candidate, but it can never land. */
	readonly canLand: boolean;
}

export interface StoppedEdgeSelectionDecision {
	readonly kind: "stopped";
	readonly failure: BuildEffectFailure;
	readonly candidates: readonly EdgeCandidateEvaluation[];
	readonly selected: null;
	readonly canLand: false;
}

export type EdgeSelectionResult =
	| EdgeSelectionDecision
	| StoppedEdgeSelectionDecision;

function failure(
	code: string,
	message: string,
	exitCode: BuildEffectFailure["exitCode"] = 70,
): BuildEffectFailure {
	return { code, message, exitCode };
}

function identity(input: EdgeTestCandidateInput): EdgeCandidateIdentity {
	return Object.freeze({
		ordinal: input.ordinal,
		rung: input.candidate.rung,
	});
}

function validCandidate(input: EdgeTestCandidateInput): boolean {
	return (
		Number.isSafeInteger(input.ordinal) &&
		input.ordinal > 0 &&
		typeof input.candidate.rung === "string" &&
		input.candidate.rung.length > 0 &&
		typeof input.candidate.workspace.id === "string" &&
		input.candidate.workspace.id.length > 0 &&
		typeof input.candidate.workspace.root === "string" &&
		input.candidate.workspace.root.length > 0 &&
		typeof input.candidate.verifiedTree === "string" &&
		input.candidate.verifiedTree.length > 0 &&
		(input.candidate.verdict === "green" || input.candidate.verdict === "red")
	);
}

function orderedCandidates(
	input: readonly EdgeTestCandidateInput[],
): readonly EdgeTestCandidateInput[] | null {
	const ordinals = new Set<number>();
	for (const candidate of input) {
		if (!validCandidate(candidate) || ordinals.has(candidate.ordinal))
			return null;
		ordinals.add(candidate.ordinal);
	}
	return Object.freeze(
		[...input].sort((left, right) => left.ordinal - right.ordinal),
	);
}

function initialEvaluations(
	candidates: readonly EdgeTestCandidateInput[],
	observations: ReadonlyMap<number, readonly EdgeTestObservation[]> = new Map(),
	edgeEnabled: boolean,
	expectedSuiteCount: number,
	forceBlocked = false,
): readonly EdgeCandidateEvaluation[] {
	return Object.freeze(
		candidates.map((entry) => {
			const runs = observations.get(entry.ordinal) ?? [];
			const isCoreGreen = entry.candidate.verdict === "green";
			const complete =
				edgeEnabled &&
				isCoreGreen &&
				expectedSuiteCount > 0 &&
				runs.length === expectedSuiteCount;
			const passed = complete && runs.every((run) => run.verdict === "green");
			let edgeStatus: EdgeCandidateEvaluation["edgeStatus"] = "not_run";
			if (runs.length > 0) edgeStatus = passed ? "passed" : "failed";
			return Object.freeze({
				...entry,
				edgeStatus,
				landable: !forceBlocked && isCoreGreen && (!edgeEnabled || passed),
				observations: Object.freeze([...runs]),
			});
		}),
	);
}

function stop(
	problem: BuildEffectFailure,
	candidates: readonly EdgeTestCandidateInput[],
	observations: ReadonlyMap<number, readonly EdgeTestObservation[]>,
	expectedSuiteCount: number,
): EdgeTestEvaluation {
	return {
		kind: "stopped",
		failure: problem,
		candidates: initialEvaluations(
			candidates,
			observations,
			true,
			expectedSuiteCount,
			true,
		),
	};
}

function addObservation(
	observations: Map<number, EdgeTestObservation[]>,
	observation: EdgeTestObservation,
): void {
	const current = observations.get(observation.targetOrdinal) ?? [];
	current.push(Object.freeze(observation));
	observations.set(observation.targetOrdinal, current);
}

function validSuite(bytes: unknown): bytes is Uint8Array {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return false;
	try {
		return (
			new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim().length > 0
		);
	} catch {
		return false;
	}
}

/**
 * Generate one suite per core-green candidate from the exact approved Request,
 * then run every generated suite against every core-green candidate. With one
 * candidate this runs its own suite; with parallel green candidates it also
 * runs every peer's suite before returning to selection.
 */
export async function runOptionalEdgeTests(
	request: OptionalEdgeTestsRequest,
): Promise<EdgeTestEvaluation> {
	const candidates = orderedCandidates(request.candidates);
	if (candidates === null)
		return {
			kind: "stopped",
			failure: failure(
				"controller/edge_candidates_invalid",
				"Optional edge tests received invalid or duplicate candidate attempts.",
			),
			candidates: Object.freeze([]),
		};

	if (!request.enabled) {
		return {
			kind: "disabled",
			candidates: initialEvaluations(candidates, new Map(), false, 0),
		};
	}

	const green = candidates.filter(
		(entry) => entry.candidate.verdict === "green",
	);
	if (green.length === 0) {
		return {
			kind: "checked",
			candidates: initialEvaluations(candidates, new Map(), true, 0),
		};
	}

	const parsed = parseIntent(request.intentBytes);
	if (!parsed.ok || parsed.intent.requestBytes === null) {
		return stop(
			failure(
				"controller/edge_request_missing",
				"Optional edge tests require a valid approved Intent with a Request section.",
			),
			candidates,
			new Map(),
			green.length,
		);
	}
	if (parsed.intent.requestBytes.byteLength === 0) {
		return stop(
			failure(
				"controller/edge_request_empty",
				"Optional edge tests require a non-empty Request section.",
			),
			candidates,
			new Map(),
			green.length,
		);
	}

	const requestBytes = parsed.intent.requestBytes.slice();
	const suites = new Map<number, Uint8Array>();
	for (const author of green) {
		let generated: Result<Uint8Array, BuildEffectFailure>;
		try {
			generated = await request.effects.generate({
				requestBytes: requestBytes.slice(),
				author: identity(author),
			});
		} catch (cause) {
			return stop(
				failure(
					"environment/edge_generation_failed",
					cause instanceof Error
						? cause.message
						: "Optional edge test generation failed.",
					3,
				),
				candidates,
				new Map(),
				green.length,
			);
		}
		if (!generated.ok)
			return stop(generated.error, candidates, new Map(), green.length);
		if (!validSuite(generated.value))
			return stop(
				failure(
					"controller/edge_suite_invalid",
					"Optional edge generation returned empty or invalid UTF-8 test source.",
				),
				candidates,
				new Map(),
				green.length,
			);
		suites.set(author.ordinal, generated.value.slice());
	}

	const observations = new Map<number, EdgeTestObservation[]>();
	for (const target of green) {
		for (const author of green) {
			const suiteBytes = suites.get(author.ordinal);
			if (suiteBytes === undefined)
				return stop(
					failure(
						"controller/edge_suite_missing",
						"An edge test suite was not retained for a green candidate.",
					),
					candidates,
					observations,
					green.length,
				);
			let result: Result<EdgeTestRunResult, BuildEffectFailure>;
			try {
				result = await request.effects.run({
					target: target.candidate,
					suiteAuthor: identity(author),
					suiteBytes: suiteBytes.slice(),
				});
			} catch (cause) {
				return stop(
					failure(
						"environment/edge_run_failed",
						cause instanceof Error
							? cause.message
							: "Optional edge test execution failed.",
						3,
					),
					candidates,
					observations,
					green.length,
				);
			}
			if (!result.ok)
				return stop(result.error, candidates, observations, green.length);
			if (
				(result.value.verdict !== "green" && result.value.verdict !== "red") ||
				typeof result.value.verifiedTree !== "string" ||
				!Array.isArray(result.value.failureLines) ||
				result.value.failureLines.some((line) => typeof line !== "string")
			)
				return stop(
					failure(
						"controller/edge_result_invalid",
						"Optional edge test execution returned an invalid observation.",
					),
					candidates,
					observations,
					green.length,
				);
			if (result.value.verifiedTree !== target.candidate.verifiedTree)
				return stop(
					failure(
						"controller/edge_candidate_tree_changed",
						"Optional edge tests changed the candidate's verified tree.",
					),
					candidates,
					observations,
					green.length,
				);
			addObservation(observations, {
				targetOrdinal: target.ordinal,
				targetRung: target.candidate.rung,
				suiteOrdinal: author.ordinal,
				suiteRung: author.candidate.rung,
				verdict: result.value.verdict,
				failureLines: Object.freeze([...result.value.failureLines]),
			});
		}
	}

	return {
		kind: "checked",
		candidates: initialEvaluations(
			candidates,
			observations,
			true,
			green.length,
		),
	};
}

/**
 * Run all optional edge checks before calling deterministic candidate selection.
 * A selected candidate is landable only when its core gate and all required
 * edge checks are green. Effect or selector failures return no selection.
 */
export async function runOptionalEdgeTestsBeforeSelection(
	request: OptionalEdgeTestsRequest,
	select: (candidates: readonly EdgeCandidateEvaluation[]) => number | null,
): Promise<EdgeSelectionResult> {
	const evaluation = await runOptionalEdgeTests(request);
	if (evaluation.kind === "stopped")
		return {
			kind: "stopped",
			failure: evaluation.failure,
			candidates: evaluation.candidates,
			selected: null,
			canLand: false,
		};

	let selectedOrdinal: number | null;
	try {
		selectedOrdinal = select(evaluation.candidates);
	} catch (cause) {
		return {
			kind: "stopped",
			failure: failure(
				"environment/edge_selection_failed",
				cause instanceof Error
					? cause.message
					: "Deterministic selection failed after optional edge tests.",
				3,
			),
			candidates: evaluation.candidates,
			selected: null,
			canLand: false,
		};
	}
	if (
		selectedOrdinal !== null &&
		(!Number.isSafeInteger(selectedOrdinal) ||
			!evaluation.candidates.some(
				(candidate) => candidate.ordinal === selectedOrdinal,
			))
	)
		return {
			kind: "stopped",
			failure: failure(
				"controller/edge_selection_invalid",
				"Deterministic selection returned an unknown candidate attempt.",
			),
			candidates: evaluation.candidates,
			selected: null,
			canLand: false,
		};
	const selected =
		selectedOrdinal === null
			? null
			: (evaluation.candidates.find(
					(candidate) => candidate.ordinal === selectedOrdinal,
				) ?? null);
	return {
		kind: evaluation.kind,
		candidates: evaluation.candidates,
		selected,
		canLand: selected?.landable ?? false,
	};
}
