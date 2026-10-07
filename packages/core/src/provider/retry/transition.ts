import {
	type ModelProvider,
	type ModelRef,
	type ModelRole,
	modelProvider,
} from "../../project/roles";

const BACKOFF_CEILINGS_MILLISECONDS = Object.freeze([
	2_000, 4_000, 8_000, 16_000, 32_000, 60_000,
]);

/** The single provider retry table. The v1.3 draft retains these §4.5 rules. */
export const RETRY_POLICY = Object.freeze({
	version: "responses-v1.2",
	attemptCap: 4,
	backoffCeilingsMilliseconds: BACKOFF_CEILINGS_MILLISECONDS,
	switchAfterConsecutiveOverloads: 2,
	buildPauseMilliseconds: 300_000,
	maximumBuildPauseMilliseconds: 86_400_000,
});

export type ProviderFailureClass =
	| "login"
	| "usage_limit"
	| "overload"
	| "timeout"
	| "stall"
	| "malformed"
	| "transport"
	| "incomplete"
	| "unsupported";

export type RetryExecutionMode = "build" | "shape";

export interface RetryStateInput {
	readonly provider: ModelProvider;
	readonly role: ModelRole;
	readonly model: string;
	readonly effort: string;
	readonly overloadFallback: ModelRef | null;
	readonly fallbackEnabled?: boolean;
	readonly mode: RetryExecutionMode;
}

export interface RetryState {
	readonly policyVersion: string;
	readonly provider: ModelProvider;
	readonly role: ModelRole;
	readonly mode: RetryExecutionMode;
	readonly model: string;
	readonly effort: string;
	readonly overloadFallback: ModelRef | null;
	readonly fallbackEnabled: boolean;
	readonly attempts: number;
	readonly consecutiveOverloads: number;
	readonly switched: boolean;
}

export type RetryDecision =
	| {
			readonly kind: "stop";
			readonly reason: ProviderFailureClass;
			readonly attempts: number;
	  }
	| {
			readonly kind: "retry_with_jitter";
			readonly reason: ProviderFailureClass;
			readonly minimumDelayMilliseconds: number;
			readonly maximumDelayMilliseconds: number;
			readonly continueWithPartialItems: boolean;
	  }
	| {
			readonly kind: "retry";
			readonly reason: ProviderFailureClass;
			readonly delayMilliseconds: number;
			readonly continueWithPartialItems: boolean;
	  }
	| {
			readonly kind: "switch";
			readonly reason: "overload";
			readonly from: ModelRef;
			readonly to: ModelRef;
			readonly delayMilliseconds: 0;
	  }
	| {
			readonly kind: "pause";
			readonly reason: "login" | "usage_limit";
			readonly delayMilliseconds: number;
			readonly budgetPaused: true;
	  };

export interface RetryTransition {
	readonly state: RetryState;
	readonly decision: RetryDecision;
}

export interface RetryFailureInput {
	readonly failureClass: ProviderFailureClass;
	/** Build mode must supply the remaining active budget; Shape has no such budget. */
	readonly remainingBuildBudgetMilliseconds: number | null;
	/** Remaining cumulative, unscaled login/usage pause budget for the Build. */
	readonly remainingPauseBudgetMilliseconds: number;
	readonly hasPartialItems: boolean;
}

export interface JitterRetryDecision {
	readonly kind: "retry_with_jitter";
	readonly reason: ProviderFailureClass;
	readonly minimumDelayMilliseconds: number;
	readonly maximumDelayMilliseconds: number;
	readonly continueWithPartialItems: boolean;
}

export type SettledRetryDecision =
	| Extract<RetryDecision, { readonly kind: "retry" }>
	| Extract<RetryDecision, { readonly kind: "stop" }>;

/**
 * Mutable across one Build so its 24-hour pause allowance cannot reset when a
 * new provider request or stage starts. Reservations make concurrent waits
 * count against the same cap before either one sleeps.
 */
export class ProviderPauseBudget {
	readonly maximumMilliseconds: number;
	private used = 0;
	private reserved = 0;
	private readonly activeReservations = new WeakSet<object>();

	constructor(
		maximumMilliseconds = RETRY_POLICY.maximumBuildPauseMilliseconds,
	) {
		assertNonNegativeSafeInteger(maximumMilliseconds, "maximum pause budget");
		this.maximumMilliseconds = maximumMilliseconds;
	}

	get usedMilliseconds(): number {
		return this.used;
	}

	get remainingMilliseconds(): number {
		return this.maximumMilliseconds - this.used - this.reserved;
	}

	reserve(milliseconds: number): { readonly milliseconds: number } | null {
		assertPositiveSafeInteger(milliseconds, "pause reservation");
		if (milliseconds > this.remainingMilliseconds) return null;
		this.reserved += milliseconds;
		const reservation = Object.freeze({ milliseconds });
		this.activeReservations.add(reservation);
		return reservation;
	}

	complete(reservation: { readonly milliseconds: number }): void {
		this.finishReservation(reservation);
		this.used += reservation.milliseconds;
	}

