import type { ClockPort } from "../../../core/src/contracts/clock";
import type { RandomPort } from "../../../core/src/contracts/ports";
import {
	type ModelProvider,
	type ModelRole,
	type ResolvedRole,
	resolveRoles,
} from "../../../core/src/project/roles";
import {
	initialRetryState,
	type ProviderFailureClass,
	ProviderPauseBudget,
	RETRY_POLICY,
	type RetryExecutionMode,
	type RetryState,
	settleJitteredRetry,
	shouldContinueWithPartialItems,
	stepRetry,
} from "../../../core/src/provider/retry/transition";
import {
	responseItemBytes,
	userMessageBytes,
} from "../../../core/src/provider/session/history";
import {
	createSession,
	type SessionState,
	stepSession,
} from "../../../core/src/provider/session/transition";
import {
	type EncodedSessionRequest,
	encodeSessionRequest,
} from "../../../core/src/provider/session/wire";
import { decodeSliceEvent, type XspecSlice } from "../protocol";

const PAUSE_LIMIT = RETRY_POLICY.maximumBuildPauseMilliseconds;
const ALLOWED_WAITS = new Set([0, 300_000, 86_100_000, 86_400_000]);
const MODEL_NAMES = {
	luna: { provider: "chatgpt", model: "gpt-6-luna", effort: "max" },
	sol: { provider: "chatgpt", model: "gpt-6.1-sol", effort: "medium" },
	grok: { provider: "grok", model: "grok-4.6", effort: "high" },
} as const satisfies Record<
	string,
	{
		readonly provider: ModelProvider;
		readonly model: string;
		readonly effort: string;
	}
>;

type ModelName = keyof typeof MODEL_NAMES;

interface StreamObservation {
	phase: string;
	mode: string;
	role: string;
	model: string;
	fallbackOn: boolean;
	refreshable: boolean;
	bounded: boolean;
	wall: number;
	attempt: number;
	overloads: number;
	refreshed: boolean;
	waited: number;
	decision: string;
	delay: number;
	reason: string;
	continued: boolean;
	queued: boolean;
	exit: number;
	checkpoint: string;
	continuations: number;
	last: string;
	failed: boolean;
}

class FakeClock implements ClockPort {
	private monotonic = 0;
	readonly sleeps: number[] = [];

	monotonicMilliseconds(): number {
		return this.monotonic;
	}

	unixMilliseconds(): number {
		return 1_800_000_000_000 + this.monotonic;
	}

	async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason;
		if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
			throw new RangeError("Fake clock received an invalid delay.");
		this.sleeps.push(milliseconds);
		this.monotonic += milliseconds;
	}
}

class MaximumJitter implements RandomPort {
	private range = 1;

	setRange(minimum: number, maximum: number): void {
		this.range = maximum - minimum + 1;
	}

	async bytes(length: number) {
		if (length !== 4) throw new RangeError("Retry jitter requests four bytes.");
		const acceptedBelow = Math.floor(0x1_0000_0000 / this.range) * this.range;
		const raw = acceptedBelow - 1;
		const bytes = new Uint8Array([
			(raw >>> 24) & 0xff,
			(raw >>> 16) & 0xff,
			(raw >>> 8) & 0xff,
			raw & 0xff,
		]);
		return { ok: true as const, value: bytes };
	}
}

interface StreamRuntime {
	readonly clock: FakeClock;
	readonly random: MaximumJitter;
	pauseBudget: ProviderPauseBudget;
	readonly observation: StreamObservation;
	retryState: RetryState | null;
	session: SessionState | null;
	lastRequest: EncodedSessionRequest | null;
}

function initialObservation(): StreamObservation {
	return {
		phase: "idle",
		mode: "",
		role: "",
		model: "",
		fallbackOn: false,
		refreshable: true,
		bounded: false,
		wall: 0,
		attempt: 0,
		overloads: 0,
		refreshed: false,
		waited: 0,
		decision: "",
		delay: 0,
		reason: "",
		continued: false,
		queued: false,
		exit: 0,
		checkpoint: "",
		continuations: 0,
		last: "ok",
		failed: false,
	};
}

