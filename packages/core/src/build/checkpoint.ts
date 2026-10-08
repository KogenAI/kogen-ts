import type { Result } from "../contracts/errors";
import type { SessionItemInput } from "../provider/session/history";
import { userMessageBytes } from "../provider/session/history";
import { canonicalJson } from "../provider/session/prefix";
import {
	newConversation,
	type SessionState,
	stepSession,
} from "../provider/session/transition";
import type { BuildDeveloperPort, BuildDeveloperTurn } from "./develop";

export const BUILD_CONTEXT_MINIMUM_BYTES = 16_000;
export const BUILD_CONTEXT_CONTINUATION_MARKER =
	"Continuation of the same approved Build.\n\n";

const CHECKPOINT_SUMMARY_REQUEST = [
	"Summarize this conversation for the next turn of the same approved Build.",
	"Preserve the approved requirements and plan, decisions, findings, files changed,",
	"commands and results, failures, constraints, and unfinished work. Keep exact names",
	"and actionable details. Do not claim an operation succeeded unless the history shows it.",
	"Return only the summary text; do not call tools.",
].join(" ");

export interface BuildCheckpointRetainedState<Approval, Plan, Workspace, Caps> {
	/** The loaded approval, including the approved Intent/test bytes. */
	readonly approval: Approval;
	readonly plan: Plan;
	readonly workspace: Workspace;
	/** Existing configured caps and repair progress. */
	readonly caps: Caps;
	readonly turnsUsed: number;
	readonly continuations: number;
}

export interface BuildContextCheckpointRequest<
	Approval,
	Plan,
	Workspace,
	Caps,
> {
	readonly session: SessionState;
	readonly retained: BuildCheckpointRetainedState<
		Approval,
		Plan,
		Workspace,
		Caps
	>;
	/** Omission disables checkpoints. Machine configuration does not supply it. */
	readonly contextBytes?: number;
	/** The next Build turn number. A dispatched summary consumes this turn. */
	readonly turn: number;
	readonly remainingBuildBudgetMilliseconds: number;
	readonly remainingRungWallMilliseconds: number;
	readonly developer: Pick<BuildDeveloperPort, "complete">;
}

export type BuildContextCheckpointOutcome<Approval, Plan, Workspace, Caps> =
	| {
			readonly kind: "disabled" | "not_due";
			readonly session: SessionState;
			readonly retained: BuildCheckpointRetainedState<
				Approval,
				Plan,
				Workspace,
				Caps
			>;
			readonly attempts: 0;
			readonly consumedTurns: 0;
			readonly nextTurn: number;
	  }
	| {
			readonly kind: "accepted";
			readonly session: SessionState;
			readonly retained: BuildCheckpointRetainedState<
				Approval,
				Plan,
				Workspace,
				Caps
			>;
			readonly checkpointItem: SessionItemInput;
			readonly summarizerSession: SessionState;
			readonly attempts: number;
			readonly consumedTurns: 1;
			readonly nextTurn: number;
	  }
	| {
			readonly kind: "continuation_failed";
			readonly session: SessionState;
			readonly retained: BuildCheckpointRetainedState<
				Approval,
				Plan,
				Workspace,
				Caps
			>;
			readonly summarizerSession: SessionState;
			readonly attempts: number;
			readonly consumedTurns: 1;
			readonly nextTurn: number;
	  }
	| {
			readonly kind: "provider_failure";
			readonly reason: Extract<
				BuildDeveloperTurn,
				{ kind: "provider_failure" }
			>["reason"];
			readonly session: SessionState;
			readonly summarizerSession: SessionState;
			readonly retained: BuildCheckpointRetainedState<
				Approval,
				Plan,
				Workspace,
				Caps
			>;
			readonly attempts: number;
			readonly consumedTurns: 0 | 1;
			readonly nextTurn: number;
	  }
	| {
			readonly kind: "budget_exhausted" | "cancelled";
			readonly session: SessionState;
			readonly summarizerSession: SessionState;
			readonly retained: BuildCheckpointRetainedState<
				Approval,
				Plan,
				Workspace,
				Caps
			>;
			readonly attempts: number;
			readonly consumedTurns: 0 | 1;
			readonly nextTurn: number;
	  };

export interface BuildCheckpointFailure {
	readonly code: string;
	readonly message: string;
	readonly exitCode: 3 | 4 | 70;
}

