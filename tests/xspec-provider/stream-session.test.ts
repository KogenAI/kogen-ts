import { expect, test } from "bun:test";
import type { ClockPort } from "../../packages/core/src/contracts/clock";
import type { RandomPort } from "../../packages/core/src/contracts/ports";
import { resolveRoles } from "../../packages/core/src/project/roles";
import {
	type ProviderAttemptResult,
	type RespondInput,
	respondWithRetry,
} from "../../packages/core/src/provider/retry/respond";
import { ProviderPauseBudget } from "../../packages/core/src/provider/retry/transition";
import {
	responseItemBytes,
	userMessageBytes,
} from "../../packages/core/src/provider/session/history";
import {
	createSession,
	stepSession,
} from "../../packages/core/src/provider/session/transition";
import {
	encodeSessionRequest,
	hasAppendedInputPrefix,
} from "../../packages/core/src/provider/session/wire";
import type { AssembledResponse } from "../../packages/core/src/provider/sse/assemble";
import type { ResponseUsage } from "../../packages/core/src/provider/sse/usage";
import { createSessionSlice } from "../../packages/xspec/src/slices/session";
import { createStreamSlice } from "../../packages/xspec/src/slices/stream";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class FakeClock implements ClockPort {
	monotonic = 0;
	readonly sleeps: number[] = [];

	monotonicMilliseconds(): number {
		return this.monotonic;
	}

	unixMilliseconds(): number {
		return 1_800_000_000_000 + this.monotonic;
	}

	async sleep(milliseconds: number): Promise<void> {
		this.sleeps.push(milliseconds);
		this.monotonic += milliseconds;
	}
}

class MinimumRandom implements RandomPort {
	readonly calls: number[] = [];

	async bytes(length: number) {
		this.calls.push(length);
		return { ok: true as const, value: new Uint8Array(length) };
	}
}

function providerFailure(
	classification: "overload" | "timeout" | "stall" | "transport",
): ProviderAttemptResult {
	return {
		ok: false,
		error: {
			class: classification,
			message: `injected ${classification}`,
			usage: null,
		},
	};
}

function response(
	text: string,
	usage: ResponseUsage | null,
	reasoning?: string,
): AssembledResponse {
	const items: Record<string, unknown>[] = [
		{
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text }],
		},
	];
	if (reasoning !== undefined)
		items.push({ type: "reasoning", encrypted_content: reasoning });
	const rawItemJson = items.map((item) => JSON.stringify(item));
	return {
		ok: true,
		id: `resp-${text}`,
		text,
		tool_calls: [],
		usage,
		raw_items: items,
		raw_item_json: rawItemJson,
	};
}

function sessionForBuilder() {
	const roles = resolveRoles({ provider: "chatgpt" });
	if (!roles.ok) throw new Error("Default ChatGPT roles did not resolve.");
	const initialReasoning = responseItemBytes({
		type: "reasoning",
		encrypted_content: "initial-luna-reasoning",
	});
	const session = createSession({
		runDirectory: "/tmp/kogen-xspec-provider/three-turn-run",
		provider: "chatgpt",
		authMode: "injected",
		role: "builder",
		model: roles.value.roles.builder.effective.model,
		effort: roles.value.roles.builder.effective.effort,
		stage: "develop",
		roleInstructions: "You are Kogen's builder.",
		genericInstructions: "Use the canonical Kogen request protocol.",
		toolSchemas: [],
		toolSchemaVersion: "xspec-provider-tools-v1",
		promptVersion: "xspec-provider-prompt-v1",
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
			{ bytes: userMessageBytes("approved work"), kind: "message" },
			{
				bytes: initialReasoning,
				kind: "reasoning",
				model: roles.value.roles.builder.effective.model,
				encrypted: true,
			},
		],
	});
	return { session, resolvedRole: roles.value.roles.builder };
}

function appendCompletedTurn(
	session: ReturnType<typeof sessionForBuilder>["session"],
	resultValue: AssembledResponse,
): ReturnType<typeof sessionForBuilder>["session"] {
	return stepSession(session, {
		type: "append_turn",
		responseItems: resultValue.raw_item_json.map((item) =>
			encoder.encode(item),
		),
	});
}

