import type { ClockPort } from "../contracts/clock";
import type { FileSystemPort, RandomPort } from "../contracts/ports";
import type { ResolvedRole } from "../project/roles";
import type {
	RespondResult,
	SendProviderAttempt,
} from "../provider/retry/respond";
import type {
	SessionItemInput,
	ToolResultInput,
} from "../provider/session/history";
import { userMessageBytes } from "../provider/session/history";
import { type SessionState, stepSession } from "../provider/session/transition";
import type { AssembledResponse } from "../provider/sse/assemble";
import type { ToolDispatchOptions } from "../provider/tools/dispatch";
import {
	dispatchShapeTools,
	respondToShapeRequest,
	runShapeConversation,
	startFallbackConversation,
} from "./conversation";
import {
	SHAPE_LIMITS,
	ShapeAccounting,
	type ShapeAccountingDocument,
	type ShapeConversationKind,
	type ShapeRepairKind,
	shapeRoleAssignment,
} from "./counters";

const encoder = new TextEncoder();

export interface ShapeFailure {
	readonly category: "candidate" | "provider" | "environment";
	readonly reason: string;
	readonly message: string;
	readonly exitCode: number;
}

export interface ShapeWarning {
	readonly code: string;
	readonly item_ids: readonly string[];
	readonly message: string;
}

export type ShapeValidationOutcome =
	| { readonly kind: "valid"; readonly warnings?: readonly ShapeWarning[] }
	| {
			readonly kind: "finish_guard";
			readonly missingPaths: readonly string[];
	  }
	| {
			readonly kind: "style_repair";
			readonly feedback: string;
			readonly warnings?: readonly ShapeWarning[];
	  }
	| {
			readonly kind: "repair";
			readonly failure: ShapeFailure;
			readonly feedback: string;
			readonly repairKind: Exclude<ShapeRepairKind, "style">;
	  }
	| { readonly kind: "failure"; readonly failure: ShapeFailure };

export interface ShapeValidationInput {
	readonly conversation: ShapeConversationKind;
	readonly conversationId: string;
	readonly passNumber: number;
	readonly session: SessionState;
	readonly finalResponseText: string;
	readonly accounting: ShapeAccounting;
	readonly requestModel: (
		session: SessionState,
		role: ResolvedRole,
	) => Promise<RespondResult>;
}

export interface ShapeControllerRequest {
	readonly initialSession: SessionState;
	readonly initialUserMessage: SessionItemInput;
	readonly shaperRole: ResolvedRole;
	readonly auditorRole: ResolvedRole;
	readonly scratchDirectory: string;
	readonly filesystem: FileSystemPort;
	readonly clock: ClockPort;
	readonly random: RandomPort;
	readonly sendAttempt: SendProviderAttempt;
	readonly toolOptions: ToolDispatchOptions;
	readonly validate: (
		input: ShapeValidationInput,
	) => Promise<ShapeValidationOutcome>;
	readonly prepare?: () => Promise<ShapeFailure | null>;
	readonly dispatchTools?: (input: {
		readonly response: AssembledResponse;
		readonly session: SessionState;
		readonly options: ToolDispatchOptions;
	}) => Promise<readonly ToolResultInput[]>;
	signal?: AbortSignal;
}

export type ShapeControllerResult =
	| {
			readonly status: "success";
			readonly exitCode: 0;
			readonly warnings: readonly ShapeWarning[];
			readonly accounting: ShapeAccountingDocument;
			readonly accountingPersisted: true;
	  }
	| {
			readonly status: "failure";
			readonly exitCode: number;
			readonly failure: ShapeFailure;
			readonly accounting: ShapeAccountingDocument;
			readonly accountingPersisted: boolean;
	  };

/**
 * Execute the v1.3 Shape conversation ladder. The same primary RequestContext
 * remains live through every turn; one fallback context is opened only after
 * primary turn or pass exhaustion. Every terminal path writes accounting.
 */