function validateContextBytes(value: number): void {
	if (!Number.isSafeInteger(value) || value < BUILD_CONTEXT_MINIMUM_BYTES)
		throw new RangeError(
			`build.context_bytes must be an integer of at least ${BUILD_CONTEXT_MINIMUM_BYTES}.`,
		);
}

function validateTurn(value: number): void {
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value === Number.MAX_SAFE_INTEGER
	)
		throw new RangeError("Checkpoint turn must be a positive safe integer.");
}

/** Exact byte length of the serialized history input array, including commas. */
export function serializedBuildHistoryBytes(session: SessionState): number {
	const items = session.history.itemBytes();
	let total = Math.max(0, items.length - 1);
	for (const item of items) {
		total += item.byteLength;
		if (!Number.isSafeInteger(total))
			throw new RangeError("Serialized Build history size is too large.");
	}
	return total;
}

export function buildCheckpointIsDue(
	session: SessionState,
	contextBytes: number | undefined,
): boolean {
	if (contextBytes === undefined) return false;
	validateContextBytes(contextBytes);
	return serializedBuildHistoryBytes(session) >= contextBytes;
}

/**
 * Prepare the one no-tool request that compacts the current Build history.
 * Its identity is a checkpoint epoch, while the run affinity and original
 * approved request/plan base remain attached to the same run.
 */
export function buildCheckpointSummarizerSession(
	session: SessionState,
	turn: number,
): SessionState {
	validateTurn(turn);
	if (session.role !== "builder" || session.effectiveRole !== "builder")
		throw new TypeError(
			"A Build checkpoint requires the resolved builder session.",
		);
	if (session.stage !== "build")
		throw new TypeError("A Build checkpoint requires the Build stage.");
	const summarizer = newConversation(session, {
		type: "start_conversation",
		stage: session.stage,
		attempt: session.attempt,
		rung: session.rung,
		epoch: `checkpoint-${turn}`,
		role: "builder",
		roleInstructions: session.roleInstructions,
		initialItems: [
			...session.history.snapshotItems(),
			{
				bytes: userMessageBytes(CHECKPOINT_SUMMARY_REQUEST),
				kind: "user_note",
			},
		],
	});
	return Object.freeze({
		...summarizer,
		// The summary is transient. Acceptance always compacts to the initial
		// approved Intent and plan, not to the summarizer's full input history.
		continuationBase: session.continuationBase,
		// encodeSessionRequest turns this empty allowlist into tool_choice:none.
		authorizedTools: Object.freeze([]),
	});
}

function checkpointTextFromItem(item: SessionItemInput): string | null {
	if (!(item.bytes instanceof Uint8Array) || item.bytes.byteLength === 0)
		return null;
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(item.bytes),
		);
	} catch {
		return null;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return null;
	const record = value as Record<string, unknown>;
	if (
		record.role !== "user" ||
		!Array.isArray(record.content) ||
		record.content.length !== 1
	)
		return null;
	const content = record.content[0];
	if (content === null || typeof content !== "object" || Array.isArray(content))
		return null;
	const textRecord = content as Record<string, unknown>;
	if (
		textRecord.type !== "input_text" ||
		typeof textRecord.text !== "string" ||
		!textRecord.text.startsWith(BUILD_CONTEXT_CONTINUATION_MARKER) ||
		textRecord.text.slice(BUILD_CONTEXT_CONTINUATION_MARKER.length).trim()
			.length === 0
	)
		return null;
	return textRecord.text;
}

/**
 * Validate the marker and ensure approved bytes plus the continuation fit the
 * configured serialized-history cap before changing the session epoch.
 */
export function acceptBuildCheckpointItem(
	session: SessionState,
	turn: number,
	item: SessionItemInput,
	contextBytes: number,
): SessionState | null {
	validateTurn(turn);
	validateContextBytes(contextBytes);
	if (checkpointTextFromItem(item) === null) return null;
	let compacted: SessionState;
	try {
		compacted = stepSession(session, {
			type: "accept_checkpoint",
			turn,
			item,
		});
	} catch {
		return null;
	}
	if (serializedBuildHistoryBytes(compacted) > contextBytes) return null;
	if (
		compacted.cacheKey !== session.cacheKey ||
		compacted.protocolSessionId !== session.protocolSessionId ||
		compacted.threadId === session.threadId
	)
		return null;
	return compacted;
}