function freshRuntime(): StreamRuntime {
	const observation = initialObservation();
	return {
		clock: new FakeClock(),
		random: new MaximumJitter(),
		pauseBudget: new ProviderPauseBudget(PAUSE_LIMIT),
		observation,
		retryState: null,
		session: null,
		lastRequest: null,
	};
}

function string(value: Record<string, unknown>, key: string): string | null {
	return typeof value[key] === "string" ? (value[key] as string) : null;
}

function bool(value: Record<string, unknown>, key: string): boolean | null {
	return typeof value[key] === "boolean" ? (value[key] as boolean) : null;
}

function safeInteger(
	value: Record<string, unknown>,
	key: string,
): number | null {
	const candidate = value[key];
	return typeof candidate === "number" && Number.isSafeInteger(candidate)
		? candidate
		: null;
}

function modelName(value: string): ModelName | null {
	return Object.hasOwn(MODEL_NAMES, value) ? (value as ModelName) : null;
}

function aliasForModel(model: string): string {
	for (const [name, reference] of Object.entries(MODEL_NAMES))
		if (reference.model === model) return name;
	return model;
}

function sessionForOpen(
	role: ModelRole,
	model: ModelName,
	fallbackOn: boolean,
	mode: RetryExecutionMode,
): {
	readonly session: SessionState;
	readonly resolvedRole: ResolvedRole;
} {
	const reference = MODEL_NAMES[model];
	const effort = reference.effort;
	const resolution = resolveRoles({
		provider: reference.provider,
		project: new Map([[role, { model: reference.model, effort }]]),
		modelFallback: fallbackOn,
	});
	if (!resolution.ok)
		throw new TypeError("Xspec stream role resolution failed.");
	const resolvedRole = resolution.value.roles[role];
	const initialReasoning = responseItemBytes({
		type: "reasoning",
		encrypted_content: `fixture-reasoning:${reference.model}`,
	});
	const session = createSession({
		runDirectory: "/tmp/kogen-xspec-stream/run-1",
		provider: reference.provider,
		authMode: "injected",
		role,
		model: reference.model,
		effort,
		stage: mode === "shape" ? "shape" : role === "planner" ? "plan" : "develop",
		roleInstructions: `You are Kogen's ${role}.`,
		genericInstructions: "Use the frozen Kogen provider request protocol.",
		toolSchemas: [],
		toolSchemaVersion: "xspec-stream-tools-v1",
		promptVersion: "xspec-stream-prompt-v1",
		adapterVersion: "responses-v1",
		roleToolAuthorization: {
			builder: [],
			planner: [],
			shaper: [],
			auditor: [],
			reviewer: [],
			context: [],
		},
		initialItems: [
			{ bytes: userMessageBytes("approved task"), kind: "message" },
			{
				bytes: initialReasoning,
				kind: "reasoning",
				model: reference.model,
				encrypted: true,
			},
		],
	});
	return { session, resolvedRole };
}

function eventObject(
	value: unknown,
	tag: string,
	fields: readonly string[],
): Record<string, unknown> | null {
	const decoded = decodeSliceEvent(value);
	if (decoded.tag !== tag || decoded.value === undefined) return null;
	if (
		Object.keys(decoded.value).length !== fields.length ||
		fields.some((field) => !Object.hasOwn(decoded.value ?? {}, field))
	)
		return null;
	return decoded.value;
}