	release(reservation: { readonly milliseconds: number }): void {
		this.finishReservation(reservation);
	}

	private finishReservation(reservation: {
		readonly milliseconds: number;
	}): void {
		if (!this.activeReservations.delete(reservation))
			throw new TypeError("Provider pause reservation is not active.");
		this.reserved -= reservation.milliseconds;
	}
}

/** Start a request-scoped retry state from the centrally resolved role. */
export function initialRetryState(input: RetryStateInput): RetryState {
	if (input.provider !== "chatgpt" && input.provider !== "grok")
		throw new TypeError("Retry provider is invalid.");
	if (input.mode !== "build" && input.mode !== "shape")
		throw new TypeError("Retry execution mode is invalid.");
	if (modelProvider(input.model) !== input.provider)
		throw new TypeError(
			"Retry model does not belong to the selected provider.",
		);
	validateSingleLine(input.model, "Retry model");
	validateSingleLine(input.effort, "Retry effort");

	const fallback = input.overloadFallback;
	if (fallback !== null) {
		if (input.role === "planner")
			throw new TypeError("The planner has no overload fallback.");
		if (input.provider === "grok")
			throw new TypeError("Grok does not have an overload model switch.");
		if (
			fallback.provider !== input.provider ||
			modelProvider(fallback.model) !== fallback.provider
		)
			throw new TypeError(
				"Retry fallback must belong to the selected provider.",
			);
		validateSingleLine(fallback.model, "Retry fallback model");
		validateSingleLine(fallback.effort, "Retry fallback effort");
	}

	const fallbackEnabled = input.fallbackEnabled ?? true;
	if (typeof fallbackEnabled !== "boolean")
		throw new TypeError("Retry fallback setting must be a boolean.");
	const alreadyOnFallback =
		fallback !== null &&
		input.model === fallback.model &&
		input.effort === fallback.effort;

	return Object.freeze({
		policyVersion: RETRY_POLICY.version,
		provider: input.provider,
		role: input.role,
		mode: input.mode,
		model: input.model,
		effort: input.effort,
		overloadFallback: fallback === null ? null : Object.freeze({ ...fallback }),
		fallbackEnabled,
		attempts: 0,
		consecutiveOverloads: 0,
		switched: alreadyOnFallback,
	});
}

/** Pure §4.5 state transition after one failed HTTP attempt. */
export function stepRetry(
	state: RetryState,
	event: RetryFailureInput,
): RetryTransition {
	validateState(state);
	assertNonNegativeSafeInteger(
		event.remainingPauseBudgetMilliseconds,
		"remaining pause budget",
	);
	if (state.mode === "build") {
		if (event.remainingBuildBudgetMilliseconds === null)
			throw new TypeError("Build retries require a remaining wall budget.");
		assertNonNegativeSafeInteger(
			event.remainingBuildBudgetMilliseconds,
			"remaining Build budget",
		);
	} else if (event.remainingBuildBudgetMilliseconds !== null) {
		throw new TypeError("Shape retries do not have a total wall budget.");
	}
	if (typeof event.hasPartialItems !== "boolean")
		throw new TypeError("Partial-item state must be a boolean.");

	const attempts = state.attempts + 1;
	if (!Number.isSafeInteger(attempts))
		throw new RangeError(
			"Provider attempt count exceeded the safe integer range.",
		);
	const consecutiveOverloads =
		event.failureClass === "overload" ? state.consecutiveOverloads + 1 : 0;
	const failureState: RetryState = Object.freeze({
		...state,
		attempts,
		consecutiveOverloads,
	});

	if (event.failureClass === "login" || event.failureClass === "usage_limit") {
		if (
			state.mode === "build" &&
			event.remainingBuildBudgetMilliseconds !== 0 &&
			event.remainingPauseBudgetMilliseconds >=
				RETRY_POLICY.buildPauseMilliseconds
		) {
			return {
				state: failureState,
				decision: {
					kind: "pause",
					reason: event.failureClass,
					delayMilliseconds: RETRY_POLICY.buildPauseMilliseconds,
					budgetPaused: true,
				},
			};
		}
		return {
			state: failureState,
			decision: stopped(event.failureClass, attempts),
		};
	}

	if (!isTransient(event.failureClass))
		return {
			state: failureState,
			decision: stopped(event.failureClass, attempts),
		};

	if (state.mode === "build" && event.remainingBuildBudgetMilliseconds === 0)
		return {
			state: failureState,
			decision: stopped(event.failureClass, attempts),
		};

	const fallback = state.overloadFallback;
	if (
		event.failureClass === "overload" &&
		consecutiveOverloads >= RETRY_POLICY.switchAfterConsecutiveOverloads &&
		state.fallbackEnabled &&
		fallback !== null &&
		!state.switched
	) {
		const from = Object.freeze({
			provider: state.provider,
			model: state.model,
			effort: state.effort,
		});
		const switchedState = Object.freeze({
			...failureState,
			model: fallback.model,
			effort: fallback.effort,
			switched: true,
		});
		return {
			state: switchedState,
			decision: {
				kind: "switch",
				reason: "overload",
				from,
				to: fallback,
				delayMilliseconds: 0,
			},
		};
	}

	const unboundedConfiguredBuildOverload =
		state.mode === "build" &&
		state.provider === "chatgpt" &&
		(state.role === "builder" ||
			state.role === "context" ||
			state.role === "reviewer") &&
		!state.fallbackEnabled;
	const attemptCapped =
		state.mode === "shape" ||
		(event.failureClass === "overload" && !unboundedConfiguredBuildOverload) ||
		event.failureClass === "malformed";
	if (attemptCapped && attempts >= RETRY_POLICY.attemptCap)
		return {
			state: failureState,
			decision: stopped(event.failureClass, attempts),
		};

	const ceiling = backoffCeiling(attempts);
	return {
		state: failureState,
		decision: {
			kind: "retry_with_jitter",
			reason: event.failureClass,
			minimumDelayMilliseconds: Math.floor(ceiling / 2),
			maximumDelayMilliseconds: ceiling,
			continueWithPartialItems: shouldContinueWithPartialItems(
				event.failureClass,
				event.hasPartialItems,
			),
		},
	};
}

