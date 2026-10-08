import { expect, test } from "bun:test";
import type { ClockPort } from "../../packages/core/src/contracts/clock";
import type {
	FileSystemPort,
	RandomPort,
} from "../../packages/core/src/contracts/ports";
import { resolveRoles } from "../../packages/core/src/project/roles";
import type {
	ProviderAttemptResult,
	SendProviderAttempt,
} from "../../packages/core/src/provider/retry/respond";
import { STREAM_CONTINUATION_INSTRUCTION } from "../../packages/core/src/provider/retry/respond";
import { userMessageBytes } from "../../packages/core/src/provider/session/history";
import {
	createSession,
	type RoleToolAuthorization,
} from "../../packages/core/src/provider/session/transition";
import { encodeSessionRequest } from "../../packages/core/src/provider/session/wire";
import type {
	AssembledResponse,
	ResponseToolCall,
} from "../../packages/core/src/provider/sse/assemble";
import type { ResponseUsage } from "../../packages/core/src/provider/sse/usage";
import {
	CANONICAL_TOOL_SCHEMAS,
	TOOL_SCHEMA_VERSION,
} from "../../packages/core/src/provider/tools/schema";
import {
	runShape,
	type ShapeControllerRequest,
	type ShapeValidationInput,
	type ShapeValidationOutcome,
} from "../../packages/core/src/shape/controller";
import {
	respondToShapeRequest,
	startFallbackConversation,
} from "../../packages/core/src/shape/conversation";
import {
	SHAPE_LIMITS,
	ShapeAccounting,
	shapeRoleAssignment,
} from "../../packages/core/src/shape/counters";
import { SHAPER_SYSTEM_PROMPT } from "../../packages/core/src/shape/prompts";

const decoder = new TextDecoder("utf-8", { fatal: true });
const authorization: RoleToolAuthorization = {
	builder: [
		"read",
		"search",
		"edit",
		"write",
		"shell",
		"finish",
		"tool_output",
	],
	planner: [],
	shaper: ["read", "search", "write"],
	auditor: [],
	reviewer: [],
	context: [],
};

function roleFixtures(provider: "chatgpt" | "grok" = "chatgpt") {
	const result = resolveRoles({ provider });
	if (!result.ok) throw new Error("Test role resolution failed.");
	return result.value;
}

function sessionFixtures(
	name = "primary",
	provider: "chatgpt" | "grok" = "chatgpt",
) {
	const roles = roleFixtures(provider);
	const initialUserMessage = {
		bytes: userMessageBytes(
			"Slug: shape-test\n\nTask statement:\nPreserve the original request.",
		),
		kind: "message" as const,
	};
	const session = createSession({
		runDirectory: `/tmp/kogen-shape/${name}`,
		provider,
		authMode: "injected",
		role: "shaper",
		model: roles.roles.shaper.effective.model,
		effort: roles.roles.shaper.effective.effort,
		stage: "shape",
		attempt: "primary",
		rung: "primary",
		roleInstructions: SHAPER_SYSTEM_PROMPT,
		genericInstructions: "Shared shape instructions and complete tool schemas.",
		toolSchemas: CANONICAL_TOOL_SCHEMAS,
		toolSchemaVersion: TOOL_SCHEMA_VERSION,
		promptVersion: "shape-prompt-v1.3",
		adapterVersion: "responses-v1",
		roleToolAuthorization: authorization,
		initialItems: [initialUserMessage],
	});
	return { roles, session, initialUserMessage };
}

function makeClock(): ClockPort {
	let ticks = 0;
	return {
		monotonicMilliseconds: () => ticks++,
		unixMilliseconds: () => 1_800_000_000_000 + ticks++,
		sleep: async (milliseconds) => {
			ticks += milliseconds;
		},
	};
}

const random: RandomPort = {
	bytes: async (length) => ({ ok: true, value: new Uint8Array(length) }),
};

function usage(overrides: Partial<ResponseUsage> = {}): ResponseUsage {
	return {
		input: 100,
		cached_input: 20,
		cache_write: 0,
		output: 30,
		reasoning: 5,
		...overrides,
	};
}