export async function runShape(
	request: ShapeControllerRequest,
): Promise<ShapeControllerResult> {
	validateRequest(request);
	const startedAt = checkedMonotonicNow(request.clock);
	const accounting = new ShapeAccounting({
		shaper: request.shaperRole,
		auditor: request.auditorRole,
	});
	let session = request.initialSession;
	let kind: Exclude<ShapeConversationKind, "auditor"> = "primary";
	let fallbackStarted = false;
	let lastFailure = "";
	let validationCompleted = false;
	const interruptedItems: string[] = [];
	const warnings: ShapeWarning[] = [];
	let failure: ShapeFailure | null = null;
	let succeeded = false;

	accounting.registerConversation(
		session.threadId,
		"primary",
		shapeRoleAssignment(request.shaperRole, "shaper"),
	);

	try {
		const preparationFailure = await request.prepare?.();
		if (preparationFailure) {
			failure = preparationFailure;
		} else {
			while (failure === null && !succeeded) {
				const conversation = await runShapeConversation({
					session,
					role: request.shaperRole,
					kind,
					accounting,
					clock: request.clock,
					random: request.random,
					sendAttempt: request.sendAttempt,
					onInterruptedItems: (items) => interruptedItems.push(...items),
					toolDispatch:
						request.dispatchTools ??
						((input) => dispatchShapeTools(input.response, input.options)),
					toolOptions: {
						...request.toolOptions,
						authorizedTools: session.authorizedTools,
					},
					...(request.signal === undefined ? {} : { signal: request.signal }),
				});
				session = conversation.session;

				if (conversation.kind === "provider_failure") {
					failure = {
						category: "provider",
						reason: conversation.result.reason,
						message: conversation.result.error.message,
						exitCode: conversation.result.exitCode,
					};
					break;
				}
				if (conversation.kind === "cancelled") {
					failure = {
						category: "environment",
						reason: "environment/shape_cancelled",
						message: "Shaping was interrupted.",
						exitCode: 130,
					};
					break;
				}
				if (conversation.kind === "effect_failure") {
					failure = failureFromEffect(conversation.error);
					break;
				}

				if (conversation.kind === "turn_limit") {
					if (kind === "primary") {
						({ session, kind, fallbackStarted } = openFallback({
							request,
							accounting,
							primary: session,
							interruptedItems,
							lastFailure: validationCompleted
								? lastFailure || shapeTurnLimitFailure().reason
								: shapeTurnLimitFailure().reason,
							fallbackStarted,
						}));
						continue;
					}
					failure = shapeTurnLimitFailure();
					break;
				}

				const conversationId = session.threadId;
				if (!accounting.canCompleteValidationPass(conversationId)) {
					if (kind === "primary") {
						({ session, kind, fallbackStarted } = openFallback({
							request,
							accounting,
							primary: session,
							interruptedItems,
							lastFailure: lastFailure || shapePassLimitFailure().message,
							fallbackStarted,
						}));
						continue;
					}
					failure = exhaustedRepairFailure(accounting, lastFailure);
					break;
				}
				const validation = await request.validate({
					conversation: kind,
					conversationId,
					passNumber: accounting.nextValidationPassLabel(conversationId),
					session,
					finalResponseText: conversation.finalText,
					accounting,
					requestModel: (auditSession, role) =>
						respondToShapeRequest({
							session: auditSession,
							role,
							accounting,
							clock: request.clock,
							random: request.random,
							sendAttempt: request.sendAttempt,
							...(request.signal === undefined
								? {}
								: { signal: request.signal }),
						}),
				});
				if (validation.kind !== "finish_guard") validationCompleted = true;

				switch (validation.kind) {
					case "valid":
						accounting.completeValidationPass(conversationId);
						warnings.push(...(validation.warnings ?? []));
						succeeded = true;
						break;
					case "failure":
						failure = validation.failure;
						break;
					case "finish_guard": {
						accounting.recordFinishGuard(conversationId);
						const missingPaths = validation.missingPaths;
						if (missingPaths.length === 0) {
							failure = {
								category: "environment",
								reason: "environment/shape_guard_invalid",
								message: "Shape finish guard has no missing paths.",
								exitCode: 3,
							};
							break;
						}
						lastFailure = `Both files must exist before you finish. Missing: ${missingPaths.join(", ")}.`;
						session = appendControllerInput(session, lastFailure);
						break;
					}
					case "style_repair":
						if (!accounting.canRepairStyle(conversationId)) {
							warnings.push(...(validation.warnings ?? []));
							succeeded = true;
							break;
						}
						if (!accounting.canStartLogicalTurn(conversationId)) {
							if (kind === "primary") {
								lastFailure = validation.feedback;
								({ session, kind, fallbackStarted } = openFallback({
									request,
									accounting,
									primary: session,
									interruptedItems,
									lastFailure,
									fallbackStarted,
								}));
								break;
							}
							failure = shapeTurnLimitFailure();
							break;
						}
						accounting.recordRepair(conversationId, "style");
						lastFailure = validation.feedback;
						session = appendControllerInput(session, validation.feedback);
						break;
					case "repair": {
						accounting.completeValidationPass(conversationId);
						accounting.recordRepair(conversationId, validation.repairKind);
						lastFailure = validation.feedback;
						const usedPasses =
							accounting.conversation(conversationId).counters
								.validation_passes;
						if (usedPasses >= SHAPE_LIMITS.validationPasses) {
							if (kind === "primary") {
								({ session, kind, fallbackStarted } = openFallback({
									request,
									accounting,
									primary: session,
									interruptedItems,
									lastFailure,
									fallbackStarted,
								}));
								break;
							}
							failure = exhaustedRepairFailure(
								accounting,
								lastFailure,
								validation.failure,
							);
							break;
						}
						session = appendControllerInput(session, validation.feedback);
						break;
					}
				}
			}
		}
	} catch (error) {
		failure = failureFromEffect(error);
	}

	const elapsed = Math.max(0, checkedMonotonicNow(request.clock) - startedAt);
	const document = accounting.snapshot({
		outcome: {
			status: succeeded && failure === null ? "success" : "failure",
			exit_code: succeeded && failure === null ? 0 : (failure?.exitCode ?? 3),
			category: failure?.category ?? null,
			reason: failure?.reason ?? null,
		},
		elapsedMilliseconds: elapsed,
	});
	let persistFailure: ShapeFailure | null = null;
	try {
		const persisted = await request.filesystem.writeFileAtomically({
			root: request.scratchDirectory,
			path: "shape-accounting.json",
			bytes: encoder.encode(`${JSON.stringify(document, null, 2)}\n`),
			mode: 0o600,
		});
		if (!persisted.ok)
			persistFailure = {
				category: "environment",
				reason: "environment/shape_accounting_write_failed",
				message: persisted.error.message,
				exitCode: 3,
			};
	} catch (error) {
		persistFailure = failureFromEffect(
			error,
			"environment/shape_accounting_write_failed",
		);
	}
	if (persistFailure)
		return {
			status: "failure",
			exitCode: persistFailure.exitCode,
			failure: persistFailure,
			accounting: document,
			accountingPersisted: false,
		};
	if (failure)
		return {
			status: "failure",
			exitCode: failure.exitCode,
			failure,
			accounting: document,
			accountingPersisted: true,
		};
	return {
		status: "success",
		exitCode: 0,
		warnings: Object.freeze(warnings),
		accounting: document,
		accountingPersisted: true,
	};
}