function requiredOpen(value: unknown): {
	role: ModelRole;
	model: ModelName;
	fallbackOn: boolean;
	refreshable: boolean;
	bounded: boolean;
	wall: number;
	mode: RetryExecutionMode;
} | null {
	const object = eventObject(value, "Open", [
		"role",
		"model",
		"fallbackOn",
		"refreshable",
		"bounded",
		"wall",
		"mode",
	]);
	if (object === null) return null;
	const role = string(object, "role");
	const model = string(object, "model");
	const fallbackOn = bool(object, "fallbackOn");
	const refreshable = bool(object, "refreshable");
	const bounded = bool(object, "bounded");
	const wall = safeInteger(object, "wall");
	const mode = string(object, "mode");
	if (
		(role !== "builder" && role !== "planner") ||
		model === null ||
		modelName(model) === null ||
		fallbackOn === null ||
		refreshable === null ||
		bounded === null ||
		wall === null ||
		wall < 0 ||
		(mode !== "build" && mode !== "shape")
	)
		return null;
	return {
		role,
		model: modelName(model) as ModelName,
		fallbackOn,
		refreshable,
		bounded,
		wall,
		mode,
	};
}

function resetOpenFields(state: StreamObservation): void {
	state.decision = "";
	state.delay = 0;
	state.reason = "";
	state.continued = false;
	state.checkpoint = "";
	state.exit = 0;
	state.last = "ok";
	state.failed = false;
}

function open(runtime: StreamRuntime, value: unknown): void {
	const state = runtime.observation;
	if (state.phase === "open") {
		state.last = "bad_open";
		return;
	}
	const input = requiredOpen(value);
	if (input === null) {
		state.last = "bad_open";
		return;
	}
	const fallbackOn = input.fallbackOn && input.model !== "grok";
	const { session, resolvedRole } = sessionForOpen(
		input.role,
		input.model,
		fallbackOn,
		input.mode,
	);
	runtime.session = session;
	runtime.retryState = initialRetryState({
		provider: session.provider,
		role: input.role,
		model: session.model,
		effort: session.effort,
		overloadFallback: resolvedRole.overloadFallback,
		fallbackEnabled: fallbackOn,
		mode: input.mode,
	});
	runtime.pauseBudget = new ProviderPauseBudget();
	runtime.lastRequest = null;
	state.phase = "open";
	state.mode = input.mode;
	state.role = input.role;
	state.model = input.model;
	state.fallbackOn = fallbackOn;
	state.refreshable = input.refreshable;
	state.bounded = input.bounded;
	state.wall = input.wall;
	state.attempt = 1;
	state.overloads = 0;
	state.refreshed = false;
	state.queued = true;
	resetOpenFields(state);
}

function failureClass(
	kind: string,
	hasItems: boolean,
): ProviderFailureClass | null {
	if (kind === "first_byte" || kind === "total") return "timeout";
	if (kind === "cut") return hasItems ? "malformed" : "transport";
	if (
		kind === "login" ||
		kind === "usage_limit" ||
		kind === "overload" ||
		kind === "timeout" ||
		kind === "stall" ||
		kind === "malformed" ||
		kind === "transport" ||
		kind === "incomplete" ||
		kind === "unsupported"
	)
		return kind;
	return null;
}

const PARTIAL_ITEM = responseItemBytes({
	type: "message",
	role: "assistant",
	content: [{ type: "output_text", text: "received progress" }],
});

function stop(
	runtime: StreamRuntime,
	reason: ProviderFailureClass,
	code = 4,
): void {
	const state = runtime.observation;
	state.phase = "stopped";
	state.decision = "stop";
	state.delay = 0;
	state.reason = `provider/${reason}`;
	state.continued = false;
	state.exit = code;
	state.queued = true;
	state.last = "ok";
}