function response(
	input: {
		readonly text?: string;
		readonly calls?: readonly ResponseToolCall[];
		readonly rawItems?: readonly string[];
		readonly usage?: ResponseUsage | null;
	} = {},
): AssembledResponse {
	const calls = input.calls ?? [];
	const rawItems = input.rawItems ?? [
		JSON.stringify({
			type: "message",
			role: "assistant",
			content: [
				{ type: "output_text", text: input.text ?? "Intent complete." },
			],
		}),
	];
	return {
		ok: true,
		id: "resp-shape-test",
		text: input.text ?? "Intent complete.",
		tool_calls: calls,
		usage: input.usage === undefined ? usage() : input.usage,
		raw_items: rawItems.map((item) => JSON.parse(item) as unknown),
		raw_item_json: [...rawItems],
	};
}

function providerSuccess(result: AssembledResponse): ProviderAttemptResult {
	return { ok: true, response: result };
}

function noToolOptions() {
	return { authorizedTools: ["read", "search", "write"] } as const;
}

function memoryFilesystem(
	writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}>,
): FileSystemPort {
	return {
		readFile: async () => ({
			ok: false,
			error: { code: "not_found", message: "unused", retryable: false },
		}),
		writeFileAtomically: async (request) => {
			writes.push({ ...request, bytes: request.bytes.slice() });
			return { ok: true, value: undefined };
		},
		removeFile: async () => ({ ok: true, value: undefined }),
	};
}

function controllerRequest(input: {
	readonly name: string;
	readonly sendAttempt: SendProviderAttempt;
	readonly validate: (
		value: ShapeValidationInput,
	) => Promise<ShapeValidationOutcome>;
	readonly dispatchTools?: ShapeControllerRequest["dispatchTools"];
	readonly writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}>;
}): ShapeControllerRequest {
	const { roles, session, initialUserMessage } = sessionFixtures(input.name);
	return {
		initialSession: session,
		initialUserMessage,
		shaperRole: roles.roles.shaper,
		auditorRole: roles.roles.auditor,
		scratchDirectory: `/tmp/kogen-shape/${input.name}/scratch`,
		filesystem: memoryFilesystem(input.writes),
		clock: makeClock(),
		random,
		sendAttempt: input.sendAttempt,
		toolOptions: noToolOptions(),
		validate: input.validate,
		...(input.dispatchTools === undefined
			? {}
			: { dispatchTools: input.dispatchTools }),
	};
}

function repairOutcome(
	pass: number,
	repairKind: Extract<
		ShapeValidationOutcome,
		{ kind: "repair" }
	>["repairKind"] = "validation",
): Extract<ShapeValidationOutcome, { kind: "repair" }> {
	return {
		kind: "repair",
		failure: {
			category: "candidate",
			reason: "candidate/acceptance_failed",
			message: `acceptance failed on traversal ${pass}`,
			exitCode: 1,
		},
		feedback: `Exact failure output for traversal ${pass}.`,
		repairKind,
	};
}

function textFromUserItem(bytes: Uint8Array): string {
	const parsed = JSON.parse(decoder.decode(bytes)) as {
		content?: readonly { type?: string; text?: string }[];
	};
	return (parsed.content ?? [])
		.filter((entry) => entry.type === "input_text")
		.map((entry) => entry.text ?? "")
		.join("\n");
}

