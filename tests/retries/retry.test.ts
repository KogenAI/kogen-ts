import { expect, test } from "bun:test";
import type { ClockPort } from "../../packages/core/src/contracts/clock";
import type { RandomPort } from "../../packages/core/src/contracts/ports";
import type {
	ModelProvider,
	ModelRole,
} from "../../packages/core/src/project/roles";
import { resolveRoles } from "../../packages/core/src/project/roles";
import {
	type ProviderAttemptResult,
	type RespondInput,
	respondWithRetry,
	STREAM_CONTINUATION_INSTRUCTION,
} from "../../packages/core/src/provider/retry/respond";
import {
	initialRetryState,
	ProviderPauseBudget,
	RETRY_POLICY,
	settleJitteredRetry,
	stepRetry,
} from "../../packages/core/src/provider/retry/transition";
import { userMessageBytes } from "../../packages/core/src/provider/session/history";
import {
	type CanonicalToolSchema,
	StaticPrefixRegistry,
} from "../../packages/core/src/provider/session/prefix";
import { createSession } from "../../packages/core/src/provider/session/transition";
import { hasAppendedInputPrefix } from "../../packages/core/src/provider/session/wire";
import type { AssembledResponse } from "../../packages/core/src/provider/sse/assemble";

class AdvancingClock implements ClockPort {
	now = 0;
	readonly sleeps: number[] = [];

	monotonicMilliseconds(): number {
		return this.now;
	}

	unixMilliseconds(): number {
		return 1_800_000_000_000 + this.now;
	}

	async sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw signal.reason;
		this.sleeps.push(milliseconds);
		this.now += milliseconds;
	}
}

class FixedRandom implements RandomPort {
	readonly draws: number[] = [];
	private readonly values: number[];

	constructor(values: readonly number[] = [0]) {
		this.values = [...values];
	}

