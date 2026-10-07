import { createHash } from "node:crypto";
import { StickyRoutingContext } from "../http/routing";
import { developerMessageBytes } from "./history";
import { canonicalJson } from "./prefix";
import type { SessionState } from "./transition";

export interface EncodeSessionRequestOptions {
	readonly headers?: Readonly<Record<string, string>>;
	readonly maxOutputTokens?: number;
}

export interface EncodedSessionRequest {
	readonly body: Uint8Array;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodySha256: string;
	readonly staticPrefixSha256: string;
	readonly headerNames: readonly string[];
	readonly inputItems: readonly Uint8Array[];
}

const encoder = new TextEncoder();

function jsonField(name: string, value: unknown): string {
	return `${JSON.stringify(name)}:${canonicalJson(value)}`;
}

function inputItems(state: SessionState): readonly Uint8Array[] {
	const items: Uint8Array[] = [];
	if (state.provider === "chatgpt" && state.authMode === "owned") {
		items.push(
			encoder.encode(
				`{"role":"developer","tools":${state.prefix.toolSchemasJson},"type":"additional_tools"}`,
			),
		);
	}
	items.push(developerMessageBytes(state.roleInstructions));
	items.push(...state.history.itemBytes());
	return Object.freeze(items.map((item) => item.slice()));
}

function allowedToolChoice(state: SessionState): unknown {
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

function reasoningControl(state: SessionState): unknown {
	if (state.provider === "grok") return { effort: state.effort };
	if (state.model === "gpt-6-luna") return { effort: state.effort };
	return { effort: state.effort, summary: "auto" };
}

function bodyPrefix(
	state: SessionState,
	options: EncodeSessionRequestOptions,
): string {
	const fields: string[] = [
		jsonField("model", state.model),
		jsonField("instructions", state.prefix.genericInstructions),
	];
	if (state.provider === "grok" || state.authMode === "injected")
		fields.push(`"tools":${state.prefix.toolSchemasJson}`);
	fields.push(jsonField("reasoning", reasoningControl(state)));
	fields.push(jsonField("store", false), jsonField("stream", true));
	if (state.provider === "grok" || state.authMode === "injected")
		fields.push(jsonField("include", ["reasoning.encrypted_content"]));
	fields.push(jsonField("prompt_cache_key", state.cacheKey));
	fields.push(
		jsonField("tool_choice", allowedToolChoice(state)),
		jsonField("parallel_tool_calls", false),
	);
	if (state.provider === "chatgpt" && state.model === "gpt-6-luna")
		fields.push(jsonField("text", { verbosity: "low" }));
	if (options.maxOutputTokens !== undefined) {
		if (
			!Number.isSafeInteger(options.maxOutputTokens) ||
			options.maxOutputTokens <= 0
		)
			throw new TypeError("maxOutputTokens must be a positive safe integer.");
		fields.push(jsonField("max_output_tokens", options.maxOutputTokens));
	}
	return `{${fields.join(",")},"input":[`;
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

function encodeInputItems(items: readonly Uint8Array[]): Uint8Array {
	const segments: Uint8Array[] = [];
	items.forEach((item, index) => {
		if (index > 0) segments.push(encoder.encode(","));
		segments.push(item);
	});
	return concatenate(segments);
}

function sessionHeaders(
	state: SessionState,
	baseHeaders: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const routing = new StickyRoutingContext(
		state.provider,
		{
			cacheKey: state.cacheKey,
			threadId: state.threadId,
		},
		"responses",
	);
	const initial: Record<string, string> = {
		"content-type": "application/json",
		accept: "text/event-stream",
	};
	for (const [name, value] of Object.entries(baseHeaders))
		initial[name] = value;
	return routing.applyTo(initial);
}

/** Serialize one request while retaining every history item's exact bytes. */
export function encodeSessionRequest(
	state: SessionState,
	options: EncodeSessionRequestOptions = {},
): EncodedSessionRequest {
	const items = inputItems(state);
	const prefix = encoder.encode(bodyPrefix(state, options));
	const input = encodeInputItems(items);
	const suffix = encoder.encode("]}");
	const body = concatenate([prefix, input, suffix]);
	const headers = sessionHeaders(state, options.headers ?? {});
	const bodySha256 = createHash("sha256").update(body).digest("hex");
	const headerNames = Object.freeze(
		Object.keys(headers).sort((left, right) =>
			left < right ? -1 : left > right ? 1 : 0,
		),
	);
	return Object.freeze({
		body,
		headers,
		bodySha256,
		staticPrefixSha256: state.prefix.sha256,
		headerNames,
		inputItems: Object.freeze(items.map((item) => item.slice())),
	});
}

/** Byte-level helper used by receipts and tests; no decoded history is involved. */
export function hasAppendedInputPrefix(
	previousBody: Uint8Array,
	nextBody: Uint8Array,
): boolean {
	if (previousBody.byteLength < 2) return false;
	const previousPrefix = previousBody.subarray(0, previousBody.byteLength - 2);
	if (nextBody.byteLength <= previousPrefix.byteLength) return false;
	for (let index = 0; index < previousPrefix.byteLength; index += 1)
		if (previousPrefix[index] !== nextBody[index]) return false;
	return nextBody[previousPrefix.byteLength] === 0x2c;
}