test("shape counters reset per conversation and cap passes, turns, and style repairs", () => {
	const { roles, session } = sessionFixtures("counter-limits");
	const accounting = new ShapeAccounting({
		shaper: roles.roles.shaper,
		auditor: roles.roles.auditor,
	});
	accounting.registerConversation(
		session.threadId,
		"primary",
		shapeRoleAssignment(roles.roles.shaper, "shaper"),
	);
	for (let index = 0; index < SHAPE_LIMITS.logicalTurns; index += 1)
		accounting.startLogicalTurn(session.threadId);
	expect(accounting.canStartLogicalTurn(session.threadId)).toBe(false);
	for (let index = 0; index < SHAPE_LIMITS.validationPasses; index += 1)
		accounting.completeValidationPass(session.threadId);
	expect(
		accounting.conversation(session.threadId).counters.pass_labels,
	).toEqual([1, 2, 3]);
	expect(accounting.canCompleteValidationPass(session.threadId)).toBe(false);
	accounting.recordRepair(session.threadId, "style");
	accounting.recordRepair(session.threadId, "style");
	expect(accounting.canRepairStyle(session.threadId)).toBe(false);
	expect(() => accounting.recordRepair(session.threadId, "style")).toThrow();
	const firstMessageBytes = session.history.itemBytes()[0];
	if (!firstMessageBytes)
		throw new Error("Fixture is missing its first message.");

	const fallback = startFallbackConversation({
		primary: session,
		initialUserMessage: {
			bytes: firstMessageBytes,
			kind: "message",
		},
		effectiveShaper: roles.roles.shaper,
		lastFailure: "candidate/acceptance_failed: exact last failure",
	});
	accounting.registerConversation(
		fallback.threadId,
		"fallback",
		shapeRoleAssignment(roles.roles.shaper, "fallback_shaper"),
	);
	expect(accounting.conversation(fallback.threadId).counters).toMatchObject({
		logical_turns: 0,
		validation_passes: 0,
		repairs: { style: 0 },
	});
	expect(accounting.nextValidationPassLabel(fallback.threadId)).toBe(4);
});

test("one RequestContext retains partial stream items and controller notes through the fallback prefix", async () => {
	const { roles, session, initialUserMessage } = sessionFixtures(
		"interrupted-context",
	);
	const accounting = new ShapeAccounting({
		shaper: roles.roles.shaper,
		auditor: roles.roles.auditor,
	});
	const partialJson = JSON.stringify({
		type: "message",
		role: "assistant",
		content: [
			{ type: "output_text", text: "I inspected the acceptance file." },
		],
	});
	const interruptedItems: string[] = [];
	let sends = 0;
	const result = await respondToShapeRequest({
		session,
		role: roles.roles.shaper,
		accounting,
		clock: makeClock(),
		random,
		onInterruptedItems: (items) => interruptedItems.push(...items),
		timeScale: 0.001,
		sendAttempt: async () => {
			sends += 1;
			if (sends === 1)
				return {
					ok: false,
					error: {
						class: "transport",
						message: "stream cut",
						partialItemJson: [partialJson],
						cutAfterMilliseconds: 12,
					},
				};
			return providerSuccess(
				response({ text: "finished after the cut", usage: usage() }),
			);
		},
	});
	expect(result.kind).toBe("completed");
	const primary = result.session;
	expect(
		primary.history.itemBytes().map((item) => decoder.decode(item)),
	).toContain(partialJson);
	const primaryNotes = primary.history
		.snapshotItems()
		.filter((item) => item.kind === "user_note")
		.map((item) => textFromUserItem(item.bytes));
	expect(primaryNotes).toContain(STREAM_CONTINUATION_INSTRUCTION);
	const notedPrimary = createSession({
		runDirectory: primary.runDirectory,
		provider: primary.provider,
		authMode: primary.authMode,
		role: "shaper",
		model: primary.model,
		effort: primary.effort,
		stage: primary.stage,
		attempt: primary.attempt,
		rung: primary.rung,
		roleInstructions: primary.roleInstructions,
		genericInstructions: primary.prefix.genericInstructions,
		toolSchemas: primary.prefix.toolSchemas,
		toolSchemaVersion: primary.prefixVersion.toolSchemaVersion,
		promptVersion: primary.prefixVersion.promptVersion,
		adapterVersion: primary.prefixVersion.adapterVersion,
		roleToolAuthorization: primary.roleToolAuthorization,
		cacheKey: primary.cacheKey,
		initialItems: primary.history.snapshotItems(),
	});
	const withControllerInput = {
		...notedPrimary,
		history: notedPrimary.history.append([
			{
				bytes: userMessageBytes("Controller says preserve these findings."),
				kind: "user_note",
			},
		]),
	};
	const fallback = startFallbackConversation({
		primary: withControllerInput,
		initialUserMessage,
		effectiveShaper: roles.roles.shaper,
		lastFailure: "candidate/acceptance_failed: keep the exact failure",
		interruptedItems,
	});
	const primaryRequest = encodeSessionRequest(primary);
	const fallbackRequest = encodeSessionRequest(fallback);
	expect(fallbackRequest.staticPrefixSha256).toBe(
		primaryRequest.staticPrefixSha256,
	);
	expect(fallback.threadId).not.toBe(primary.threadId);
	expect(fallback.cacheKey).toBe(primary.cacheKey);
	expect(fallback.provider).toBe(primary.provider);
	expect(fallback.model).toBe(roles.roles.shaper.effective.model);
	expect(fallback.effort).toBe(roles.roles.shaper.effective.effort);
	expect(fallback.role).toBe("fallback_shaper");
	expect(fallback.effectiveRole).toBe("shaper");
	const fallbackItems = fallback.history.snapshotItems();
	const fallbackInitialBytes = fallbackItems[0]?.bytes;
	if (!fallbackInitialBytes)
		throw new Error("Fallback fixture has no initial message.");
	expect(decoder.decode(fallbackInitialBytes)).toBe(
		decoder.decode(initialUserMessage.bytes),
	);
	expect(fallbackItems.map((item) => decoder.decode(item.bytes))).toContain(
		partialJson,
	);
	const fallbackText = fallbackItems
		.filter((item) => item.kind === "user_note")
		.map((item) => textFromUserItem(item.bytes))
		.join("\n");
	expect(fallbackText).toContain(STREAM_CONTINUATION_INSTRUCTION);
	expect(fallbackText).toContain("Controller says preserve these findings.");
	expect(fallbackText).toContain(
		"candidate/acceptance_failed: keep the exact failure",
	);
	expect(
		accounting.snapshot({
			outcome: {
				status: "success",
				exit_code: 0,
				category: null,
				reason: null,
			},
			elapsedMilliseconds: 1,
		}).unknown_usage.attempts,
	).toBe(1);
});