function openFallback(input: {
	readonly request: ShapeControllerRequest;
	readonly accounting: ShapeAccounting;
	readonly primary: SessionState;
	readonly interruptedItems: readonly string[];
	readonly lastFailure: string;
	readonly fallbackStarted: boolean;
}): {
	readonly session: SessionState;
	readonly kind: "fallback";
	readonly fallbackStarted: true;
} {
	if (input.fallbackStarted)
		throw new Error("Shape fallback conversation may start only once.");
	const session = startFallbackConversation({
		primary: input.primary,
		initialUserMessage: input.request.initialUserMessage,
		effectiveShaper: input.request.shaperRole,
		lastFailure: input.lastFailure,
		interruptedItems: input.interruptedItems,
	});
	input.accounting.registerConversation(
		session.threadId,
		"fallback",
		shapeRoleAssignment(input.request.shaperRole, "fallback_shaper"),
	);
	return { session, kind: "fallback", fallbackStarted: true };
}

function appendControllerInput(
	session: SessionState,
	message: string,
): SessionState {
	return stepSession(session, {
		type: "append_items",
		items: [{ bytes: userMessageBytes(message), kind: "user_note" }],
	});
}

function shapeTurnLimitFailure(): ShapeFailure {
	return {
		category: "candidate",
		reason: "candidate/shape_turn_limit",
		message: "Shaper exhausted its turn limit.",
		exitCode: 1,
	};
}

