import type { ClockPort } from "../contracts/clock";
import type { RandomPort } from "../contracts/ports";
import type { ResolvedRole } from "../project/roles";
import type {
	ProviderAttemptResult,
	RespondResult,
	SendProviderAttempt,
} from "../provider/retry/respond";
import {
	respondWithRetry,
	STREAM_CONTINUATION_INSTRUCTION,
} from "../provider/retry/respond";
import {
	type SessionItemInput,
	userMessageBytes,
} from "../provider/session/history";
import {
	newConversation,
	type SessionState,
	stepSession,
} from "../provider/session/transition";
import type { AssembledResponse } from "../provider/sse/assemble";
import type { ToolDispatchOptions } from "../provider/tools/dispatch";
import { dispatchToolCalls } from "../provider/tools/dispatch";
import type { ShapeConversationKind, ShapeLogicalRole } from "./counters";
import { type ShapeAccounting, shapeRoleAssignment } from "./counters";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ShapeConversationOutcome =
	| {
			readonly kind: "complete";
			readonly session: SessionState;
			readonly finalText: string;
	  }
	| { readonly kind: "turn_limit"; readonly session: SessionState }
	| {
			readonly kind: "provider_failure";
			readonly session: SessionState;
			readonly result: Extract<RespondResult, { kind: "stopped" }>;
	  }
	| { readonly kind: "cancelled"; readonly session: SessionState }
	| {
			readonly kind: "effect_failure";
			readonly session: SessionState;
			readonly error: unknown;
	  };

export interface RunShapeConversationInput {
	readonly session: SessionState;
	readonly role: ResolvedRole;
	readonly kind: Exclude<ShapeConversationKind, "auditor">;
	readonly accounting: ShapeAccounting;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly sendAttempt: SendProviderAttempt;
	readonly onInterruptedItems?: (items: readonly string[]) => void;
	/** Test-only retry delay scale; Shape policy counters remain unscaled. */
	readonly timeScale?: number;
	readonly toolDispatch: (input: {
		readonly response: AssembledResponse;
		readonly session: SessionState;
		readonly options: ToolDispatchOptions;
	}) => Promise<
		readonly { readonly callId: string; readonly output: string }[]
	>;
	readonly toolOptions: ToolDispatchOptions;
	signal?: AbortSignal;
}

function logicalRoleForSession(session: SessionState): ShapeLogicalRole {
	if (session.role === "shaper") return "shaper";
	if (session.role === "fallback_shaper") return "fallback_shaper";
	if (session.role === "auditor") return "auditor";
	throw new TypeError("Shape request has an unsupported model role.");
}

function conversationKindForSession(
	session: SessionState,
): ShapeConversationKind {
	if (session.role === "shaper") return "primary";
	if (session.role === "fallback_shaper") return "fallback";
	if (session.role === "auditor") return "auditor";
	throw new TypeError("Shape request has an unsupported model role.");
}

/**
 * Run one logical model request through the common Shape retry layer and count
 * its first dispatch as one logical turn. Retries and continuation attempts
 * remain HTTP attempts under that turn.
 */
