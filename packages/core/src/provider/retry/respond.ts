import type { ClockPort } from "../../contracts/clock";
import type { RandomPort } from "../../contracts/ports";
import type { ResolvedRole } from "../../project/roles";
import type { SessionState } from "../session/transition";
import { stepSession } from "../session/transition";
import {
	type EncodedSessionRequest,
	encodeSessionRequest,
} from "../session/wire";
import type { AssembledResponse } from "../sse/assemble";
import type { ResponseUsage } from "../sse/usage";
import {
	initialRetryState,
	type ProviderFailureClass,
	type ProviderPauseBudget,
	type RetryDecision,
	type RetryExecutionMode,
	type RetryState,
	settleJitteredRetry,
	shouldContinueWithPartialItems,
	stepRetry,
} from "./transition";

export const STREAM_CONTINUATION_INSTRUCTION =
	"The response stream was interrupted. Continue the same turn from the received progress above. Preserve its findings and constraints; do not restart the task or repeat completed work. Proposed tool calls above were not executed; reissue any still needed.";

export interface ProviderAttemptFailure {
	readonly class: ProviderFailureClass;
	readonly message: string;
	readonly retryAfterMilliseconds?: number;
	/** Exact JSON source for received items; failed items never expose executable calls. */
	readonly partialItemJson?: readonly string[];
	readonly usage?: ResponseUsage | null;
	readonly cutAfterMilliseconds?: number | null;
}

export type ProviderAttemptResult =
	| { readonly ok: true; readonly response: AssembledResponse }
	| { readonly ok: false; readonly error: ProviderAttemptFailure };

export interface SendProviderAttemptInput {
	readonly request: EncodedSessionRequest;
	readonly session: SessionState;
	readonly attempt: number;
	readonly signal?: AbortSignal;
}

export type SendProviderAttempt = (
	input: SendProviderAttemptInput,
) => Promise<ProviderAttemptResult>;

export type ProviderRetryEvent =
	| {
			readonly event: "provider_retry";
			readonly stage: string;
			readonly reason: `provider/${ProviderFailureClass}`;
			readonly delay_ms: number;
	  }
	| {
			readonly event: "provider_switch";
			readonly stage: string;
			readonly from_model: string;
			readonly to_model: string;
	  }
	| {
			readonly event: "provider_wait";
			readonly stage: string;
			readonly reason: "provider/login" | "provider/usage_limit";
			readonly wait_ms: number;
			readonly budget_paused: true;
	  };

export interface ProviderAttemptRecord {
	readonly attempt: number;
	readonly model: string;
	readonly effort: string;
	readonly requestSha256: string;
	readonly startedAtUnixMilliseconds: number;
	readonly finishedAtUnixMilliseconds: number;
	readonly elapsedMilliseconds: number;
	readonly resumed: boolean;
	readonly result: "completed" | ProviderFailureClass;
	readonly partialItemCount: number;
	readonly cutAfterMilliseconds: number | null;
	readonly usage: ResponseUsage | null;
}

interface RespondResultBase {
	readonly session: SessionState;
	readonly attempts: readonly ProviderAttemptRecord[];
	readonly events: readonly ProviderRetryEvent[];
	readonly retryState: RetryState;
}

export type RespondResult =
	| (RespondResultBase & {
			readonly kind: "completed";
			readonly response: AssembledResponse;
	  })
	| (RespondResultBase & {
			readonly kind: "stopped";
			readonly status: "stopped";
			readonly exitCode: 4;
			readonly reason: `provider/${ProviderFailureClass}`;
			readonly error: ProviderAttemptFailure;
	  })
	| (RespondResultBase & {
			readonly kind: "budget_exhausted";
			readonly status: "budget";
	  })
	| (RespondResultBase & {
			readonly kind: "cancelled";
			readonly status: "cancelled";
	  });

export interface RespondInput {
	readonly session: SessionState;
	readonly resolvedRole: ResolvedRole;
	readonly mode: RetryExecutionMode;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly sendAttempt: SendProviderAttempt;
	readonly fallbackEnabled?: boolean;
	readonly remainingBuildBudgetMilliseconds?: () => number;
	/** One instance is shared by every request in the Build. */
	readonly providerPauseBudget?: ProviderPauseBudget;
	/** Test-only scale; policy events and counters remain unscaled. */
	readonly timeScale?: number;
	readonly signal?: AbortSignal;
}