	async bytes(length: number) {
		const value = this.values.shift() ?? 0;
		this.draws.push(value);
		const result = new Uint8Array(length);
		result[0] = Math.floor(value / 0x1_000000);
		result[1] = Math.floor(value / 0x1_0000) & 0xff;
		result[2] = Math.floor(value / 0x100) & 0xff;
		result[3] = value & 0xff;
		return { ok: true as const, value: result };
	}
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const schemas = [
	{
		type: "function",
		name: "shell",
		description: "Run a bounded shell command.",
		parameters: {
			type: "object",
			properties: { cmd: { type: "string" } },
			required: ["cmd"],
			additionalProperties: false,
		},
		strict: false,
	},
] as const satisfies readonly CanonicalToolSchema[];

const authorization = {
	builder: ["shell"],
	planner: [],
	shaper: ["shell"],
	auditor: [],
	reviewer: [],
	context: [],
} as const;

function resolvedRole(provider: ModelProvider, role: ModelRole) {
	const result = resolveRoles({ provider });
	if (!result.ok) throw new Error("Default roles should resolve.");
	return result.value.roles[role];
}

function sessionFor(
	role: ModelRole,
	provider: ModelProvider = "chatgpt",
	initialItems = [
		{ bytes: userMessageBytes("approved task"), kind: "message" as const },
	],
) {
	const resolved = resolvedRole(provider, role);
	return {
		resolved,
		session: createSession({
			runDirectory: `/tmp/kogen-retry/${provider}-${role}`,
			provider,
			authMode: "injected",
			role,
			model: resolved.effective.model,
			effort: resolved.effective.effort,
			stage: role === "planner" ? "plan" : role,
			roleInstructions: `You are Kogen's ${role}.`,
			genericInstructions: "Use the canonical Kogen request protocol.",
			toolSchemas: schemas,
			toolSchemaVersion: "tools-v1",
			promptVersion: "prompt-v1",
			adapterVersion: "responses-v1",
			roleToolAuthorization: authorization,
			initialItems,
			prefixRegistry: new StaticPrefixRegistry(),
		}),
	};
}

function success(
	text: string,
	toolCalls: AssembledResponse["tool_calls"] = [],
): ProviderAttemptResult {
	return {
		ok: true,
		response: {
			ok: true,
			id: "resp_done",
			text,
			tool_calls: toolCalls,
			usage: null,
			raw_items: [],
			raw_item_json: [],
		},
	};
}

function failure(
	classification:
		| "login"
		| "usage_limit"
		| "overload"
		| "timeout"
		| "stall"
		| "malformed"
		| "transport"
		| "incomplete"
		| "unsupported",
	partialItemJson?: readonly string[],
	options: { readonly retryAfterMilliseconds?: number } = {},
): ProviderAttemptResult {
	return {
		ok: false,
		error: {
			class: classification,
			message: `scripted ${classification}`,
			...(partialItemJson === undefined ? {} : { partialItemJson }),
			...options,
		},
	};
}

function respondInput(
	role: ModelRole,
	session: ReturnType<typeof sessionFor>,
	clock: AdvancingClock,
	random: FixedRandom,
	sendAttempt: RespondInput["sendAttempt"],
	mode: "build" | "shape" = "build",
	remainingBuildBudgetMilliseconds: () => number = () => 100_000,
	providerPauseBudget = new ProviderPauseBudget(),
	options: Pick<RespondInput, "fallbackEnabled" | "timeScale"> = {},
): RespondInput {
	if (session.resolved.name !== role)
		throw new TypeError("Retry test role does not match its session.");
	return mode === "build"
		? {
				session: session.session,
				resolvedRole: session.resolved,
				mode,
				clock,
				random,
				sendAttempt,
				remainingBuildBudgetMilliseconds,
				providerPauseBudget,
				...options,
			}
		: {
				session: session.session,
				resolvedRole: session.resolved,
				mode,
				clock,
				random,
				sendAttempt,
				...options,
			};
}

test("one frozen retry table holds the version, jitter ceilings, caps, and pause limits", () => {
	expect(RETRY_POLICY).toEqual({
		version: "responses-v1.2",
		attemptCap: 4,
		backoffCeilingsMilliseconds: [2_000, 4_000, 8_000, 16_000, 32_000, 60_000],
		switchAfterConsecutiveOverloads: 2,
		buildPauseMilliseconds: 300_000,
		maximumBuildPauseMilliseconds: 86_400_000,
	});
	expect(Object.isFrozen(RETRY_POLICY)).toBe(true);
	expect(Object.isFrozen(RETRY_POLICY.backoffCeilingsMilliseconds)).toBe(true);
});

test("retry jitter is inclusive and a delay that cannot fit stops without another request", () => {
	const state = initialRetryState({
		provider: "chatgpt",
		role: "planner",
		model: "gpt-6.1-sol",
		effort: "high",
		overloadFallback: null,
		mode: "build",
	});
	const next = stepRetry(state, {
		failureClass: "timeout",
		remainingBuildBudgetMilliseconds: 2_000,
		remainingPauseBudgetMilliseconds: 86_400_000,
		hasPartialItems: false,
	});
	expect(next.decision).toEqual({
		kind: "retry_with_jitter",
		reason: "timeout",
		minimumDelayMilliseconds: 1_000,
		maximumDelayMilliseconds: 2_000,
		continueWithPartialItems: false,
	});
	if (next.decision.kind !== "retry_with_jitter") return;
	expect(settleJitteredRetry(next.state, next.decision, 2_000, 2_000)).toEqual({
		kind: "retry",
		reason: "timeout",
		delayMilliseconds: 2_000,
		continueWithPartialItems: false,
	});
	expect(settleJitteredRetry(next.state, next.decision, 2_000, 1_999)).toEqual({
		kind: "stop",
		reason: "timeout",
		attempts: 1,
	});
});

test("two consecutive ChatGPT builder overloads switch immediately to the resolved fallback", async () => {
	const fixture = sessionFor("builder");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const models: string[] = [];
	let index = 0;
	const script = [
		failure("overload"),
		failure("overload"),
		success("complete"),
	];
	const result = await respondWithRetry(
		respondInput("builder", fixture, clock, random, async (attempt) => {
			models.push(attempt.session.model);
			return script[index++] ?? success("unexpected");
		}),
	);
	expect(result.kind).toBe("completed");
	expect(models).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6.1-sol"]);
	expect(result.events).toEqual([
		{
			event: "provider_retry",
			stage: "builder",
			reason: "provider/overload",
			delay_ms: 1_000,
		},
		{
			event: "provider_retry",
			stage: "builder",
			reason: "provider/overload",
			delay_ms: 0,
		},
		{
			event: "provider_switch",
			stage: "builder",
			from_model: "gpt-6-luna/max",
			to_model: "gpt-6.1-sol/medium",
		},
	]);
	expect(clock.sleeps).toEqual([1_000]);
	expect(result.session.threadId).toBe(fixture.session.threadId);
	if (result.kind === "completed") {
		expect(result.response.text).toBe("complete");
		expect(result.session.model).toBe("gpt-6.1-sol");
	}
});

test("disabling Build fallback retries an eligible overload as long as budget allows", async () => {
	const fixture = sessionFor("builder");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	let attempts = 0;
	const result = await respondWithRetry({
		...respondInput(
			"builder",
			fixture,
			clock,
			random,
			async () => {
				attempts += 1;
				return attempts === 6 ? success("recovered") : failure("overload");
			},
			"build",
			() => 100_000,
			new ProviderPauseBudget(),
			{ fallbackEnabled: false },
		),
		resolvedRole: { ...fixture.resolved, overloadFallback: null },
		fallbackEnabled: false,
	});

	expect(result.kind).toBe("completed");
	expect(attempts).toBe(6);
	expect(result.session.model).toBe("gpt-6-luna");
	expect(
		result.events.filter((event) => event.event === "provider_switch"),
	).toEqual([]);
	expect(clock.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("planner overloads never switch and stop after four request attempts", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const models: string[] = [];
	const result = await respondWithRetry(
		respondInput("planner", fixture, clock, random, async (attempt) => {
			models.push(attempt.session.model);
			return failure("overload");
		}),
	);

	expect(result.kind).toBe("stopped");
	if (result.kind === "stopped")
		expect(result.reason).toBe("provider/overload");
	expect(models).toEqual(Array(4).fill("gpt-6.1-sol"));
	expect(result.events).toHaveLength(3);
	expect(
		result.events.filter((event) => event.event === "provider_switch"),
	).toEqual([]);
	expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
});

test("a non-overload failure resets the overload streak before any later switch", async () => {
	const fixture = sessionFor("builder");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const models: string[] = [];
	const script = [
		failure("overload"),
		failure("malformed"),
		failure("overload"),
		success("same model"),
	];
	let index = 0;
	const result = await respondWithRetry(
		respondInput("builder", fixture, clock, random, async (attempt) => {
			models.push(attempt.session.model);
			return script[index++] ?? success("unexpected");
		}),
	);

	expect(result.kind).toBe("completed");
	expect(models).toEqual(Array(4).fill("gpt-6-luna"));
	expect(
		result.events.filter((event) => event.event === "provider_switch"),
	).toEqual([]);
});

test("Grok has no overload model switch and invalid fallback wiring is rejected", async () => {
	const fixture = sessionFor("builder", "grok");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const models: string[] = [];
	let index = 0;
	const result = await respondWithRetry(
		respondInput("builder", fixture, clock, random, async (attempt) => {
			models.push(attempt.session.model);
			index += 1;
			return index === 3 ? success("Grok stays here") : failure("overload");
		}),
	);

	expect(result.kind).toBe("completed");
	expect(models).toEqual(["grok-4.6", "grok-4.6", "grok-4.6"]);
	expect(
		result.events.filter((event) => event.event === "provider_switch"),
	).toEqual([]);
	expect(() =>
		initialRetryState({
			provider: "chatgpt",
			role: "planner",
			model: "gpt-6.1-sol",
			effort: "high",
			overloadFallback: {
				provider: "chatgpt",
				model: "gpt-6.1-sol",
				effort: "medium",
			},
			mode: "build",
		}),
	).toThrow("planner has no overload fallback");
	expect(() =>
		initialRetryState({
			provider: "grok",
			role: "builder",
			model: "grok-4.6",
			effort: "high",
			overloadFallback: {
				provider: "chatgpt",
				model: "gpt-6.1-sol",
				effort: "medium",
			},
			mode: "build",
		}),
	).toThrow("Grok does not have an overload model switch");
});

test("Build transport retries exceed four attempts only while the wall budget can pay", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput("planner", fixture, clock, random, async () => {
			attempts += 1;
			return attempts === 6 ? success("recovered") : failure("transport");
		}),
	);

	expect(result.kind).toBe("completed");
	expect(attempts).toBe(6);
	expect(clock.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("Shape has no wall budget and caps every transient logical request at four attempts", async () => {
	const fixture = sessionFor("shaper");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput(
			"shaper",
			fixture,
			clock,
			random,
			async () => {
				attempts += 1;
				return failure("stall");
			},
			"shape",
		),
	);

	expect(result.kind).toBe("stopped");
	if (result.kind === "stopped") expect(result.reason).toBe("provider/stall");
	expect(attempts).toBe(4);
	expect(clock.sleeps).toEqual([1_000, 2_000, 4_000]);
});

test("Build pauses for 5 minutes regardless of a shorter Retry-After and keeps budget paused", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom();
	const pauseBudget = new ProviderPauseBudget();
	const bodies: Uint8Array[] = [];
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput(
			"planner",
			fixture,
			clock,
			random,
			async (attempt) => {
				bodies.push(attempt.request.body.slice());
				attempts += 1;
				return attempts === 1
					? failure("usage_limit", undefined, {
							retryAfterMilliseconds: 30_000,
						})
					: success("continued after pause");
			},
			"build",
			() => 50_000,
			pauseBudget,
			{ timeScale: 0.02 },
		),
	);

	expect(result.kind).toBe("completed");
	expect(bodies[0]).toEqual(bodies[1]);
	expect(clock.sleeps).toEqual([6_000]);
	expect(pauseBudget.usedMilliseconds).toBe(300_000);
	expect(result.events).toEqual([
		{
			event: "provider_wait",
			stage: "plan",
			reason: "provider/usage_limit",
			wait_ms: 300_000,
			budget_paused: true,
		},
	]);
});

test("Build stops when the shared login and usage pause allowance reaches 24 hours", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom();
	const pauseBudget = new ProviderPauseBudget();
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput(
			"planner",
			fixture,
			clock,
			random,
			async () => {
				attempts += 1;
				return failure("login");
			},
			"build",
			() => 100_000,
			pauseBudget,
			{ timeScale: 0.001 },
		),
	);