/** Choose a single jittered delay and enforce the active Build budget. */
export function settleJitteredRetry(
	state: RetryState,
	decision: JitterRetryDecision,
	delayMilliseconds: number,
	remainingBuildBudgetMilliseconds: number | null,
): SettledRetryDecision {
	validateState(state);
	assertNonNegativeSafeInteger(delayMilliseconds, "retry delay");
	if (
		delayMilliseconds < decision.minimumDelayMilliseconds ||
		delayMilliseconds > decision.maximumDelayMilliseconds
	)
		throw new RangeError(
			"Jittered retry delay is outside the policy interval.",
		);
	if (state.mode === "build") {
		if (remainingBuildBudgetMilliseconds === null)
			throw new TypeError("Build retries require a remaining wall budget.");
		assertNonNegativeSafeInteger(
			remainingBuildBudgetMilliseconds,
			"remaining Build budget",
		);
		if (
			remainingBuildBudgetMilliseconds === 0 ||
			delayMilliseconds > remainingBuildBudgetMilliseconds
		)
			return stopped(decision.reason, state.attempts);
	} else if (remainingBuildBudgetMilliseconds !== null) {
		throw new TypeError("Shape retries do not have a total wall budget.");
	}
	return {
		kind: "retry",
		reason: decision.reason,
		delayMilliseconds,
		continueWithPartialItems: decision.continueWithPartialItems,
	};
}

export function shouldContinueWithPartialItems(
	failureClass: ProviderFailureClass,
	hasPartialItems: boolean,
): boolean {
	return (
		hasPartialItems &&
		(failureClass === "timeout" ||
			failureClass === "stall" ||
			failureClass === "transport" ||
			failureClass === "malformed")
	);
}

function backoffCeiling(attempt: number): number {
	const index = Math.min(
		attempt - 1,
		RETRY_POLICY.backoffCeilingsMilliseconds.length - 1,
	);
	const ceiling = RETRY_POLICY.backoffCeilingsMilliseconds[index];
	if (ceiling === undefined)
		throw new RangeError("Retry backoff table is empty.");
	return ceiling;
}

function isTransient(
	failureClass: ProviderFailureClass,
): failureClass is
	| "overload"
	| "malformed"
	| "timeout"
	| "stall"
	| "transport" {
	return (
		failureClass === "overload" ||
		failureClass === "malformed" ||
		failureClass === "timeout" ||
		failureClass === "stall" ||
		failureClass === "transport"
	);
}

function stopped(
	reason: ProviderFailureClass,
	attempts: number,
): Extract<RetryDecision, { readonly kind: "stop" }> {
	return { kind: "stop", reason, attempts };
}

function validateState(state: RetryState): void {
	if (state.policyVersion !== RETRY_POLICY.version)
		throw new TypeError("Retry policy version is not supported.");
	if (state.provider !== "chatgpt" && state.provider !== "grok")
		throw new TypeError("Retry provider is invalid.");
	if (state.mode !== "build" && state.mode !== "shape")
		throw new TypeError("Retry execution mode is invalid.");
	if (modelProvider(state.model) !== state.provider)
		throw new TypeError(
			"Retry model does not belong to the selected provider.",
		);
	assertNonNegativeSafeInteger(state.attempts, "provider attempt count");
	assertNonNegativeSafeInteger(
		state.consecutiveOverloads,
		"consecutive overload count",
	);
}

function validateSingleLine(value: string, label: string): void {
	if (typeof value !== "string" || value.length === 0 || /[\r\n\0]/.test(value))
		throw new TypeError(`${label} is invalid.`);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError(`${label} must be a non-negative safe integer.`);
}

function assertPositiveSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new RangeError(`${label} must be a positive safe integer.`);
}