interface MutableRunState {
	session: SessionState;
	retryState: RetryState;
	resumed: boolean;
	partialText: string;
	readonly attempts: ProviderAttemptRecord[];
	readonly events: ProviderRetryEvent[];
}

const encoder = new TextEncoder();

/**
 * Run the single provider retry layer for a logical request. The injected
 * attempt port performs auth/HTTP/SSE work; this loop owns retry, wait, switch,
 * and continuation policy and never receives executable calls from a failure.
 */
export async function respondWithRetry(
	input: RespondInput,
): Promise<RespondResult> {
	validateRespondInput(input);
	const pauseBudget = input.providerPauseBudget;
	const timeScale = input.timeScale ?? 1;
	const run: MutableRunState = {
		session: input.session,
		retryState: initialRetryState({
			provider: input.session.provider,
			role: input.resolvedRole.name,
			model: input.session.model,
			effort: input.session.effort,
			overloadFallback: input.resolvedRole.overloadFallback,
			...(input.fallbackEnabled === undefined
				? {}
				: { fallbackEnabled: input.fallbackEnabled }),
			mode: input.mode,
		}),
		resumed: false,
		partialText: "",
		attempts: [],
		events: [],
	};

	while (true) {
		if (input.signal?.aborted) return resultBase(run, "cancelled");
		const remainingBeforeAttempt = remainingBuildBudget(input);
		if (remainingBeforeAttempt === 0)
			return resultBase(run, "budget_exhausted");

		const request = encodeSessionRequest(run.session);
		const attempt = run.retryState.attempts + 1;
		const startedAtUnixMilliseconds = checkedUnixNow(input.clock);
		const startedAtMonotonicMilliseconds = checkedMonotonicNow(input.clock);
		const result = await input.sendAttempt({
			request: copyRequest(request),
			session: run.session,
			attempt,
			...(input.signal === undefined ? {} : { signal: input.signal }),
		});
		const finishedAtMonotonicMilliseconds = checkedMonotonicNow(input.clock);
		const finishedAtUnixMilliseconds = checkedUnixNow(input.clock);
		const elapsedMilliseconds =
			finishedAtMonotonicMilliseconds - startedAtMonotonicMilliseconds;
		if (elapsedMilliseconds < 0)
			throw new RangeError(
				"Monotonic clock moved backwards during a provider attempt.",
			);

		if (result.ok) {
			run.attempts.push({
				attempt,
				model: run.session.model,
				effort: run.session.effort,
				requestSha256: request.bodySha256,
				startedAtUnixMilliseconds,
				finishedAtUnixMilliseconds,
				elapsedMilliseconds,
				resumed: run.resumed,
				result: "completed",
				partialItemCount: 0,
				cutAfterMilliseconds: null,
				usage: result.response.usage,
			});
			const response =
				run.partialText.length === 0
					? result.response
					: Object.freeze({
							...result.response,
							text: run.partialText + result.response.text,
						});
			return {
				...resultBase(run),
				kind: "completed",
				response,
			};
		}

		const partialItems = result.error.partialItemJson ?? [];
		const partialBytes = partialItems.map((item) => encoder.encode(item));
		const usage = result.error.usage ?? null;
		run.attempts.push({
			attempt,
			model: run.session.model,
			effort: run.session.effort,
			requestSha256: request.bodySha256,
			startedAtUnixMilliseconds,
			finishedAtUnixMilliseconds,
			elapsedMilliseconds,
			resumed: run.resumed,
			result: result.error.class,
			partialItemCount: partialItems.length,
			cutAfterMilliseconds:
				result.error.cutAfterMilliseconds === undefined
					? null
					: result.error.cutAfterMilliseconds,
			usage,
		});
		const continueWithPartialItems = shouldContinueWithPartialItems(
			result.error.class,
			partialItems.length > 0,
		);
		if (continueWithPartialItems) {
			run.partialText += extractAssistantText(partialItems);
			run.session = stepSession(run.session, {
				type: "append_turn",
				responseItems: partialBytes,
				userNotes: [STREAM_CONTINUATION_INSTRUCTION],
			});
			run.resumed = true;
		}

		const transition = stepRetry(run.retryState, {
			failureClass: result.error.class,
			remainingBuildBudgetMilliseconds: remainingBuildBudget(input),
			remainingPauseBudgetMilliseconds: pauseBudget?.remainingMilliseconds ?? 0,
			hasPartialItems: partialItems.length > 0,
		});
		run.retryState = transition.state;
		const decision = transition.decision;
		if (decision.kind === "stop")
			return stoppedResult(run, result.error, decision.reason);

		if (decision.kind === "pause") {
			if (pauseBudget === undefined)
				throw new TypeError(
					"Build provider pauses require a shared pause budget.",
				);
			const reservation = pauseBudget.reserve(decision.delayMilliseconds);
			if (reservation === null)
				return stoppedResult(run, result.error, decision.reason);
			run.events.push({
				event: "provider_wait",
				stage: run.session.stage,
				reason: `provider/${decision.reason}`,
				wait_ms: decision.delayMilliseconds,
				budget_paused: true,
			});
			try {
				await sleepScaled(
					input.clock,
					decision.delayMilliseconds,
					timeScale,
					input.signal,
				);
				pauseBudget.complete(reservation);
			} catch (cause) {
				pauseBudget.release(reservation);
				if (input.signal?.aborted) return resultBase(run, "cancelled");
				throw cause;
			}
			continue;
		}

		if (decision.kind === "switch") {
			run.session = stepSession(run.session, {
				type: "model_switch",
				model: decision.to.model,
				effort: decision.to.effort,
			});
			run.events.push({
				event: "provider_retry",
				stage: run.session.stage,
				reason: "provider/overload",
				delay_ms: 0,
			});
			run.events.push({
				event: "provider_switch",
				stage: run.session.stage,
				from_model: `${decision.from.model}/${decision.from.effort}`,
				to_model: `${decision.to.model}/${decision.to.effort}`,
			});
			continue;
		}

		let retryDecision: Extract<RetryDecision, { readonly kind: "retry" }>;
		if (decision.kind === "retry_with_jitter") {
			const delay = await uniformInteger(
				input.random,
				decision.minimumDelayMilliseconds,
				decision.maximumDelayMilliseconds,
			);
			const settled = settleJitteredRetry(
				run.retryState,
				decision,
				delay,
				remainingBuildBudget(input),
			);
			if (settled.kind === "stop")
				return stoppedResult(run, result.error, settled.reason);
			retryDecision = settled;
		} else {
			retryDecision = decision;
		}

		run.events.push({
			event: "provider_retry",
			stage: run.session.stage,
			reason: `provider/${retryDecision.reason}`,
			delay_ms: retryDecision.delayMilliseconds,
		});
		if (retryDecision.delayMilliseconds > 0) {
			try {
				await sleepScaled(
					input.clock,
					retryDecision.delayMilliseconds,
					timeScale,
					input.signal,
				);
			} catch (cause) {
				if (input.signal?.aborted) return resultBase(run, "cancelled");
				throw cause;
			}
		}
	}
}