test("Grok fallback aliases the effective shaper without changing provider, model, or effort", () => {
	const { roles, session, initialUserMessage } = sessionFixtures(
		"grok-shape-fallback",
		"grok",
	);
	const fallback = startFallbackConversation({
		primary: session,
		initialUserMessage,
		effectiveShaper: roles.roles.shaper,
		lastFailure: "candidate/acceptance_failed: Grok primary exhausted",
	});
	expect(fallback.provider).toBe("grok");
	expect(fallback.role).toBe("fallback_shaper");
	expect(fallback.effectiveRole).toBe("shaper");
	expect(fallback.model).toBe("grok-4.6");
	expect(fallback.effort).toBe("high");
	expect(fallback.threadId).not.toBe(session.threadId);
	expect(encodeSessionRequest(fallback).staticPrefixSha256).toBe(
		encodeSessionRequest(session).staticPrefixSha256,
	);
});

test("a valid third pass succeeds and primary pass exhaustion starts exactly one fallback", async () => {
	let sends = 0;
	let validations = 0;
	const sessions: string[] = [];
	const prefixHashes: string[] = [];
	const writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}> = [];
	const thirdPassSuccess = controllerRequest({
		name: "last-pass-success",
		writes,
		sendAttempt: async ({ session, request }) => {
			sends += 1;
			sessions.push(session.threadId);
			prefixHashes.push(request.staticPrefixSha256);
			return providerSuccess(response({ usage: null }));
		},
		validate: async () => {
			validations += 1;
			if (validations === 1) return repairOutcome(validations);
			if (validations === 2) return repairOutcome(validations, "combined");
			return { kind: "valid" };
		},
	});
	const thirdPassResult = await runShape(thirdPassSuccess);
	expect(thirdPassResult.status).toBe("success");
	if (thirdPassResult.status !== "success")
		throw new Error("Expected Shape success.");
	expect(sends).toBe(3);
	expect(new Set(sessions).size).toBe(1);
	expect(new Set(prefixHashes).size).toBe(1);
	expect(thirdPassResult.accounting.conversations).toHaveLength(1);
	expect(
		thirdPassResult.accounting.conversations[0]?.counters.pass_labels,
	).toEqual([1, 2, 3]);
	expect(thirdPassResult.accounting.counters.repairs.validation).toBe(1);
	expect(thirdPassResult.accounting.counters.repairs.combined).toBe(1);
	expect(thirdPassResult.accountingPersisted).toBe(true);
	expect(writes[0]?.path).toBe("shape-accounting.json");
	expect(writes[0]?.mode).toBe(0o600);
	expect(
		JSON.parse(decoder.decode(writes[0]?.bytes ?? new Uint8Array())).schema,
	).toBe(1);

	sends = 0;
	validations = 0;
	sessions.length = 0;
	prefixHashes.length = 0;
	writes.length = 0;
	const fallbackInputs: string[] = [];
	const fallbackAfterPassLimit = controllerRequest({
		name: "fallback-after-pass-limit",
		writes,
		sendAttempt: async ({ session, request }) => {
			sends += 1;
			sessions.push(session.threadId);
			prefixHashes.push(request.staticPrefixSha256);
			if (session.role === "fallback_shaper") {
				fallbackInputs.push(
					session.history
						.snapshotItems()
						.filter((item) => item.kind === "user_note")
						.map((item) => textFromUserItem(item.bytes))
						.join("\n"),
				);
			}
			return providerSuccess(response({ usage: null }));
		},
		validate: async ({ conversation }) => {
			validations += 1;
			return conversation === "primary"
				? repairOutcome(validations)
				: { kind: "valid" };
		},
	});
	const fallbackResult = await runShape(fallbackAfterPassLimit);
	expect(fallbackResult.status).toBe("success");
	if (fallbackResult.status !== "success")
		throw new Error("Expected fallback success.");
	expect(sends).toBe(4);
	expect(new Set(sessions.slice(0, 3)).size).toBe(1);
	expect(sessions[3]).not.toBe(sessions[0]);
	expect(new Set(prefixHashes).size).toBe(1);
	expect(
		fallbackResult.accounting.conversations.map((entry) => entry.kind),
	).toEqual(["primary", "fallback"]);
	expect(fallbackResult.accounting.conversations[1]?.role).toMatchObject({
		assigned_role: "fallback_shaper",
		effective_role: "shaper",
		effective: {
			provider: "chatgpt",
			model: "gpt-6.1-sol",
			effort: "high",
		},
	});
	expect(fallbackResult.accounting.counters.validation_passes).toBe(4);
	expect(fallbackResult.accounting.http.attempts).toBe(4);
	expect(fallbackResult.accounting.unknown_usage.attempts).toBe(4);
	expect(fallbackResult.accounting.auditor.http_attempts).toBe(0);
	expect(fallbackInputs).toHaveLength(1);
	expect(fallbackInputs[0]).toContain("Exact failure output for traversal 1.");
	expect(fallbackInputs[0]).toContain("Exact failure output for traversal 2.");
	expect(fallbackInputs[0]).toContain("Exact failure output for traversal 3.");
	expect(decoder.decode(writes[0]?.bytes ?? new Uint8Array())).toContain(
		'"schema": 1',
	);
});