function continuationItem(summary: string): SessionItemInput | null {
	if (typeof summary !== "string" || summary.trim().length === 0) return null;
	try {
		const text = summary.startsWith(BUILD_CONTEXT_CONTINUATION_MARKER)
			? summary
			: `${BUILD_CONTEXT_CONTINUATION_MARKER}${summary}`;
		return { bytes: userMessageBytes(text), kind: "user_note" };
	} catch {
		return null;
	}
}

function resultSessionIsSameConversation(
	input: SessionState,
	output: SessionState,
): boolean {
	return (
		input.runDirectory === output.runDirectory &&
		input.cacheKey === output.cacheKey &&
		input.threadId === output.threadId &&
		input.provider === output.provider &&
		input.effectiveRole === "builder" &&
		output.effectiveRole === "builder" &&
		input.stage === output.stage &&
		input.attempt === output.attempt &&
		input.rung === output.rung &&
		input.epoch === output.epoch
	);
}

function validCompletedResponse(
	turn: Extract<BuildDeveloperTurn, { kind: "completed" }>,
): boolean {
	if (turn.response.tool_calls.length !== 0) return false;
	if (
		turn.response.raw_items.length === 0 ||
		turn.response.raw_items.length !== turn.response.raw_item_json.length
	)
		return false;
	try {
		for (
			let index = 0;
			index < turn.response.raw_item_json.length;
			index += 1
		) {
			const raw = turn.response.raw_item_json[index];
			const item = turn.response.raw_items[index];
			if (raw === undefined || item === undefined) return false;
			const parsed: unknown = JSON.parse(raw);
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				canonicalJson(parsed) !== canonicalJson(item)
			)
				return false;
			const type = (parsed as Record<string, unknown>).type;
			if (
				type === "function_call" ||
				type === "function_call_output" ||
				type === "refusal"
			)
				return false;
		}
	} catch {
		return false;
	}
	return turn.response.text.trim().length > 0;
}

function checkpointFailure(
	code: string,
	message: string,
	exitCode: 3 | 4 | 70 = 70,
): BuildCheckpointFailure {
	return { code, message, exitCode };
}

function retainedAfterTurn<Approval, Plan, Workspace, Caps>(
	retained: BuildCheckpointRetainedState<Approval, Plan, Workspace, Caps>,
	consumedTurns: 0 | 1,
): BuildCheckpointRetainedState<Approval, Plan, Workspace, Caps> {
	return consumedTurns === 0
		? retained
		: { ...retained, turnsUsed: retained.turnsUsed + consumedTurns };
}

/**
 * Run one logical, tool-less summarizer request when the opt-in history cap is
 * reached. The helper never recreates approval, workspace, repair state, or
 * configured limits; a dispatched summary consumes its existing turn slot.
 */
export async function checkpointBuildContext<Approval, Plan, Workspace, Caps>(
	request: BuildContextCheckpointRequest<Approval, Plan, Workspace, Caps>,
): Promise<
	Result<
		BuildContextCheckpointOutcome<Approval, Plan, Workspace, Caps>,
		BuildCheckpointFailure
	>