function validateRespondInput(input: RespondInput): void {
	if (input.resolvedRole.name !== input.session.effectiveRole)
		throw new TypeError("Resolved retry role does not match the session role.");
	if (input.resolvedRole.effective.provider !== input.session.provider)
		throw new TypeError(
			"Resolved retry role does not match the session provider.",
		);
	if (input.mode !== "build" && input.mode !== "shape")
		throw new TypeError("Retry execution mode is invalid.");
	if (input.mode === "build") {
		if (input.remainingBuildBudgetMilliseconds === undefined)
			throw new TypeError("Build retries require a remaining budget reader.");
		if (input.providerPauseBudget === undefined)
			throw new TypeError("Build retries require a shared pause budget.");
	} else if (
		input.remainingBuildBudgetMilliseconds !== undefined ||
		input.providerPauseBudget !== undefined
	) {
		throw new TypeError(
			"Shape retries do not use Build wall or pause budgets.",
		);
	}
	const scale = input.timeScale ?? 1;
	if (!Number.isFinite(scale) || scale <= 0 || scale > 1_000_000)
		throw new RangeError("Retry time scale must be positive and finite.");
}

function remainingBuildBudget(input: RespondInput): number | null {
	if (input.mode === "shape") return null;
	const remaining = input.remainingBuildBudgetMilliseconds?.();
	if (
		!Number.isSafeInteger(remaining) ||
		remaining === undefined ||
		remaining < 0
	)
		throw new RangeError(
			"Remaining Build budget must be a non-negative safe integer.",
		);
	return remaining;
}