async function result(runtime: StreamRuntime, value: unknown): Promise<void> {
	const state = runtime.observation;
	if (
		state.phase !== "open" ||
		runtime.retryState === null ||
		runtime.session === null
	) {
		state.last = "not_open";
		return;
	}
	const object = eventObject(value, "Result", ["kind", "items"]);
	if (
		object === null ||
		typeof object.kind !== "string" ||
		typeof object.items !== "boolean"
	) {
		state.last = "bad_result";
		return;
	}
	const kind = object.kind;
	const hasItems = object.items;
	runtime.lastRequest = encodeSessionRequest(runtime.session);
	if (kind === "ok") {
		state.phase = "idle";
		state.decision = "success";
		state.delay = 0;
		state.reason = "";
		state.continued = false;
		state.exit = 0;
		state.last = "ok";
		return;
	}
	if (kind === "login" && state.refreshable && !state.refreshed) {
		// The fake attempt outcome grants one auth refresh. The request runner owns
		// refreshability; Retry.step owns later pause/retry decisions.
		state.refreshed = true;
		state.decision = "refresh";
		state.delay = 0;
		state.reason = "provider/login";
		state.continued = false;
		state.phase = "open";
		state.exit = 0;
		state.last = "ok";
		return;
	}
	const reason = failureClass(kind, hasItems);
	if (reason === null) {
		state.last = "bad_result";
		return;
	}
	const remainingBuildBudget =
		state.mode === "shape"
			? null
			: state.bounded
				? state.wall
				: Number.MAX_SAFE_INTEGER;
	const transition = stepRetry(runtime.retryState, {
		failureClass: reason,
		remainingBuildBudgetMilliseconds: remainingBuildBudget,
		remainingPauseBudgetMilliseconds:
			kind === "login" && !state.refreshable
				? 0
				: Math.min(
						runtime.pauseBudget.remainingMilliseconds,
						PAUSE_LIMIT - state.waited,
					),
		hasPartialItems: hasItems,
	});
	runtime.retryState = transition.state;
	state.overloads = transition.state.consecutiveOverloads;
	const continuePartial = shouldContinueWithPartialItems(reason, hasItems);
	if (transition.decision.kind === "pause") {
		const reservation = runtime.pauseBudget.reserve(
			transition.decision.delayMilliseconds,
		);
		if (reservation === null) {
			stop(runtime, reason);
			return;
		}
		await runtime.clock.sleep(transition.decision.delayMilliseconds);
		runtime.pauseBudget.complete(reservation);
		state.phase = "idle";
		state.decision = "pause";
		state.delay = transition.decision.delayMilliseconds;
		state.reason = `provider/${transition.decision.reason}`;
		state.continued = false;
		state.waited += transition.decision.delayMilliseconds;
		state.exit = 0;
		state.last = "ok";
		return;
	}
	if (transition.decision.kind === "stop") {
		stop(runtime, transition.decision.reason);
		return;
	}
	if (transition.decision.kind === "switch") {
		runtime.session = stepSession(runtime.session, {
			type: "model_switch",
			model: transition.decision.to.model,
			effort: transition.decision.to.effort,
		});
		state.model = aliasForModel(runtime.session.model);
		state.phase = "open";
		state.attempt = transition.state.attempts + 1;
		state.decision = "switch";
		state.delay = 0;
		state.reason = "provider/overload";
		state.continued = false;
		state.exit = 0;
		state.last = "ok";
		return;
	}
	if (transition.decision.kind !== "retry_with_jitter")
		throw new TypeError("Retry transition returned an unsupported decision.");
	const delay = await maximumJitter(
		runtime.random,
		transition.decision.minimumDelayMilliseconds,
		transition.decision.maximumDelayMilliseconds,
	);
	const settled = settleJitteredRetry(
		transition.state,
		transition.decision,
		delay,
		remainingBuildBudget,
	);
	if (settled.kind === "stop") {
		stop(runtime, settled.reason);
		return;
	}
	if (continuePartial && hasItems) {
		runtime.session = stepSession(runtime.session, {
			type: "append_turn",
			responseItems: [PARTIAL_ITEM],
			userNotes: [
				"The response stream was interrupted. Continue the same turn from the received progress above. Preserve its findings and constraints; do not restart the task or repeat completed work. Proposed tool calls above were not executed; reissue any still needed.",
			],
		});
		state.continued = true;
	} else {
		state.continued = false;
	}
	await runtime.clock.sleep(settled.delayMilliseconds);
	state.phase = "open";
	state.attempt = transition.state.attempts + 1;
	state.decision = "retry";
	state.delay = settled.delayMilliseconds;
	state.reason = `provider/${settled.reason}`;
	state.exit = 0;
	state.last = "ok";
}