	expect(result.kind).toBe("stopped");
	if (result.kind === "stopped") expect(result.reason).toBe("provider/login");
	expect(attempts).toBe(289);
	expect(pauseBudget.usedMilliseconds).toBe(86_400_000);
	expect(
		result.events.filter((event) => event.event === "provider_wait"),
	).toHaveLength(288);
});

test("partial stream progress is appended before the continuation request and text is retained", async () => {
	const fixture = sessionFor("builder");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const bodies: Uint8Array[] = [];
	const partialItems = [
		'{ "id" : "msg_partial", "type" : "message", "role" : "assistant", "content" : [{"type":"output_text","text":"partial progress"}] }',
		'{"id":"fc_partial","type":"function_call","call_id":"call_partial","name":"shell","arguments":"{\\"cmd\\":\\"do not run\\"}","status":"completed"}',
	];
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput("builder", fixture, clock, random, async (attempt) => {
			bodies.push(attempt.request.body.slice());
			attempts += 1;
			return attempts === 1
				? failure("transport", partialItems)
				: success(" and then finished");
		}),
	);

	expect(result.kind).toBe("completed");
	expect(bodies).toHaveLength(2);
	expect(
		hasAppendedInputPrefix(
			bodies[0] ?? new Uint8Array(),
			bodies[1] ?? new Uint8Array(),
		),
	).toBe(true);
	const continuedBodyText = decoder.decode(bodies[1] ?? new Uint8Array());
	const continuedBody = JSON.parse(
		decoder.decode(bodies[1] ?? new Uint8Array()),
	) as {
		input: readonly unknown[];
	};
	expect(continuedBodyText).toContain(partialItems[0] ?? "missing raw item");
	expect(continuedBodyText).toContain(partialItems[1] ?? "missing call item");
	expect(JSON.stringify(continuedBody.input)).toContain(
		STREAM_CONTINUATION_INSTRUCTION,
	);
	expect(
		result.session.history.itemBytes().map((item) => decoder.decode(item)),
	).toContain(partialItems[1] ?? "missing call item");
	if (result.kind === "completed")
		expect(result.response.text).toBe("partial progress and then finished");
	expect(result.attempts[1]?.resumed).toBe(true);
});

