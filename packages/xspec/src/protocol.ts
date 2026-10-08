export type XspecSliceName = "approve" | "intent";

export interface XspecSlice {
	reset(): Promise<unknown>;
	apply(event: unknown): Promise<unknown>;
	close?(): void | Promise<void>;
}

export type XspecRequest =
	| { readonly op: "reset" }
	| { readonly op: "apply"; readonly event: unknown };

export class XspecProtocolError extends Error {
	constructor(
		readonly code:
			| "invalid_utf8"
			| "invalid_json"
			| "invalid_request"
			| "unknown_operation"
			| "invalid_event",
		message: string,
	) {
		super(message);
		this.name = "XspecProtocolError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function decodeProtocolRequest(line: string): XspecRequest {
	let value: unknown;
	try {
		value = JSON.parse(line) as unknown;
	} catch (cause) {
		throw new XspecProtocolError(
			"invalid_json",
			"request is not valid JSON: " +
				(cause instanceof Error ? cause.message : "invalid JSON input"),
		);
	}
	if (!isRecord(value) || typeof value.op !== "string")
		throw new XspecProtocolError(
			"invalid_request",
			"request must be an object with a string op field",
		);
	if (value.op === "reset") {
		if (Object.keys(value).some((key) => key !== "op"))
			throw new XspecProtocolError(
				"invalid_request",
				"reset accepts only the op field",
			);
		return { op: "reset" };
	}
	if (value.op === "apply") {
		if (
			Object.keys(value).some((key) => key !== "op" && key !== "event") ||
			!Object.hasOwn(value, "event")
		)
			throw new XspecProtocolError(
				"invalid_request",
				"apply requires exactly one event field",
			);
		return { op: "apply", event: value.event };
	}
	throw new XspecProtocolError(
		"unknown_operation",
		`unsupported operation ${JSON.stringify(value.op)}`,
	);
}

export async function dispatchProtocolRequest(
	slice: XspecSlice,
	request: XspecRequest,
): Promise<unknown> {
	if (request.op === "reset") return slice.reset();
	return slice.apply(request.event);
}

export function decodeSliceEvent(value: unknown): {
	readonly tag: string;
	readonly value?: Record<string, unknown>;
} {
	if (
		!isRecord(value) ||
		typeof value.tag !== "string" ||
		value.tag.length === 0 ||
		Object.keys(value).some((key) => key !== "tag" && key !== "value")
	)
		throw new XspecProtocolError(
			"invalid_event",
			"event must be a tagged object",
		);
	if (!Object.hasOwn(value, "value")) return { tag: value.tag };
	if (!isRecord(value.value))
		throw new XspecProtocolError(
			"invalid_event",
			"tagged event value must be an object",
		);
	return { tag: value.tag, value: value.value };
}