function respondInput(
	session: ReturnType<typeof sessionForBuilder>["session"],
	resolvedRole: ReturnType<typeof sessionForBuilder>["resolvedRole"],
	clock: FakeClock,
	random: MinimumRandom,
	sendAttempt: RespondInput["sendAttempt"],
): RespondInput {
	return {
		session,
		resolvedRole,
		mode: "build",
		clock,
		random,
		sendAttempt,
		remainingBuildBudgetMilliseconds: () => 300_000,
		providerPauseBudget: new ProviderPauseBudget(),
	};
}

test("stream slice returns the whole observation after production retry and model-switch steps", async () => {
	const slice = createStreamSlice();
	expect(await slice.reset()).toEqual({
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
	});
	const opened = await slice.apply({
		tag: "Open",
		value: {
			role: "builder",
			model: "luna",
			fallbackOn: true,
			refreshable: true,
			bounded: true,
			wall: 100_000,
			mode: "build",
		},
	});
	expect(opened).toMatchObject({
		phase: "open",
		attempt: 1,
		model: "luna",
		queued: true,
		exit: 0,
	});
	expect(
		await slice.apply({
			tag: "Result",
			value: { kind: "overload", items: false },
		}),
	).toMatchObject({
		decision: "retry",
		delay: 2_000,
		attempt: 2,
		overloads: 1,
		model: "luna",
		reason: "provider/overload",
	});
	expect(
		await slice.apply({
			tag: "Result",
			value: { kind: "overload", items: false },
		}),
	).toMatchObject({
		decision: "switch",
		delay: 0,
		attempt: 3,
		overloads: 2,
		model: "sol",
		role: "builder",
	});
	expect(
		await slice.apply({ tag: "Result", value: { kind: "ok", items: false } }),
	).toMatchObject({
		decision: "success",
		phase: "idle",
		model: "sol",
		attempt: 3,
		exit: 0,
		queued: true,
		failed: false,
	});
});

test("session slice preserves complete identity observations and production run affinity", async () => {
	const slice = createSessionSlice();
	const initial = (await slice.reset()) as Record<string, unknown>;
	expect(initial).toEqual({
		version: "",
		stage: "",
		attempt: "",
		rung: "",
		epoch: "",
		epochClass: "",
		model: "",
		runName: "run-1",
		affinityChanged: false,
		previous: false,
		keyChanged: false,
		lite: "",
		last: "ok",
		sharedAffinity: false,
		prefixes: {},
	});
	const bound = await slice.apply({
		tag: "Bind",
		value: { stage: "develop", attempt: "", rung: "" },
	});
	expect(bound).toMatchObject({
		version: "v2",
		stage: "develop",
		attempt: "builder",
		rung: "builder",
		epoch: "initial",
		epochClass: "initial",
		keyChanged: false,
		last: "ok",
	});
	for (const tag of ["Turn", "Repair"])
		expect(await slice.apply({ tag })).toMatchObject({
			keyChanged: false,
			attempt: "builder",
			rung: "builder",
			epoch: "initial",
			last: "ok",
		});
	expect(
		await slice.apply({ tag: "Model", value: { name: "sol" } }),
	).toMatchObject({
		model: "sol",
		keyChanged: false,
		previous: false,
		last: "ok",
	});
	expect(
		await slice.apply({ tag: "NewRun", value: { name: "run-2" } }),
	).toMatchObject({
		version: "",
		runName: "run-2",
		affinityChanged: true,
		sharedAffinity: false,
	});
});

test("shared affinity stays stable across consecutive new runs before binding", async () => {
	const slice = createSessionSlice();
	expect(
		await slice.apply({ tag: "AffinityScope", value: { shared: true } }),
	).toMatchObject({
		sharedAffinity: true,
		affinityChanged: false,
	});
	expect(
		await slice.apply({ tag: "NewRun", value: { name: "run-2" } }),
	).toMatchObject({
		runName: "run-2",
		sharedAffinity: true,
		affinityChanged: false,
	});
	expect(
		await slice.apply({ tag: "NewRun", value: { name: "run-1" } }),
	).toMatchObject({
		runName: "run-1",
		sharedAffinity: true,
		affinityChanged: false,
	});
});

