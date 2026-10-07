export type RoutingProvider = "chatgpt" | "grok";
export type RoutingMode = "responses" | "lite";

export interface StickyRoutingIdentity {
	readonly cacheKey: string | null;
	readonly threadId: string | null;
	readonly protocolSessionId?: string | null;
}

/**
 * Persistent routing identity for a run/conversation. Reuse one instance for
 * retries and turns; change only the thread when starting a new conversation.
 */
export class StickyRoutingContext {
	private threadIdValue: string | null;
	private readonly cacheKey: string | null;
	private readonly protocolSessionId: string | null;

	constructor(
		readonly provider: RoutingProvider,
		identity: StickyRoutingIdentity,
		readonly mode: RoutingMode = "responses",
	) {
		if (provider !== "chatgpt" && provider !== "grok")
			throw new TypeError("Routing provider is unsupported.");
		if (mode !== "responses" && mode !== "lite")
			throw new TypeError("Routing mode is unsupported.");
		if (provider === "grok" && mode !== "responses")
			throw new TypeError("Grok does not support Lite routing.");
		this.cacheKey = validateOptionalRoutingId(identity.cacheKey, "cacheKey");
		this.threadIdValue = validateOptionalRoutingId(
			identity.threadId,
			"threadId",
		);
		this.protocolSessionId = validateOptionalRoutingId(
			identity.protocolSessionId ?? null,
			"protocolSessionId",
		);
		if (mode === "lite" && this.protocolSessionId === null)
			throw new TypeError("Lite routing requires a protocolSessionId.");
	}

	get threadId(): string | null {
		return this.threadIdValue;
	}

	/** Preserve run affinity while binding the context to a new conversation. */
	startConversation(threadId: string | null): void {
		this.threadIdValue = validateOptionalRoutingId(threadId, "threadId");
	}

	snapshot(): StickyRoutingIdentity {
		return Object.freeze({
			cacheKey: this.cacheKey,
			threadId: this.threadIdValue,
			...(this.protocolSessionId === null
				? {}
				: { protocolSessionId: this.protocolSessionId }),
		});
	}

	headers(): Readonly<Record<string, string>> {
		const result: Record<string, string> = Object.create(null);
		if (this.provider === "grok") {
			if (this.cacheKey !== null) {
				result["x-grok-conv-id"] = this.cacheKey;
				result["x-grok-session-id"] = this.cacheKey;
			}
		} else {
			if (this.mode === "lite") {
				if (this.protocolSessionId !== null)
					result.session_id = this.protocolSessionId;
			} else if (this.cacheKey !== null) {
				result["session-id"] = this.cacheKey;
			}
			if (this.threadIdValue !== null) result["thread-id"] = this.threadIdValue;
		}
		return Object.freeze(result);
	}

	/** Add routing headers without allowing a per-attempt header to replace them. */
	applyTo(
		headers: Readonly<Record<string, string>>,
	): Readonly<Record<string, string>> {
		const result: Record<string, string> = Object.create(null);
		for (const [name, value] of Object.entries(headers)) {
			const normalized = name.toLowerCase();
			if (!validHeaderName(normalized) || !validHeaderValue(value))
				throw new TypeError("HTTP header is invalid.");
			result[normalized] = value;
		}
		for (const [name, value] of Object.entries(this.headers())) {
			const previous = result[name];
			if (previous !== undefined && previous !== value)
				throw new TypeError(`Header ${name} conflicts with sticky routing.`);
			result[name] = value;
		}
		return Object.freeze(result);
	}
}

function validateOptionalRoutingId(
	value: string | null,
	label: string,
): string | null {
	if (value === null || value === "") return null;
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > 256 ||
		!/^[A-Za-z0-9._:-]+$/.test(value)
	)
		throw new TypeError(`${label} must be a safe opaque identifier.`);
	return value;
}

function validHeaderName(value: string): boolean {
	return /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(value);
}

function validHeaderValue(value: string): boolean {
	return typeof value === "string" && !/[\r\n]/.test(value);
}
