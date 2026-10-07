import { expect, test } from "bun:test";
import {
	deriveCacheKey,
	deriveProtocolSessionId,
	deriveThreadId,
} from "../../packages/core/src/provider/session/keys";
import {
	type CanonicalToolSchema,
	canonicalJsonBytes,
	StaticPrefix,
	StaticPrefixRegistry,
} from "../../packages/core/src/provider/session/prefix";
import {
	type CreateSessionInput,
	createSession,
	stepSession,
} from "../../packages/core/src/provider/session/transition";
import {
	encodeSessionRequest,
	hasAppendedInputPrefix,
} from "../../packages/core/src/provider/session/wire";

const encoder = new TextEncoder();
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
	{
		type: "function",
		name: "finish",
		description: "Finish the current stage.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		strict: true,
	},
] as const satisfies readonly CanonicalToolSchema[];

const authorization = {
	builder: ["shell", "finish"],
	planner: [],
	shaper: ["shell"],
	auditor: [],
	reviewer: [],
	context: [],
} as const;

function sessionInput(
	overrides: Partial<CreateSessionInput> = {},
): CreateSessionInput {
	return {
		runDirectory: "/tmp/kogen-runs/run-a",
		provider: "chatgpt",
		authMode: "injected",
		role: "builder",
		model: "gpt-6-luna",
		effort: "max",
		stage: "develop",
		roleInstructions: "You are Kogen's builder.",
		genericInstructions: "Follow the shared Kogen request protocol.",
		toolSchemas: schemas,
		toolSchemaVersion: "tools-v1",
		promptVersion: "prompt-v1",
		adapterVersion: "responses-v1",
		roleToolAuthorization: authorization,
		...overrides,
	};
}

function text(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

test("run affinity and conversation identities survive reconstruction and separate tuple changes", () => {
	const runDirectory = "/tmp/kogen-runs/run-a";
	const first = deriveCacheKey(runDirectory);
	const restarted = deriveCacheKey(runDirectory);
	expect(first).toBe(restarted);
	expect(first).toMatch(/^[a-f0-9]{64}$/);
	expect(deriveProtocolSessionId(runDirectory)).toBe(
		deriveProtocolSessionId(runDirectory),
	);
	const identity = {
		runDirectory,
		stage: "develop",
		attempt: "builder",
		rung: "R1",
		epoch: "initial",
	};
	const thread = deriveThreadId(identity);
	expect(deriveThreadId(identity)).toBe(thread);
	expect(deriveThreadId({ ...identity, stage: "plan" })).not.toBe(thread);
	expect(deriveThreadId({ ...identity, attempt: "fresh-1" })).not.toBe(thread);
	expect(deriveThreadId({ ...identity, rung: "R2" })).not.toBe(thread);
	expect(deriveThreadId({ ...identity, epoch: "mutation-advice" })).not.toBe(
		thread,
	);
	expect(deriveCacheKey("/tmp/kogen-runs/run-b")).not.toBe(first);
});

test("three appended requests keep the exact raw-byte prefix and retries are identical", () => {
	let state = createSession(sessionInput());
	state = stepSession(state, {
		type: "append_items",
		items: [
			{
				bytes: encoder.encode(
					'{"role":"user","content":[{"type":"input_text","text":"task"}]}',
				),
				kind: "message",
			},
		],
	});
	const first = encodeSessionRequest(state);
	const retry = encodeSessionRequest(stepSession(state, { type: "retry" }));
	expect(retry.body).toEqual(first.body);
	expect(retry.bodySha256).toBe(first.bodySha256);
	expect(text(first.body).endsWith("]}")).toBe(true);
	expect(text(first.body).lastIndexOf('"input":[')).toBeGreaterThan(0);

	state = stepSession(state, {
		type: "append_turn",
		responseItems: [
			encoder.encode(
				'{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"checking"}]}',
			),
		],
		toolResults: [{ callId: "call_1", output: "exit 0" }],
		userNotes: ["The controller check completed."],
	});
	const second = encodeSessionRequest(state);
	expect(hasAppendedInputPrefix(first.body, second.body)).toBe(true);
	expect(second.body.subarray(0, first.body.byteLength - 2)).toEqual(
		first.body.subarray(0, first.body.byteLength - 2),
	);

	state = stepSession(state, {
		type: "append_turn",
		responseItems: [
			encoder.encode(
				'{"id":"msg_2","type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}',
			),
		],
	});
	const third = encodeSessionRequest(state);
	expect(hasAppendedInputPrefix(second.body, third.body)).toBe(true);
	const input = third.inputItems.map(text);
	expect(input[0]).toContain("You are Kogen's builder.");
	expect(input[1]).toContain('"text":"task"');
	expect(input[2]).toContain('"id":"msg_1"');
	expect(input[3]).toContain('"call_id":"call_1"');
	expect(input[4]).toContain("The controller check completed.");
	expect(input[5]).toContain('"id":"msg_2"');
});

test("history copies raw items on append and on read", () => {
	const raw = encoder.encode('{ "type" : "message", "id" : "raw" }');
	const original = raw.slice();
	const state = stepSession(createSession(sessionInput()), {
		type: "append_items",
		items: [{ bytes: raw, kind: "response" }],
	});
	raw.fill(0);
	const read = state.history.itemBytes()[0];
	expect(read).toEqual(original);
	read?.fill(0);
	expect(state.history.itemBytes()[0]).toEqual(original);
});

test("owned requests keep complete schemas in input and tool-less roles disable calls", () => {
	const state = createSession(
		sessionInput({
			role: "planner",
			authMode: "owned",
			roleInstructions: "You are Kogen's planner.",
		}),
	);
	const request = encodeSessionRequest(state);
	const body = JSON.parse(text(request.body)) as Record<string, unknown>;
	expect(body.tools).toBeUndefined();
	expect(body.include).toBeUndefined();
	expect(body.tool_choice).toBe("none");
	expect(body.input).toEqual([
		{
			role: "developer",
			tools: schemas,
			type: "additional_tools",
		},
		{
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "You are Kogen's planner." }],
		},
	]);
	expect(body.prompt_cache_key).toBe(state.cacheKey);
	expect(request.headers["session-id"]).toBe(state.cacheKey);
	expect(request.headers["thread-id"]).toBe(state.threadId);
	expect(state.prefix.toolNames).toEqual(["shell", "finish"]);
});