test("identical retries resend byte-identical bodies when no partial items arrived", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const bodies: Uint8Array[] = [];
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput("planner", fixture, clock, random, async (attempt) => {
			bodies.push(attempt.request.body.slice());
			attempts += 1;
			return attempts === 1 ? failure("timeout") : success("ok");
		}),
	);

	expect(result.kind).toBe("completed");
	expect(bodies[0]).toEqual(bodies[1]);
});

test("partial function-call proposals never escape a stopped request as executable calls", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom([0]);
	const proposedCall =
		'{"id":"fc_partial","type":"function_call","call_id":"call_unexecuted","name":"shell","arguments":"{\\"cmd\\":\\"touch should-not-exist\\"}","status":"completed"}';
	let executedCalls = 0;
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput("planner", fixture, clock, random, async () => {
			attempts += 1;
			return failure("malformed", [proposedCall]);
		}),
	);
	if (result.kind === "completed")
		executedCalls += result.response.tool_calls.length;

	expect(result.kind).toBe("stopped");
	expect(result.attempts).toHaveLength(4);
	expect(attempts).toBe(4);
	expect(executedCalls).toBe(0);
	expect(
		result.session.history.itemBytes().map((item) => decoder.decode(item)),
	).toContain(proposedCall);
});

test("Shape login and incomplete results stop without retry or wait", async () => {
	const fixture = sessionFor("shaper");
	const clock = new AdvancingClock();
	const random = new FixedRandom();
	for (const classification of ["login", "incomplete"] as const) {
		let attempts = 0;
		const result = await respondWithRetry(
			respondInput(
				"shaper",
				fixture,
				clock,
				random,
				async () => {
					attempts += 1;
					return failure(classification);
				},
				"shape",
			),
		);
		expect(result.kind).toBe("stopped");
		expect(attempts).toBe(1);
	}
	expect(clock.sleeps).toEqual([]);
});