test("finish guards and style-only repairs spend turns without spending validation passes", async () => {
	const writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}> = [];
	let validations = 0;
	const result = await runShape(
		controllerRequest({
			name: "free-shape-work",
			writes,
			sendAttempt: async () => providerSuccess(response({ usage: null })),
			validate: async () => {
				validations += 1;
				if (validations === 1)
					return { kind: "finish_guard", missingPaths: ["intent.md"] };
				if (validations === 2)
					return {
						kind: "style_repair",
						feedback: "Repair the remaining style finding.",
					};
				return { kind: "valid" };
			},
		}),
	);
	expect(result.status).toBe("success");
	if (result.status !== "success") throw new Error("Expected Shape success.");
	expect(result.accounting.counters.logical_turns.shaper).toBe(3);
	expect(result.accounting.counters.validation_passes).toBe(1);
	expect(result.accounting.counters.finish_guards).toBe(1);
	expect(result.accounting.counters.repairs.style).toBe(1);
});

test("fallback pass exhaustion exits 1 after one fallback and persists failure accounting", async () => {
	let sends = 0;
	let validations = 0;
	const writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}> = [];
	const result = await runShape(
		controllerRequest({
			name: "fallback-exhaustion",
			writes,
			sendAttempt: async () => {
				sends += 1;
				return providerSuccess(response({ usage: null }));
			},
			validate: async () => {
				validations += 1;
				return repairOutcome(validations);
			},
		}),
	);
	expect(result.status).toBe("failure");
	if (result.status !== "failure")
		throw new Error("Expected fallback exhaustion.");
	expect(result.exitCode).toBe(1);
	expect(result.failure.reason).toBe("candidate/acceptance_failed");
	expect(result.failure.message).toContain(
		"after 6 pass(es) and 6 model call(s)",
	);
	expect(result.accounting.conversations.map((entry) => entry.kind)).toEqual([
		"primary",
		"fallback",
	]);
	expect(result.accounting.counters.validation_passes).toBe(6);
	expect(sends).toBe(6);
	expect(writes[0]?.path).toBe("shape-accounting.json");
	expect(
		JSON.parse(decoder.decode(writes[0]?.bytes ?? new Uint8Array())),
	).toMatchObject({
		schema: 1,
		profile: "shape-v1.3",
		outcome: {
			status: "failure",
			exit_code: 1,
			category: "candidate",
			reason: "candidate/acceptance_failed",
		},
	});
});