test("injected requests expose full schemas but authorize only the selected role", () => {
	const request = encodeSessionRequest(createSession(sessionInput()));
	const body = JSON.parse(text(request.body)) as Record<string, unknown>;
	expect(body.tools).toEqual(schemas);
	expect(body.include).toEqual(["reasoning.encrypted_content"]);
	expect(body.tool_choice).toEqual({
		type: "allowed_tools",
		mode: "auto",
		tools: [
			{ type: "function", name: "shell" },
			{ type: "function", name: "finish" },
		],
	});
	expect(body.prompt_cache_key).toBe(request.headers["session-id"]);
	const toolLess = encodeSessionRequest(
		createSession(
			sessionInput({
				role: "auditor",
				roleInstructions: "You are Kogen's auditor.",
			}),
		),
	);
	const toolLessBody = JSON.parse(text(toolLess.body)) as Record<
		string,
		unknown
	>;
	expect(toolLessBody.tools).toEqual(schemas);
	expect(toolLessBody.tool_choice).toBe("none");
});

test("model switch preserves thread and nonreasoning bytes while dropping prior encrypted reasoning", () => {
	let state = createSession(sessionInput());
	const originalThread = state.threadId;
	const rawReasoning = encoder.encode(
		'{"id":"rsn_1","type":"reasoning","encrypted_content":"cipher","summary":[]}',
	);
	const rawMessage = encoder.encode(
		'{"id":"msg_1","type":"message","role":"assistant","content":[]}',
	);
	state = stepSession(state, {
		type: "append_turn",
		responseItems: [rawReasoning, rawMessage],
	});
	state = stepSession(state, {
		type: "model_switch",
		model: "gpt-6.1-sol",
		effort: "medium",
	});
	expect(state.threadId).toBe(originalThread);
	expect(state.history.length).toBe(1);
	expect(state.history.itemBytes()[0]).toEqual(rawMessage);
	const body = JSON.parse(text(encodeSessionRequest(state).body)) as Record<
		string,
		unknown
	>;
	expect(body.model).toBe("gpt-6.1-sol");
	expect(body.reasoning).toEqual({ effort: "medium", summary: "auto" });
});

