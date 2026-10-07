import type { ResponseToolCall } from "../sse/assemble";
import type { AdditionalToolHandler } from "./dispatch";

export const FINISH_ACCEPTED_RESULT =
	"Completion requested. Kogen will run the gate.";
export const FINISH_INVALID_RESULT =
	"finish requires an empty object and must be the only tool call. Continue implementing, then call finish alone with {}.";
export const FINISH_NO_CHANGES_RESULT =
	"Kogen found no changed files. Make the requested change before claiming done.";
export const BUILDER_TEXT_CONTINUATION =
	"Continue the entire approved Intent with the next useful tool call. Brief progress text does not finish the Build; call finish alone with {} when implementation and targeted verification are complete.";

export type FinishEvaluation =
	| {
			readonly kind: "continue";
			readonly output: string;
			readonly emptyFinishCount: number;
	  }
	| {
			readonly kind: "run_gate";
			readonly output: typeof FINISH_ACCEPTED_RESULT;
			readonly emptyFinishCount: number;
	  };

export interface FinishEvaluationInput {
	readonly argumentsValue: unknown;
	readonly isOnlyToolCall: boolean;
	readonly hasChanges: boolean;
	readonly emptyFinishCount: number;
}

function emptyObject(value: unknown): value is Record<string, never> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return (
		(prototype === Object.prototype || prototype === null) &&
		Object.keys(value).length === 0
	);
}

/** Shared finish-alone guard and the first-empty-finish rule for Build. */
export function evaluateFinish(input: FinishEvaluationInput): FinishEvaluation {
	if (
		!Number.isSafeInteger(input.emptyFinishCount) ||
		input.emptyFinishCount < 0
	)
		throw new RangeError("emptyFinishCount must be a non-negative integer");
	if (!input.isOnlyToolCall || !emptyObject(input.argumentsValue))
		return {
			kind: "continue",
			output: FINISH_INVALID_RESULT,
			emptyFinishCount: input.emptyFinishCount,
		};
	if (!input.hasChanges && input.emptyFinishCount === 0)
		return {
			kind: "continue",
			output: FINISH_NO_CHANGES_RESULT,
			emptyFinishCount: 1,
		};
	return {
		kind: "run_gate",
		output: FINISH_ACCEPTED_RESULT,
		emptyFinishCount: input.emptyFinishCount,
	};
}

/** A text-only builder response is progress and gets this exact next user item. */
export function textOnlyBuilderContinuation(): string {
	return BUILDER_TEXT_CONTINUATION;
}

/** Handler used by tool dispatch when the Build controller did not consume finish. */
export function createFinishToolHandler(): AdditionalToolHandler {
	return (argumentsValue, call, batch) =>
		finishCallResult(argumentsValue, call, batch);
}

export function finishCallResult(
	argumentsValue: Readonly<Record<string, unknown>>,
	call: ResponseToolCall,
	batch: readonly ResponseToolCall[],
): string {
	return evaluateFinish({
		argumentsValue,
		isOnlyToolCall: batch.length === 1 && batch[0] === call,
		hasChanges: true,
		emptyFinishCount: 0,
	}).output;
}
