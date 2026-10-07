import { createHash } from "node:crypto";
import type { Result } from "../../contracts/errors";
import type { AccountProvider } from "../accounts/format";
import { StickyRoutingContext } from "../http/routing";
import { canonicalJson } from "../session/prefix";
import type { SessionState } from "../session/transition";
import {
	type AdapterCompatibilityError,
	type EndpointCapabilities,
	loadCredentialsAfterCompatibilityCheck,
	validateChatGptRequestPolicy,
} from "./capabilities";

export interface LiteRequestInput {
	readonly session: SessionState;
	readonly endpoint: string;
	readonly endpointCapabilities?: EndpointCapabilities;
	readonly modelGenerationTokens?: number;
}

export interface EncodedLiteRequest {
	readonly endpoint: string;
	readonly body: Uint8Array;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodySha256: string;
	readonly headerNames: readonly string[];
	readonly inputItems: readonly Uint8Array[];
	readonly cacheKey: string;
	readonly threadId: string;
	readonly protocolSessionId: string;
}

const encoder = new TextEncoder();

function jsonField(name: string, value: unknown): string {
	return `${JSON.stringify(name)}:${canonicalJson(value)}`;
}

function deterministicItemId(kind: string, bytes: Uint8Array): string {
	const hash = createHash("sha256")
		.update("kogen:responses:lite-item:v1\0", "utf8")
		.update(kind, "utf8")
		.update("\0", "utf8")
		.update(bytes)
		.digest("hex");
	return `kogen_${hash}`;
}

function developerItem(text: string, kind: string): Uint8Array {
	const content = encoder.encode(text);
	const item = {
		id: deterministicItemId(kind, content),
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text }],
	};
	return encoder.encode(canonicalJson(item));
}

function inputItems(state: SessionState): readonly Uint8Array[] {
	const toolBytes = encoder.encode(state.prefix.toolSchemasJson);
	const additionalTools = encoder.encode(
		canonicalJson({
			id: deterministicItemId("additional_tools", toolBytes),
			role: "developer",
			tools: state.prefix.toolSchemas,
			type: "additional_tools",
		}),
	);
	return Object.freeze([
		additionalTools,
		developerItem(state.prefix.genericInstructions, "shared_instructions"),
		developerItem(state.roleInstructions, "role_instructions"),
		...state.history.itemBytes(),
	]);
}

function toolChoice(state: SessionState): unknown {
	if (state.authorizedTools.length === 0) return "none";
	return {
		type: "allowed_tools",
		mode: "auto",
		tools: state.authorizedTools.map((name) => ({
			type: "function",
			name,
		})),
	};
}

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
	const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function encodeItems(items: readonly Uint8Array[]): Uint8Array {
	const parts: Uint8Array[] = [];
	items.forEach((item, index) => {
		if (index > 0) parts.push(encoder.encode(","));
		parts.push(item);
	});
	return concatenate(parts);
}

function createHeaders(state: SessionState): Readonly<Record<string, string>> {
	const routing = new StickyRoutingContext(
		"chatgpt",
		{
			cacheKey: state.cacheKey,
			threadId: state.threadId,
			protocolSessionId: state.protocolSessionId,
		},
		"lite",
	);
	const headers: Record<string, string> = Object.create(null);
	headers.accept = "text/event-stream";
	headers["content-type"] = "application/json";
	headers["x-openai-internal-codex-responses-lite"] = "true";
	return routing.applyTo(headers);
}

function encodeBody(
	state: SessionState,
	items: readonly Uint8Array[],
): Uint8Array {
	const fields = [
		jsonField("model", state.model),
		jsonField("instructions", ""),
		jsonField("reasoning", { effort: state.effort, context: "all_turns" }),
		jsonField("store", false),
		jsonField("stream", true),
		jsonField("include", ["reasoning.encrypted_content"]),
		jsonField("prompt_cache_key", state.cacheKey),
		jsonField("tool_choice", toolChoice(state)),
		jsonField("parallel_tool_calls", false),
		jsonField("text", { verbosity: "low" }),
	];
	const prefix = encoder.encode(`{${fields.join(",")},"input":[`);
	return concatenate([prefix, encodeItems(items), encoder.encode("]}")]);
}

/** Build the injected Luna Lite wire request without performing any effects. */
export function encodeLiteRequest(
	input: LiteRequestInput,
): Result<EncodedLiteRequest, AdapterCompatibilityError> {
	const state = input.session;
	const compatible = validateChatGptRequestPolicy({
		mode: "lite",
		provider: state.provider as AccountProvider,
		authMode: state.authMode,
		model: state.model,
		endpoint: input.endpoint,
		...(input.modelGenerationTokens === undefined
			? {}
			: { modelGenerationTokens: input.modelGenerationTokens }),
		...(input.endpointCapabilities === undefined
			? {}
			: { endpointCapabilities: input.endpointCapabilities }),
	});
	if (!compatible.ok) return compatible;

	const items = inputItems(state);
	const body = encodeBody(state, items);
	const headers = createHeaders(state);
	const bodySha256 = createHash("sha256").update(body).digest("hex");
	const headerNames = Object.freeze(
		Object.keys(headers).sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		),
	);
	return {
		ok: true,
		value: Object.freeze({
			endpoint: input.endpoint,
			body,
			headers,
			bodySha256,
			headerNames,
			inputItems: Object.freeze(items.map((item) => item.slice())),
			cacheKey: state.cacheKey,
			threadId: state.threadId,
			protocolSessionId: state.protocolSessionId,
		}),
	};
}

export interface LiteRequestEffects<Credential, Value, Error> {
	readonly loadCredentials: () => Promise<Result<Credential, Error>>;
	readonly send: (
		request: EncodedLiteRequest,
		credential: Credential,
	) => Promise<Result<Value, Error>>;
}

/** Reject incompatible Lite requests before the credential effect is called. */
export async function executeLiteRequest<Credential, Value, Error>(
	input: LiteRequestInput,
	effects: LiteRequestEffects<Credential, Value, Error>,
): Promise<Result<Value, Error | AdapterCompatibilityError>> {
	const request = encodeLiteRequest(input);
	if (!request.ok) return request;
	const credentials = await loadCredentialsAfterCompatibilityCheck(
		{
			mode: "lite",
			provider: input.session.provider,
			authMode: input.session.authMode,
			model: input.session.model,
			endpoint: input.endpoint,
			...(input.modelGenerationTokens === undefined
				? {}
				: { modelGenerationTokens: input.modelGenerationTokens }),
			...(input.endpointCapabilities === undefined
				? {}
				: { endpointCapabilities: input.endpointCapabilities }),
		},
		effects.loadCredentials,
	);
	if (!credentials.ok) return credentials;
	return effects.send(request.value, credentials.value);
}