function stoppedResult(
	run: MutableRunState,
	error: ProviderAttemptFailure,
	reason: ProviderFailureClass,
): RespondResult {
	return {
		...resultBase(run),
		kind: "stopped",
		status: "stopped",
		exitCode: 4,
		reason: `provider/${reason}`,
		error,
	};
}

function resultBase(run: MutableRunState): RespondResultBase;
function resultBase(
	run: MutableRunState,
	kind: "budget_exhausted",
): Extract<RespondResult, { readonly kind: "budget_exhausted" }>;
function resultBase(
	run: MutableRunState,
	kind: "cancelled",
): Extract<RespondResult, { readonly kind: "cancelled" }>;
function resultBase(
	run: MutableRunState,
	kind?: "budget_exhausted" | "cancelled",
):
	| RespondResultBase
	| Extract<
			RespondResult,
			{ readonly kind: "budget_exhausted" | "cancelled" }
	  > {
	const base: RespondResultBase = {
		session: run.session,
		attempts: Object.freeze([...run.attempts]),
		events: Object.freeze([...run.events]),
		retryState: run.retryState,
	};
	if (kind === "budget_exhausted") return { ...base, kind, status: "budget" };
	if (kind === "cancelled") return { ...base, kind, status: "cancelled" };
	return base;
}

function copyRequest(request: EncodedSessionRequest): EncodedSessionRequest {
	return Object.freeze({
		...request,
		body: request.body.slice(),
		headers: Object.freeze({ ...request.headers }),
		headerNames: Object.freeze([...request.headerNames]),
		inputItems: Object.freeze(request.inputItems.map((item) => item.slice())),
	});
}

function extractAssistantText(items: readonly string[]): string {
	const textParts: string[] = [];
	for (const source of items) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(source) as unknown;
		} catch (cause) {
			throw new TypeError("Partial provider item is not valid JSON.", {
				cause,
			});
		}
		if (
			!isRecord(parsed) ||
			parsed.type !== "message" ||
			!Array.isArray(parsed.content)
		)
			continue;
		for (const part of parsed.content) {
			if (
				isRecord(part) &&
				part.type === "output_text" &&
				typeof part.text === "string"
			)
				textParts.push(part.text);
		}
	}
	return textParts.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function uniformInteger(
	random: RandomPort,
	minimum: number,
	maximum: number,
): Promise<number> {
	const span = maximum - minimum + 1;
	if (
		!Number.isSafeInteger(minimum) ||
		!Number.isSafeInteger(maximum) ||
		minimum < 0 ||
		maximum < minimum ||
		span > 0x1_0000_0000
	)
		throw new RangeError("Random retry interval is invalid.");
	const range = 0x1_0000_0000;
	const acceptedBelow = Math.floor(range / span) * span;
	for (let draw = 0; draw < 128; draw += 1) {
		const result = await random.bytes(4);
		if (!result.ok)
			throw new Error(
				`Provider retry randomness failed: ${result.error.message}`,
			);
		if (result.value.byteLength !== 4)
			throw new Error("Random port returned the wrong number of retry bytes.");
		const value =
			(result.value[0] ?? 0) * 0x1_000000 +
			(result.value[1] ?? 0) * 0x1_0000 +
			(result.value[2] ?? 0) * 0x100 +
			(result.value[3] ?? 0);
		if (value < acceptedBelow) return minimum + (value % span);
	}
	throw new Error("Random port repeatedly returned out-of-range retry bytes.");
}

async function sleepScaled(
	clock: ClockPort,
	delayMilliseconds: number,
	timeScale: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw signal.reason;
	const scaled = Math.max(1, Math.floor(delayMilliseconds * timeScale));
	await clock.sleep(scaled, signal);
}

function checkedMonotonicNow(clock: ClockPort): number {
	const value = clock.monotonicMilliseconds();
	if (!Number.isFinite(value) || value < 0)
		throw new RangeError("Monotonic clock returned an invalid value.");
	return value;
}

function checkedUnixNow(clock: ClockPort): number {
	const value = clock.unixMilliseconds();
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError("Clock returned an invalid Unix timestamp.");
	return value;
}