test("three turns keep real request bytes and sticky headers across retry and model switch", async () => {
	const { session: initial, resolvedRole } = sessionForBuilder();
	const clock = new FakeClock();
	const random = new MinimumRandom();
	const wire: {
		body: Uint8Array;
		headers: Readonly<Record<string, string>>;
		model: string;
	}[] = [];
	const knownUsage: ResponseUsage = {
		input: 80,
		cached_input: 16,
		cache_write: null,
		output: 12,
		reasoning: null,
	};
	const turn1Response = response(
		"turn-one",
		knownUsage,
		"turn-one-luna-reasoning",
	);
	const turn1 = await respondWithRetry(
		respondInput(
			initial,
			resolvedRole,
			clock,
			random,
			async ({ request, session }) => {
				wire.push({
					body: request.body.slice(),
					headers: request.headers,
					model: session.model,
				});
				return { ok: true, response: turn1Response };
			},
		),
	);
	expect(turn1.kind).toBe("completed");
	if (turn1.kind !== "completed") return;
	expect(turn1.attempts[0]?.usage).toEqual(knownUsage);
	let session = appendCompletedTurn(turn1.session, turn1.response);

	const scripted: ProviderAttemptResult[] = [
		providerFailure("overload"),
		providerFailure("overload"),
		{
			ok: true,
			response: response("turn-two", knownUsage, "turn-two-sol-reasoning"),
		},
	];
	const beforeSwitch = encodeSessionRequest(session);
	const turn2 = await respondWithRetry(
		respondInput(
			session,
			resolvedRole,
			clock,
			random,
			async ({ request, session: current }) => {
				wire.push({
					body: request.body.slice(),
					headers: request.headers,
					model: current.model,
				});
				const next = scripted.shift();
				if (next === undefined)
					throw new Error("The fake outcome script was exhausted.");
				return next;
			},
		),
	);
	expect(turn2.kind).toBe("completed");
	if (turn2.kind !== "completed") return;
	expect(turn2.attempts.map((attempt) => attempt.model)).toEqual([
		"gpt-6-luna",
		"gpt-6-luna",
		"gpt-6.1-sol",
	]);
	const firstRetrySha = turn2.attempts[0]?.requestSha256;
	if (firstRetrySha === undefined)
		throw new Error("Retry attempt was not recorded.");
	expect(
		turn2.attempts.slice(0, 2).map((attempt) => attempt.requestSha256),
	).toEqual([firstRetrySha, firstRetrySha]);
	expect(wire[1]?.body).toEqual(wire[2]?.body);
	expect(
		hasAppendedInputPrefix(
			wire[0]?.body ?? new Uint8Array(),
			beforeSwitch.body,
		),
	).toBe(true);
	expect(decoder.decode(wire[3]?.body).includes('"model":"gpt-6.1-sol"')).toBe(
		true,
	);
	expect(
		decoder.decode(wire[3]?.body).includes("turn-one-luna-reasoning"),
	).toBe(false);
	expect(wire[1]?.headers["session-id"]).toBe(initial.cacheKey);
	expect(wire[1]?.headers["thread-id"]).toBe(initial.threadId);
	expect(wire[3]?.headers["thread-id"]).toBe(initial.threadId);
	expect(wire[1]?.headers.accept).toBe("text/event-stream");
	expect(clock.sleeps).toEqual([1_000]);
	expect(random.calls).toEqual([4]);
	const switchedSession = turn2.session;
	expect(
		switchedSession.history
			.metadata()
			.filter((item) => item.kind === "reasoning" && item.encrypted)
			.every((item) => item.model === "gpt-6.1-sol"),
	).toBe(true);
	session = appendCompletedTurn(switchedSession, turn2.response);

	const turn3 = await respondWithRetry(
		respondInput(
			session,
			resolvedRole,
			clock,
			random,
			async ({ request, session: current }) => {
				wire.push({
					body: request.body.slice(),
					headers: request.headers,
					model: current.model,
				});
				return { ok: true, response: response("turn-three", null) };
			},
		),
	);
	expect(turn3.kind).toBe("completed");
	if (turn3.kind !== "completed") return;
	expect(turn3.attempts[0]?.usage).toBeNull();
	expect(turn3.response.usage).toBeNull();
	expect(
		hasAppendedInputPrefix(
			wire[3]?.body ?? new Uint8Array(),
			wire[4]?.body ?? new Uint8Array(),
		),
	).toBe(true);
	expect(wire[4]?.headers["session-id"]).toBe(initial.cacheKey);
	expect(wire[4]?.headers["thread-id"]).toBe(initial.threadId);
	expect(decoder.decode(wire[4]?.body).includes("turn-two-sol-reasoning")).toBe(
		true,
	);
	expect(decoder.decode(wire[4]?.body).includes("previous_response_id")).toBe(
		false,
	);
	expect(wire.every((request) => request.body.byteLength > 0)).toBe(true);
});