export async function respondToShapeRequest(input: {
	readonly session: SessionState;
	readonly role: ResolvedRole;
	readonly accounting: ShapeAccounting;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly sendAttempt: SendProviderAttempt;
	readonly timeScale?: number;
	readonly signal?: AbortSignal;
	readonly onInterruptedItems?: (items: readonly string[]) => void;
}): Promise<RespondResult> {
	const roleName = logicalRoleForSession(input.session);
	if (roleName === "fallback_shaper" && input.role.name !== "shaper")
		throw new TypeError(
			"Fallback shaper requests must use the effective shaper role.",
		);
	if (roleName === "auditor" && input.role.name !== "auditor")
		throw new TypeError("Auditor requests must use the resolved auditor role.");
	if (roleName === "shaper" && input.role.name !== "shaper")
		throw new TypeError(
			"Primary shaper requests must use the resolved shaper role.",
		);
	const conversationId = input.session.threadId;
	input.accounting.registerConversation(
		conversationId,
		conversationKindForSession(input.session),
		shapeRoleAssignment(input.role, roleName),
	);
	let turnStarted = false;
	return respondWithRetry({
		session: input.session,
		resolvedRole: input.role,
		mode: "shape",
		...(input.timeScale === undefined ? {} : { timeScale: input.timeScale }),
		clock: input.clock,
		random: input.random,
		sendAttempt: async (attemptInput) => {
			if (!turnStarted) {
				input.accounting.startLogicalTurn(conversationId);
				turnStarted = true;
			}
			input.accounting.startHttpAttempt(conversationId);
			let recorded = false;
			try {
				const result: ProviderAttemptResult =
					await input.sendAttempt(attemptInput);
				if (!result.ok && (result.error.partialItemJson?.length ?? 0) > 0)
					input.onInterruptedItems?.(result.error.partialItemJson ?? []);
				recorded = true;
				input.accounting.finishHttpAttempt(conversationId, {
					usage: result.ok
						? result.response.usage
						: (result.error.usage ?? null),
					failed: !result.ok,
					partial:
						!result.ok && (result.error.partialItemJson?.length ?? 0) > 0,
				});
				return result;
			} finally {
				if (!recorded)
					input.accounting.finishHttpAttempt(conversationId, {
						usage: null,
						failed: true,
						partial: false,
					});
			}
		},
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}

/** Execute shaper tool turns while retaining a single immutable RequestContext. */
export async function runShapeConversation(
	input: RunShapeConversationInput,
): Promise<ShapeConversationOutcome> {
	if (
		(input.kind === "primary" && input.session.role !== "shaper") ||
		(input.kind === "fallback" && input.session.role !== "fallback_shaper")
	)
		throw new TypeError(
			"Shape conversation kind and request context do not match.",
		);
	if (input.role.name !== "shaper")
		throw new TypeError(
			"Shape conversations require the resolved shaper role.",
		);
	let session = input.session;
	while (true) {
		if (!input.accounting.canStartLogicalTurn(session.threadId))
			return { kind: "turn_limit", session };
		let responseResult: RespondResult;
		try {
			responseResult = await respondToShapeRequest({
				session,
				role: input.role,
				accounting: input.accounting,
				clock: input.clock,
				random: input.random,
				sendAttempt: input.sendAttempt,
				...(input.timeScale === undefined
					? {}
					: { timeScale: input.timeScale }),
				...(input.onInterruptedItems === undefined
					? {}
					: { onInterruptedItems: input.onInterruptedItems }),
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
		} catch (error) {
			return { kind: "effect_failure", session, error };
		}
		session = responseResult.session;
		if (responseResult.kind === "stopped")
			return { kind: "provider_failure", session, result: responseResult };
		if (responseResult.kind === "cancelled")
			return { kind: "cancelled", session };
		if (responseResult.kind === "budget_exhausted")
			return {
				kind: "effect_failure",
				session,
				error: new Error(
					"Shape provider request had an unexpected wall budget.",
				),
			};

		const response = responseResult.response;
		try {
			// Save exact provider item JSON before tool effects can fail.
			session = stepSession(session, {
				type: "append_turn",
				responseItems: response.raw_item_json.map((item) =>
					encoder.encode(item),
				),
			});
			if (response.tool_calls.length === 0)
				return { kind: "complete", session, finalText: response.text };
			const toolResults = await input.toolDispatch({
				response,
				session,
				options: {
					...input.toolOptions,
					authorizedTools: session.authorizedTools,
				},
			});
			session = stepSession(session, {
				type: "append_turn",
				responseItems: [],
				toolResults,
			});
		} catch (error) {
			return { kind: "effect_failure", session, error };
		}
	}
}

export function dispatchShapeTools(
	response: AssembledResponse,
	options: ToolDispatchOptions,
): Promise<readonly { readonly callId: string; readonly output: string }[]> {
	return dispatchToolCalls(response, options);
}

/**
 * Open the one permitted fallback context. It preserves the original user
 * bytes, exact interrupted response items, controller notes, and last failure.
 * The static prefix and run affinity remain shared; the thread is new.
 */
export function startFallbackConversation(input: {
	readonly primary: SessionState;
	readonly initialUserMessage: SessionItemInput;
	readonly effectiveShaper: ResolvedRole;
	readonly lastFailure: string;
	readonly interruptedItems?: readonly string[];
}): SessionState {
	if (
		input.primary.role !== "shaper" ||
		input.effectiveShaper.name !== "shaper" ||
		input.primary.provider !== input.effectiveShaper.effective.provider ||
		input.primary.effectiveRole !== "shaper" ||
		input.primary.model !== input.effectiveShaper.effective.model ||
		input.primary.effort !== input.effectiveShaper.effective.effort
	)
		throw new TypeError(
			"Fallback requires the primary and effective shaper contexts.",
		);
	const firstItem = input.primary.history.snapshotItems()[0];
	if (
		!firstItem ||
		!bytesEqual(firstItem.bytes, input.initialUserMessage.bytes)
	)
		throw new TypeError("Fallback must preserve the original Shape user item.");
	const notes = input.primary.history
		.snapshotItems()
		.filter((item) => item.kind === "user_note")
		.map((item) => extractUserMessageText(item.bytes));
	const carry =
		notes.length === 0
			? ""
			: `\n\nController input carried forward:\n${notes.join("\n\n")}`;
	const interruption =
		(input.interruptedItems?.length ?? 0) > 0 &&
		!notes.includes(STREAM_CONTINUATION_INSTRUCTION)
			? `\n\n${STREAM_CONTINUATION_INSTRUCTION}`
			: "";
	const failure =
		input.lastFailure.length === 0
			? "Shape allowance exhausted."
			: input.lastFailure;
	const fallbackMessage = `${carry}${interruption}\n\nThe primary Shape conversation exhausted an allowance. Continue shaping the same task using the files already written.\n\nLast validation failure:\n${failure}`;
	return newConversation(input.primary, {
		type: "start_conversation",
		stage: input.primary.stage,
		attempt: "fallback",
		rung: "fallback",
		epoch: "initial",
		role: "fallback_shaper",
		model: input.effectiveShaper.effective.model,
		effort: input.effectiveShaper.effective.effort,
		roleInstructions: input.primary.roleInstructions,
		initialItems: [
			{ ...input.initialUserMessage },
			...(input.interruptedItems ?? []).map((item) => ({
				bytes: encoder.encode(item),
				kind: "response" as const,
				model: input.primary.model,
			})),
			{ bytes: userMessageBytes(fallbackMessage), kind: "user_note" },
		],
	});
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}

function extractUserMessageText(bytes: Uint8Array): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch (cause) {
		throw new TypeError("Shape user context must be valid UTF-8 JSON.", {
			cause,
		});
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new TypeError("Shape user context must be a JSON object.");
	const message = parsed as Record<string, unknown>;
	if (message.role !== "user" || !Array.isArray(message.content))
		throw new TypeError("Shape user context must be a user message.");
	const parts: string[] = [];
	for (const item of message.content) {
		if (item === null || typeof item !== "object" || Array.isArray(item))
			continue;
		const content = item as Record<string, unknown>;
		if (content.type === "input_text" && typeof content.text === "string")
			parts.push(content.text);
	}
	if (parts.length === 0)
		throw new TypeError("Shape user context has no text.");
	return parts.join("\n");
}