test("separate Shape and Build runs retain byte-identical versioned static prefixes", () => {
	const registry = new StaticPrefixRegistry();
	const shape = createSession(
		sessionInput({
			runDirectory: "/tmp/kogen-runs/shape-a",
			stage: "shape",
			role: "shaper",
			roleInstructions: "You are Kogen's shaper.",
			prefixRegistry: registry,
		}),
	);
	const build = createSession(
		sessionInput({
			runDirectory: "/tmp/kogen-runs/build-b",
			stage: "develop",
			roleInstructions: "You are Kogen's builder.",
			prefixRegistry: registry,
		}),
	);
	expect(shape.prefix.bytes).toEqual(build.prefix.bytes);
	expect(shape.prefix.sha256).toBe(build.prefix.sha256);
	expect(shape.cacheKey).not.toBe(build.cacheKey);
	expect(shape.threadId).not.toBe(build.threadId);
	expect(encodeSessionRequest(shape).staticPrefixSha256).toBe(
		encodeSessionRequest(build).staticPrefixSha256,
	);
});

test("same prefix version rejects changed generic instructions or schemas", () => {
	const registry = new StaticPrefixRegistry();
	const base = {
		version: {
			provider: "chatgpt" as const,
			model: "gpt-6-luna",
			adapterVersion: "responses-v1",
			promptVersion: "prompt-v1",
			toolSchemaVersion: "tools-v1",
		},
		genericInstructions: "The same shared instructions.",
		toolSchemas: schemas,
	};
	new StaticPrefix(base, registry);
	const restored = StaticPrefixRegistry.fromEntries(registry.serialize());
	new StaticPrefix(base, restored);
	expect(
		() =>
			new StaticPrefix(
				{ ...base, genericInstructions: "A timestamp was added." },
				restored,
			),
	).toThrow("Static prefix bytes changed");
	const alteredSchemas = [
		{ ...schemas[0], description: "Changed under the same version." },
		schemas[1],
	] satisfies readonly CanonicalToolSchema[];
	expect(
		() => new StaticPrefix({ ...base, toolSchemas: alteredSchemas }, restored),
	).toThrow("Static prefix bytes changed");
	const sparse: unknown[] = [];
	sparse.length = 1;
	expect(() => canonicalJsonBytes(sparse)).toThrow("sparse or decorated");
	const accessor: unknown[] = [];
	Object.defineProperty(accessor, "0", {
		get: () => "unstable",
		enumerable: true,
	});
	expect(() => canonicalJsonBytes(accessor)).toThrow("accessors");
});

test("fallback_shaper uses shaper authorization and model switches stay provider-local", () => {
	const fallback = createSession(
		sessionInput({
			role: "fallback_shaper",
			roleInstructions: "You are Kogen's fallback shaper.",
		}),
	);
	expect(fallback.effectiveRole).toBe("shaper");
	expect(fallback.authorizedTools).toEqual(["shell"]);
	expect(() =>
		stepSession(fallback, {
			type: "model_switch",
			model: "grok-4.6",
			effort: "high",
		}),
	).toThrow("does not belong to chatgpt");
	expect(() =>
		createSession(
			sessionInput({
				roleToolAuthorization: { ...authorization, builder: ["unknown"] },
			}),
		),
	).toThrow("unknown schema");
});

test("checkpoint starts a new epoch and rejects a missing continuation marker", () => {
	const approvedRequest = encoder.encode(
		'{"role":"user","content":[{"type":"input_text","text":"Approved request"}]}',
	);
	const plan = encoder.encode(
		'{"role":"user","content":[{"type":"input_text","text":"Plan"}]}',
	);
	let state = createSession(
		sessionInput({
			initialItems: [
				{ bytes: approvedRequest, kind: "message" },
				{ bytes: plan, kind: "message" },
			],
		}),
	);
	state = stepSession(state, {
		type: "append_items",
		items: [
			{
				bytes: encoder.encode('{"role":"user","content":[]}'),
				kind: "message",
			},
		],
	});
	const oldCacheKey = state.cacheKey;
	const oldThread = state.threadId;
	const item = canonicalJsonBytes({
		role: "user",
		content: [
			{
				type: "input_text",
				text: "Continuation of the same approved Build.\n\nUse this summary.",
			},
		],
	});
	state = stepSession(state, {
		type: "accept_checkpoint",
		turn: 12,
		item: { bytes: item, kind: "user_note" },
	});
	expect(state.cacheKey).toBe(oldCacheKey);
	expect(state.threadId).not.toBe(oldThread);
	expect(state.history.length).toBe(3);
	expect(state.history.itemBytes()).toEqual([approvedRequest, plan, item]);
	expect(() =>
		stepSession(state, {
			type: "accept_checkpoint",
			turn: 13,
			item: { bytes: canonicalJsonBytes({ role: "user", text: "summary" }) },
		}),
	).toThrow("continuation marker");
});