test("primary turn exhaustion starts fallback and a success on turn 60 is accepted", async () => {
	async function runAtTurnLimit(name: string, completeOnLastTurn: boolean) {
		let primaryTurns = 0;
		let validations = 0;
		const writes: Array<{
			root: string;
			path: string;
			bytes: Uint8Array;
			mode: number;
		}> = [];
		const request = controllerRequest({
			name,
			writes,
			sendAttempt: async ({ session }) => {
				if (session.role === "shaper") {
					primaryTurns += 1;
					if (!completeOnLastTurn || primaryTurns < SHAPE_LIMITS.logicalTurns) {
						const call: ResponseToolCall = {
							id: `call-${primaryTurns}`,
							name: "write",
							arguments: { path: "intent.md", content: "draft" },
						};
						const raw = JSON.stringify({
							type: "function_call",
							id: call.id,
							call_id: call.id,
							name: call.name,
							arguments: call.arguments,
						});
						return providerSuccess(
							response({ calls: [call], rawItems: [raw] }),
						);
					}
				}
				return providerSuccess(response({ usage: null }));
			},
			validate: async () => {
				validations += 1;
				return { kind: "valid" };
			},
			dispatchTools: async ({ response: toolResponse }) =>
				toolResponse.tool_calls.map((call) => ({
					callId: call.id,
					output: "Wrote intent.md.",
				})),
		});
		return {
			result: await runShape(request),
			writes,
			validations,
			primaryTurns,
		};
	}

	const lastTurnSuccess = await runAtTurnLimit("last-turn-success", true);
	expect(lastTurnSuccess.result.status).toBe("success");
	expect(lastTurnSuccess.primaryTurns).toBe(SHAPE_LIMITS.logicalTurns);
	if (lastTurnSuccess.result.status !== "success")
		throw new Error("Expected success at the limit.");
	expect(
		lastTurnSuccess.result.accounting.conversations.map((entry) => entry.kind),
	).toEqual(["primary"]);

	const exhaustedTurn = await runAtTurnLimit("turn-exhaustion-fallback", false);
	expect(exhaustedTurn.result.status).toBe("success");
	expect(exhaustedTurn.primaryTurns).toBe(SHAPE_LIMITS.logicalTurns);
	if (exhaustedTurn.result.status !== "success")
		throw new Error("Expected fallback success.");
	expect(
		exhaustedTurn.result.accounting.conversations.map((entry) => entry.kind),
	).toEqual(["primary", "fallback"]);
	expect(
		exhaustedTurn.result.accounting.conversations[0]?.counters.logical_turns,
	).toBe(60);
	expect(
		exhaustedTurn.result.accounting.conversations[1]?.counters.logical_turns,
	).toBe(1);
	expect(exhaustedTurn.validations).toBe(1);
});