test("budget exhaustion before dispatch returns without calling the provider", async () => {
	const fixture = sessionFor("planner");
	const clock = new AdvancingClock();
	const random = new FixedRandom();
	let attempts = 0;
	const result = await respondWithRetry(
		respondInput(
			"planner",
			fixture,
			clock,
			random,
			async () => {
				attempts += 1;
				return success("not called");
			},
			"build",
			() => 0,
		),
	);
	expect(result.kind).toBe("budget_exhausted");
	expect(attempts).toBe(0);
});

test("usage-limit wait decisions are unavailable to Shape and without a full Build allowance", () => {
	const shape = initialRetryState({
		provider: "chatgpt",
		role: "shaper",
		model: "gpt-6.1-sol",
		effort: "high",
		overloadFallback: null,
		mode: "shape",
	});
	expect(
		stepRetry(shape, {
			failureClass: "usage_limit",
			remainingBuildBudgetMilliseconds: null,
			remainingPauseBudgetMilliseconds: 86_400_000,
			hasPartialItems: false,
		}).decision.kind,
	).toBe("stop");

	const build = initialRetryState({
		provider: "chatgpt",
		role: "planner",
		model: "gpt-6.1-sol",
		effort: "high",
		overloadFallback: null,
		mode: "build",
	});
	expect(
		stepRetry(build, {
			failureClass: "login",
			remainingBuildBudgetMilliseconds: 1,
			remainingPauseBudgetMilliseconds: 299_999,
			hasPartialItems: false,
		}).decision.kind,
	).toBe("stop");
});
