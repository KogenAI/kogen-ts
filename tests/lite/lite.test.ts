import { expect, test } from "bun:test";
import type { Result } from "../../packages/core/src/contracts/errors";
import type { LiteRequestEffects } from "../../packages/core/src/provider/lite/adapter";
import {
	encodeLiteRequest,
	executeLiteRequest,
} from "../../packages/core/src/provider/lite/adapter";
import {
	CHATGPT_RESPONSES_ENDPOINT,
	type ChatGptRequestPolicy,
	LITE_UNSUPPORTED_MESSAGE,
	loadCredentialsAfterCompatibilityCheck,
	MODEL_GENERATION_CAP_UNSUPPORTED_MESSAGE,
} from "../../packages/core/src/provider/lite/capabilities";
import type { CreateSessionInput } from "../../packages/core/src/provider/session/transition";
import {
	createSession,
	stepSession,
} from "../../packages/core/src/provider/session/transition";

const decoder = new TextDecoder("utf-8", { fatal: true });

const schemas = [
	{
		type: "function",
		name: "read",
		description: "Read a file.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
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
] as const;

const roleToolAuthorization = {
	builder: ["read", "finish"],
	planner: [],
	shaper: ["read"],
	auditor: [],
	reviewer: [],
	context: [],
} as const;

function createLiteSession(overrides: Partial<CreateSessionInput> = {}) {
	const input: CreateSessionInput = {
		runDirectory: "/tmp/kogen-runs/lite-a",
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
		adapterVersion: "lite-v1",
		roleToolAuthorization,
		...overrides,
	};
	return createSession(input);
}

function bytes(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

function object(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("Expected an object.");
	return value as Record<string, unknown>;
}

interface TestEffectError {
	readonly class: "test";
	readonly message: string;
}

test("P6 Lite uses the injected Luna shape and deterministic leading input items", () => {
	const session = createLiteSession();
	const encoded = encodeLiteRequest({
		session,
		endpoint: "https://chatgpt.com/backend-api/codex/responses",
	});
	expect(encoded.ok).toBe(true);
	if (!encoded.ok) return;

	const request = encoded.value;
	const body = object(JSON.parse(bytes(request.body)) as unknown);
	expect(Object.keys(body)).toEqual([
		"model",
		"instructions",
		"reasoning",
		"store",
		"stream",
		"include",
		"prompt_cache_key",
		"tool_choice",
		"parallel_tool_calls",
		"text",
		"input",
	]);
	expect(body.model).toBe("gpt-6-luna");
	expect(body.instructions).toBe("");
	expect(body.tools).toBeUndefined();
	expect(body.previous_response_id).toBeUndefined();
	expect(body.session_id).toBeUndefined();
	expect(body.include).toEqual(["reasoning.encrypted_content"]);
	expect(body.reasoning).toEqual({ context: "all_turns", effort: "max" });
	expect(body.prompt_cache_key).toBe(session.cacheKey);
	expect(body.text).toEqual({ verbosity: "low" });

	const input = body.input as unknown[];
	expect(input).toHaveLength(3);
	const toolsItem = object(input[0]);
	expect(toolsItem.type).toBe("additional_tools");
	expect(toolsItem.role).toBe("developer");
	expect(toolsItem.tools).toEqual(schemas);
	expect(toolsItem.id).toMatch(/^kogen_[a-f0-9]{64}$/);
	const sharedInstructions = object(input[1]);
	const roleInstructions = object(input[2]);
	expect(sharedInstructions.id).toMatch(/^kogen_[a-f0-9]{64}$/);
	expect(roleInstructions.id).toMatch(/^kogen_[a-f0-9]{64}$/);
	expect(sharedInstructions.content).toEqual([
		{ type: "input_text", text: "Follow the shared Kogen request protocol." },
	]);
	expect(roleInstructions.content).toEqual([
		{ type: "input_text", text: "You are Kogen's builder." },
	]);
	expect(request.headers["x-openai-internal-codex-responses-lite"]).toBe(
		"true",
	);
	expect(request.headers.session_id).toBe(session.protocolSessionId);
	expect(request.headers["thread-id"]).toBe(session.threadId);
	expect(request.headers["session-id"]).toBeUndefined();
});

test("Lite affinity and protocol session identity stay stable as the thread changes", () => {
	const firstSession = createLiteSession();
	const nextSession = stepSession(firstSession, {
		type: "start_conversation",
		stage: "verify",
		attempt: "builder",
		rung: "R1",
	});
	const first = encodeLiteRequest({
		session: firstSession,
		endpoint: "https://chatgpt.com/backend-api/codex/responses",
	});
	const next = encodeLiteRequest({
		session: nextSession,
		endpoint: "https://chatgpt.com/backend-api/codex/responses",
	});
	expect(first.ok).toBe(true);
	expect(next.ok).toBe(true);
	if (!first.ok || !next.ok) return;

	expect(next.value.cacheKey).toBe(first.value.cacheKey);
	expect(next.value.protocolSessionId).toBe(first.value.protocolSessionId);
	expect(next.value.threadId).not.toBe(first.value.threadId);
	expect(next.value.headers.session_id).toBe(first.value.headers.session_id);
	expect(next.value.headers["thread-id"]).not.toBe(
		first.value.headers["thread-id"],
	);
	expect(
		object(JSON.parse(bytes(next.value.body)) as unknown).prompt_cache_key,
	).toBe(first.value.cacheKey);

	const repeat = encodeLiteRequest({
		session: firstSession,
		endpoint: "https://chatgpt.com/backend-api/codex/responses",
	});
	expect(repeat.ok).toBe(true);
	if (!repeat.ok) return;
	expect(repeat.value.body).toEqual(first.value.body);
	expect(repeat.value.inputItems).toEqual(first.value.inputItems);
});

test("owned login, non-Luna models, and Lite generation caps reject before credentials", async () => {
	let credentialReads = 0;
	let sends = 0;
	const effects: LiteRequestEffects<string, string, TestEffectError> = {
		loadCredentials: async () => {
			credentialReads += 1;
			return { ok: true as const, value: "credential" };
		},
		send: async () => {
			sends += 1;
			return { ok: true as const, value: "sent" };
		},
	};

	const owned = await executeLiteRequest(
		{
			session: createLiteSession({ authMode: "owned" }),
			endpoint: "https://api.openai.com/v1/responses",
		},
		effects,
	);
	expect(owned.ok).toBe(false);
	if (!owned.ok) {
		expect(owned.error.class).toBe("unsupported");
		expect(owned.error.message).toBe(LITE_UNSUPPORTED_MESSAGE);
	}

	const nonLuna = await executeLiteRequest(
		{
			session: createLiteSession({ model: "gpt-6.1-sol" }),
			endpoint: "https://api.openai.com/v1/responses",
		},
		effects,
	);
	expect(nonLuna.ok).toBe(false);
	if (!nonLuna.ok) expect(nonLuna.error.message).toBe(LITE_UNSUPPORTED_MESSAGE);

	const capped = await executeLiteRequest(
		{
			session: createLiteSession(),
			endpoint: "https://api.openai.com/v1/responses",
			modelGenerationTokens: 4096,
		},
		effects,
	);
	expect(capped.ok).toBe(false);
	if (!capped.ok) expect(capped.error.message).toBe(LITE_UNSUPPORTED_MESSAGE);
	expect(credentialReads).toBe(0);
	expect(sends).toBe(0);
});

test("unknown endpoint generation caps need an exact explicit capability", async () => {
	const endpoint = "https://provider.example/v1/responses";
	const policy: ChatGptRequestPolicy = {
		mode: "responses",
		provider: "chatgpt",
		authMode: "injected",
		model: "gpt-6-luna",
		endpoint,
		modelGenerationTokens: 2048,
	};
	let credentialReads = 0;
	const load: () => Promise<Result<string, TestEffectError>> = async () => {
		credentialReads += 1;
		return { ok: true as const, value: "credential" };
	};

	const unknown = await loadCredentialsAfterCompatibilityCheck(policy, load);
	expect(unknown.ok).toBe(false);
	if (!unknown.ok) {
		expect(unknown.error.class).toBe("unsupported");
		expect(unknown.error.message).toBe(
			MODEL_GENERATION_CAP_UNSUPPORTED_MESSAGE,
		);
	}
	expect(credentialReads).toBe(0);

	const mismatchedDeclaration = await loadCredentialsAfterCompatibilityCheck(
		{
			...policy,
			endpointCapabilities: {
				endpoint: "https://other.example/v1/responses",
				modelGenerationTokens: true,
			},
		},
		load,
	);
	expect(mismatchedDeclaration.ok).toBe(false);
	expect(credentialReads).toBe(0);

	const declared = await loadCredentialsAfterCompatibilityCheck(
		{
			...policy,
			endpointCapabilities: { endpoint, modelGenerationTokens: true },
		},
		load,
	);
	expect(declared).toEqual({ ok: true, value: "credential" });
	expect(credentialReads).toBe(1);

	const canonical = await loadCredentialsAfterCompatibilityCheck(
		{ ...policy, endpoint: CHATGPT_RESPONSES_ENDPOINT },
		load,
	);
	expect(canonical.ok).toBe(true);
	expect(credentialReads).toBe(2);
});