test("turn exhaustion before a validation traversal carries shape_turn_limit into fallback", async () => {
	const writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}> = [];
	let primaryTurns = 0;
	let fallbackInput = "";
	const result = await runShape(
		controllerRequest({
			name: "turn-limit-before-validation",
			writes,
			sendAttempt: async ({ session }) => {
				if (session.role === "shaper") primaryTurns += 1;
				else {
					fallbackInput = session.history
						.snapshotItems()
						.filter((item) => item.kind === "user_note")
						.map((item) => textFromUserItem(item.bytes))
						.join("\n");
				}
				return providerSuccess(response({ usage: null }));
			},
			validate: async ({ conversation }) =>
				conversation === "primary"
					? { kind: "finish_guard", missingPaths: ["intent.md"] }
					: { kind: "valid" },
		}),
	);
	expect(result.status).toBe("success");
	expect(primaryTurns).toBe(SHAPE_LIMITS.logicalTurns);
	expect(fallbackInput).toContain("candidate/shape_turn_limit");
	expect(result.accounting.counters.finish_guards).toBe(
		SHAPE_LIMITS.logicalTurns,
	);
});

test("provider errors bypass fallback and still publish schema-1 accounting", async () => {
	const writes: Array<{
		root: string;
		path: string;
		bytes: Uint8Array;
		mode: number;
	}> = [];
	const request = controllerRequest({
		name: "provider-failure",
		writes,
		sendAttempt: async () => ({
			ok: false,
			error: { class: "login", message: "saved login is invalid" },
		}),
		validate: async () => ({ kind: "valid" }),
	});
	const result = await runShape(request);
	expect(result.status).toBe("failure");
	if (result.status !== "failure")
		throw new Error("Expected provider failure.");
	expect(result.exitCode).toBe(4);
	expect(result.failure.reason).toBe("provider/login");
	expect(result.accounting.conversations.map((entry) => entry.kind)).toEqual([
		"primary",
	]);
	expect(result.accounting.http.attempts).toBe(1);
	expect(result.accounting.unknown_usage.attempts).toBe(1);
	expect(result.accountingPersisted).toBe(true);
	expect(writes[0]?.path).toBe("shape-accounting.json");
});

test("auditor usage remains separate from shaper and HTTP totals", async () => {
	const { roles, session } = sessionFixtures("auditor-accounting");
	const accounting = new ShapeAccounting({
		shaper: roles.roles.shaper,
		auditor: roles.roles.auditor,
	});
	const auditSession = createSession({
		runDirectory: session.runDirectory,
		provider: session.provider,
		authMode: session.authMode,
		role: "auditor",
		model: roles.roles.auditor.effective.model,
		effort: roles.roles.auditor.effective.effort,
		stage: "shape-audit",
		attempt: "requirements",
		roleInstructions: "You are Kogen's requirement auditor.",
		genericInstructions: session.prefix.genericInstructions,
		toolSchemas: CANONICAL_TOOL_SCHEMAS,
		toolSchemaVersion: TOOL_SCHEMA_VERSION,
		promptVersion: "shape-prompt-v1.3",
		adapterVersion: "responses-v1",
		roleToolAuthorization: authorization,
		cacheKey: session.cacheKey,
		initialItems: [
			{ bytes: userMessageBytes("List requirements."), kind: "message" },
		],
	});
	const result = await respondToShapeRequest({
		session: auditSession,
		role: roles.roles.auditor,
		accounting,
		clock: makeClock(),
		random,
		sendAttempt: async () =>
			providerSuccess(
				response({
					usage: usage({ input: 7, cached_input: 1, output: 3, reasoning: 1 }),
				}),
			),
	});
	expect(result.kind).toBe("completed");
	const doc = accounting.snapshot({
		outcome: { status: "success", exit_code: 0, category: null, reason: null },
		elapsedMilliseconds: 8,
	});
	expect(doc.auditor.logical_requests).toBe(1);
	expect(doc.auditor.http_attempts).toBe(1);
	expect(doc.auditor.known_tokens.input).toBe(7);
	expect(doc.http.attempts).toBe(1);
	expect(doc.unknown_usage.attempts).toBe(0);
	expect(doc.counters.logical_turns.auditor).toBe(1);
});