function checkpoint(runtime: StreamRuntime, value: unknown): void {
	const state = runtime.observation;
	if (state.phase !== "open" || runtime.session === null) {
		state.last = "not_open";
		return;
	}
	const object = eventObject(value, "Checkpoint", ["kind"]);
	const kind = object === null ? null : string(object, "kind");
	if (kind === "valid") {
		const marker = responseItemBytes({
			role: "user",
			content: [
				{
					type: "input_text",
					text: 'Continuation of the same approved Build.\n\n{"obligations":"keep","findings":"found","investigation":"looked","ruled_out":"no","next_steps":"finish"}',
				},
			],
		});
		try {
			runtime.session = stepSession(runtime.session, {
				type: "accept_checkpoint",
				turn: state.continuations,
				item: { bytes: marker, kind: "user_note" },
			});
			state.phase = "idle";
			state.decision = "checkpoint";
			state.checkpoint = "accepted";
			state.continuations += 1;
			state.delay = 0;
			state.reason = "";
			state.continued = false;
			state.exit = 0;
			state.last = "ok";
		} catch {
			state.last = "bad_checkpoint";
		}
		return;
	}
	if (kind === "invalid" || kind === "oversized") {
		state.phase = "stopped";
		state.decision = "stop";
		state.reason = "continuation_failed";
		state.checkpoint = "failed";
		state.delay = 0;
		state.continued = false;
		state.exit = 1;
		state.queued = true;
		state.last = "ok";
		return;
	}
	state.last = "bad_checkpoint";
}

function applySetWaited(runtime: StreamRuntime, value: unknown): void {
	const state = runtime.observation;
	const object = eventObject(value, "SetWaited", ["ms"]);
	const milliseconds = object === null ? null : safeInteger(object, "ms");
	if (milliseconds === null || !ALLOWED_WAITS.has(milliseconds)) {
		state.last = "bad_wait";
		return;
	}
	state.waited = milliseconds;
	runtime.pauseBudget = new ProviderPauseBudget();
	state.last = "ok";
}

function observation(runtime: StreamRuntime): StreamObservation {
	return { ...runtime.observation };
}

export function createStreamSlice(): XspecSlice {
	let runtime = freshRuntime();
	return {
		async reset() {
			runtime = freshRuntime();
			return observation(runtime);
		},
		async apply(event: unknown) {
			const decoded = decodeSliceEvent(event);
			switch (decoded.tag) {
				case "Init":
					runtime = freshRuntime();
					break;
				case "Open":
					open(runtime, event);
					break;
				case "Result":
					await result(runtime, event);
					break;
				case "Checkpoint":
					checkpoint(runtime, event);
					break;
				case "SetWaited":
					applySetWaited(runtime, event);
					break;
				default:
					runtime.observation.last = "bad_event";
			}
			return observation(runtime);
		},
	};
}

async function maximumJitter(
	random: MaximumJitter,
	minimum: number,
	maximum: number,
): Promise<number> {
	random.setRange(minimum, maximum);
	const result = await random.bytes(4);
	if (!result.ok) throw new Error("Fake jitter source failed.");
	const value =
		(result.value[0] ?? 0) * 0x1_000000 +
		(result.value[1] ?? 0) * 0x1_0000 +
		(result.value[2] ?? 0) * 0x100 +
		(result.value[3] ?? 0);
	return minimum + (value % (maximum - minimum + 1));
}

export const STREAM_RETRY_POLICY_VERSION = RETRY_POLICY.version;
