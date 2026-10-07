import { type CanonicalJsonValue, canonicalJsonBytes } from "./prefix";

export type SessionItemKind =
	| "response"
	| "reasoning"
	| "tool_result"
	| "user_note"
	| "message";

export interface SessionItemInput {
	readonly bytes: Uint8Array;
	readonly kind?: SessionItemKind;
	readonly model?: string;
	readonly encrypted?: boolean;
}

export interface ToolResultInput {
	readonly callId: string;
	readonly output: string;
}

interface StoredSessionItem {
	readonly bytes: Uint8Array;
	readonly kind: SessionItemKind;
	readonly model: string | null;
	readonly encrypted: boolean;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function validateItemBytes(bytes: Uint8Array): void {
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
		throw new TypeError("Session item bytes must be a nonempty Uint8Array.");
	let value: unknown;
	try {
		value = JSON.parse(decoder.decode(bytes));
	} catch (cause) {
		throw new TypeError("Session item must be valid UTF-8 JSON.", { cause });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("Session item must be a JSON object.");
}

function storeItem(input: SessionItemInput): StoredSessionItem {
	validateItemBytes(input.bytes);
	if (
		input.model !== undefined &&
		(input.model.length === 0 || /[\r\n\0]/.test(input.model))
	)
		throw new TypeError("Session item model is invalid.");
	return Object.freeze({
		bytes: input.bytes.slice(),
		kind: input.kind ?? "response",
		model: input.model ?? null,
		encrypted: input.encrypted ?? false,
	});
}

function classifyResponseItem(
	bytes: Uint8Array,
	model: string,
): StoredSessionItem {
	validateItemBytes(bytes);
	const parsed = JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
	const encryptedReasoning =
		parsed.type === "reasoning" && typeof parsed.encrypted_content === "string";
	return storeItem({
		bytes,
		kind: encryptedReasoning ? "reasoning" : "response",
		model,
		encrypted: encryptedReasoning,
	});
}

function validateCallId(callId: string): void {
	if (
		typeof callId !== "string" ||
		callId.length === 0 ||
		/[\r\n\0]/.test(callId)
	)
		throw new TypeError("Tool result call id is invalid.");
}

/**
 * Immutable append-only history. Inputs are copied at the boundary and every
 * read returns fresh bytes so callers cannot mutate an already-recorded item.
 */
export class SessionHistory {
	private constructor(private readonly entries: readonly StoredSessionItem[]) {}

	static empty(): SessionHistory {
		return new SessionHistory(Object.freeze([]));
	}

	static fromItems(items: readonly SessionItemInput[]): SessionHistory {
		return new SessionHistory(Object.freeze(items.map(storeItem)));
	}

	get length(): number {
		return this.entries.length;
	}

	append(items: readonly SessionItemInput[]): SessionHistory {
		if (items.length === 0) return this;
		return new SessionHistory(
			Object.freeze([...this.entries, ...items.map(storeItem)]),
		);
	}

	/** Appends provider items, call results, then controller/user notes in order. */
	appendTurn(input: {
		readonly responseItems: readonly Uint8Array[];
		readonly model: string;
		readonly toolResults?: readonly ToolResultInput[];
		readonly userNotes?: readonly string[];
	}): SessionHistory {
		const additions: StoredSessionItem[] = input.responseItems.map((item) =>
			classifyResponseItem(item, input.model),
		);
		for (const result of input.toolResults ?? []) {
			validateCallId(result.callId);
			additions.push(
				storeItem({
					bytes: canonicalJsonBytes({
						type: "function_call_output",
						call_id: result.callId,
						output: result.output,
					}),
					kind: "tool_result",
				}),
			);
		}
		for (const note of input.userNotes ?? [])
			additions.push(
				storeItem({ bytes: userMessageBytes(note), kind: "user_note" }),
			);
		if (additions.length === 0) return this;
		return new SessionHistory(Object.freeze([...this.entries, ...additions]));
	}

	/** Keep old raw bytes except encrypted reasoning tied to a different model. */
	withoutEncryptedReasoningFromOtherModels(model: string): SessionHistory {
		const retained = this.entries.filter(
			(item) =>
				!(item.kind === "reasoning" && item.encrypted && item.model !== model),
		);
		if (retained.length === this.entries.length) return this;
		return new SessionHistory(Object.freeze(retained));
	}

	itemBytes(): readonly Uint8Array[] {
		return Object.freeze(this.entries.map((item) => item.bytes.slice()));
	}

	snapshotItems(): readonly SessionItemInput[] {
		return Object.freeze(
			this.entries.map((item) =>
				Object.freeze({
					bytes: item.bytes.slice(),
					kind: item.kind,
					...(item.model === null ? {} : { model: item.model }),
					encrypted: item.encrypted,
				}),
			),
		);
	}

	metadata(): readonly Readonly<{
		kind: SessionItemKind;
		model: string | null;
		encrypted: boolean;
	}>[] {
		return Object.freeze(
			this.entries.map((item) =>
				Object.freeze({
					kind: item.kind,
					model: item.model,
					encrypted: item.encrypted,
				}),
			),
		);
	}
}

export function responseItemBytes(value: CanonicalJsonValue): Uint8Array {
	return canonicalJsonBytes(value);
}

export function userMessageBytes(text: string): Uint8Array {
	if (typeof text !== "string")
		throw new TypeError("Message text must be a string.");
	return canonicalJsonBytes({
		role: "user",
		content: [{ type: "input_text", text }],
	});
}

export function developerMessageBytes(text: string): Uint8Array {
	if (typeof text !== "string" || text.length === 0)
		throw new TypeError("Developer message must be nonempty text.");
	return canonicalJsonBytes({
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text }],
	});
}