> {
	if (request.contextBytes === undefined)
		return {
			ok: true,
			value: {
				kind: "disabled",
				session: request.session,
				retained: request.retained,
				attempts: 0,
				consumedTurns: 0,
				nextTurn: request.turn,
			},
		};
	try {
		validateContextBytes(request.contextBytes);
		validateTurn(request.turn);
		if (
			!Number.isSafeInteger(request.remainingBuildBudgetMilliseconds) ||
			request.remainingBuildBudgetMilliseconds < 0 ||
			!Number.isSafeInteger(request.remainingRungWallMilliseconds) ||
			request.remainingRungWallMilliseconds < 0 ||
			!Number.isSafeInteger(request.retained.turnsUsed) ||
			request.retained.turnsUsed < 0 ||
			request.retained.turnsUsed >= Number.MAX_SAFE_INTEGER - 1 ||
			request.turn !== request.retained.turnsUsed + 1 ||
			!Number.isSafeInteger(request.retained.continuations) ||
			request.retained.continuations < 0 ||
			request.retained.continuations === Number.MAX_SAFE_INTEGER
		)
			throw new RangeError("Build checkpoint counters or budgets are invalid.");
	} catch (cause) {
		return {
			ok: false,
			error: checkpointFailure(
				"controller/checkpoint_input_invalid",
				cause instanceof Error
					? cause.message
					: "Build checkpoint input is invalid.",
			),
		};
	}
	if (!buildCheckpointIsDue(request.session, request.contextBytes))
		return {
			ok: true,
			value: {
				kind: "not_due",
				session: request.session,
				retained: request.retained,
				attempts: 0,
				consumedTurns: 0,
				nextTurn: request.turn,
			},
		};
	let summarizer: SessionState;
	try {
		summarizer = buildCheckpointSummarizerSession(
			request.session,
			request.turn,
		);
	} catch (cause) {
		return {
			ok: false,
			error: checkpointFailure(
				"controller/checkpoint_session_invalid",
				cause instanceof Error
					? cause.message
					: "Checkpoint session is invalid.",
			),
		};
	}
	let turn: BuildDeveloperTurn;
	try {
		turn = await request.developer.complete({
			session: summarizer,
			turn: request.turn,
			remainingBuildBudgetMilliseconds:
				request.remainingBuildBudgetMilliseconds,
			remainingRungWallMilliseconds: request.remainingRungWallMilliseconds,
		});
	} catch (cause) {
		return {
			ok: false,
			error: checkpointFailure(
				"environment/checkpoint_summarizer_failed",
				cause instanceof Error
					? cause.message
					: "Checkpoint summarizer failed.",
				3,
			),
		};
	}
	if (
		!Number.isSafeInteger(turn.attempts) ||
		turn.attempts < 0 ||
		!resultSessionIsSameConversation(summarizer, turn.session)
	)
		return {
			ok: false,
			error: checkpointFailure(
				"controller/checkpoint_result_invalid",
				"Checkpoint summarizer changed its conversation or attempt count.",
			),
		};
	const consumedTurns: 0 | 1 = turn.attempts > 0 ? 1 : 0;
	const nextTurn = request.turn + consumedTurns;
	if (!Number.isSafeInteger(nextTurn))
		return {
			ok: false,
			error: checkpointFailure(
				"controller/checkpoint_turn_invalid",
				"Checkpoint turn count exceeded the safe integer range.",
			),
		};
	if (turn.kind === "provider_failure")
		return {
			ok: true,
			value: {
				kind: "provider_failure",
				reason: turn.reason,
				session: request.session,
				summarizerSession: turn.session,
				retained: retainedAfterTurn(request.retained, consumedTurns),
				attempts: turn.attempts,
				consumedTurns,
				nextTurn,
			},
		};
	if (turn.kind === "budget_exhausted" || turn.kind === "cancelled")
		return {
			ok: true,
			value: {
				kind: turn.kind,
				session: request.session,
				summarizerSession: turn.session,
				retained: retainedAfterTurn(request.retained, consumedTurns),
				attempts: turn.attempts,
				consumedTurns,
				nextTurn,
			},
		};
	if (turn.kind !== "completed" || turn.attempts === 0)
		return {
			ok: false,
			error: checkpointFailure(
				"controller/checkpoint_result_invalid",
				"A completed checkpoint summary must have a dispatched provider attempt.",
			),
		};
	if (!validCompletedResponse(turn))
		return {
			ok: true,
			value: {
				kind: "continuation_failed",
				session: request.session,
				summarizerSession: turn.session,
				retained: retainedAfterTurn(request.retained, 1),
				attempts: turn.attempts,
				consumedTurns: 1,
				nextTurn,
			},
		};
	const item = continuationItem(turn.response.text);
	if (item === null)
		return {
			ok: true,
			value: {
				kind: "continuation_failed",
				session: request.session,
				summarizerSession: turn.session,
				retained: retainedAfterTurn(request.retained, 1),
				attempts: turn.attempts,
				consumedTurns: 1,
				nextTurn,
			},
		};
	const accepted = acceptBuildCheckpointItem(
		request.session,
		request.turn,
		item,
		request.contextBytes,
	);
	if (accepted === null)
		return {
			ok: true,
			value: {
				kind: "continuation_failed",
				session: request.session,
				summarizerSession: turn.session,
				retained: retainedAfterTurn(request.retained, 1),
				attempts: turn.attempts,
				consumedTurns: 1,
				nextTurn,
			},
		};
	return {
		ok: true,
		value: {
			kind: "accepted",
			session: accepted,
			retained: {
				...request.retained,
				turnsUsed: request.retained.turnsUsed + 1,
				continuations: request.retained.continuations + 1,
			},
			checkpointItem: item,
			summarizerSession: turn.session,
			attempts: turn.attempts,
			consumedTurns: 1,
			nextTurn,
		},
	};
}