function shapePassLimitFailure(): ShapeFailure {
	return {
		category: "candidate",
		reason: "candidate/shape_pass_limit",
		message: "Shaper exhausted its validation pass limit.",
		exitCode: 1,
	};
}

function exhaustedRepairFailure(
	accounting: ShapeAccounting,
	lastFailure: string,
	prior?: ShapeFailure,
): ShapeFailure {
	const document = accounting.snapshot({
		outcome: {
			status: "failure",
			exit_code: prior?.exitCode ?? 1,
			category: prior?.category ?? "candidate",
			reason: prior?.reason ?? "candidate/shape_pass_limit",
		},
		elapsedMilliseconds: 0,
	});
	const turns =
		document.counters.logical_turns.shaper +
		document.counters.logical_turns.fallback_shaper;
	const failure = prior ?? {
		category: "candidate" as const,
		reason: "candidate/shape_pass_limit",
		message: lastFailure,
		exitCode: 1,
	};
	return {
		...failure,
		exitCode: 1,
		message: `Shaper repair limit reached for ${failure.reason} after ${document.counters.validation_passes} pass(es) and ${turns} model call(s).\n${lastFailure}`,
	};
}

function failureFromEffect(
	error: unknown,
	reason = "environment/shape_failed",
): ShapeFailure {
	return {
		category: "environment",
		reason,
		message: error instanceof Error ? error.message : "Shape effect failed.",
		exitCode: 3,
	};
}

function checkedMonotonicNow(clock: ClockPort): number {
	const value = clock.monotonicMilliseconds();
	if (!Number.isSafeInteger(value) || value < 0)
		throw new RangeError("Shape monotonic clock returned an invalid value.");
	return value;
}

function validateRequest(request: ShapeControllerRequest): void {
	if (
		request.shaperRole.name !== "shaper" ||
		request.auditorRole.name !== "auditor"
	)
		throw new TypeError("Shape requires resolved shaper and auditor roles.");
	if (request.initialSession.role !== "shaper")
		throw new TypeError(
			"Shape must start with the primary shaper RequestContext.",
		);
	if (
		request.initialSession.provider !== request.shaperRole.effective.provider ||
		request.initialSession.model !== request.shaperRole.effective.model ||
		request.initialSession.effort !== request.shaperRole.effective.effort
	)
		throw new TypeError(
			"Primary Shape context does not match the resolved shaper role.",
		);
	if (
		typeof request.scratchDirectory !== "string" ||
		!request.scratchDirectory.startsWith("/") ||
		request.scratchDirectory.includes("\0")
	)
		throw new TypeError("Shape scratch directory must be absolute.");
	if (
		!(request.initialUserMessage.bytes instanceof Uint8Array) ||
		request.initialUserMessage.bytes.byteLength === 0
	)
		throw new TypeError("Shape requires the exact initial user message bytes.");
	const firstItem = request.initialSession.history.snapshotItems()[0];
	if (
		!firstItem ||
		!bytesEqual(firstItem.bytes, request.initialUserMessage.bytes)
	)
		throw new TypeError(
			"Initial Shape RequestContext does not retain its first user item.",
		);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index += 1)
		if (left[index] !== right[index]) return false;
	return true;
}
