import type { ModelProvider, ModelRole, ResolvedRole } from "../project/roles";
import type { ResponseUsage } from "../provider/sse/usage";

export const SHAPE_PROFILE = "shape-v1.3" as const;

export const SHAPE_LIMITS = Object.freeze({
	validationPasses: 3,
	logicalTurns: 60,
	styleRepairs: 2,
});

export type ShapeConversationKind = "primary" | "fallback" | "auditor";
export type ShapeLogicalRole = "shaper" | "fallback_shaper" | "auditor";
export type ShapeRepairKind =
	| "style"
	| "validation"
	| "coverage"
	| "test_audit"
	| "combined";

export interface ShapeRoleAssignment {
	readonly assigned_role: ShapeLogicalRole;
	readonly effective_role: ModelRole;
	readonly requested: Readonly<{ model: string; effort: string }>;
	readonly effective: Readonly<{
		provider: ModelProvider;
		model: string;
		effort: string;
	}>;
}

export interface ShapeTokenTotals {
	readonly input: number;
	readonly cached_input: number;
	readonly cache_write: number;
	readonly output: number;
	readonly reasoning: number;
}

export interface ShapeConversationCounters {
	readonly conversation_id: string;
	readonly kind: ShapeConversationKind;
	readonly role: ShapeRoleAssignment;
	readonly counters: Readonly<{
		logical_turns: number;
		validation_passes: number;
		pass_labels: readonly number[];
		finish_guards: number;
		repairs: Readonly<Record<ShapeRepairKind, number>>;
	}>;
	readonly http: Readonly<{
		attempts: number;
		failed_attempts: number;
		partial_attempts: number;
		unknown_usage_attempts: number;
		known_tokens: ShapeTokenTotals;
	}>;
}

export interface ShapeAccountingDocument {
	readonly schema: 1;
	readonly profile: typeof SHAPE_PROFILE;
	readonly outcome: Readonly<{
		status: "success" | "failure";
		exit_code: number;
		category: string | null;
		reason: string | null;
	}>;
	readonly roles: Readonly<{
		shaper: ShapeRoleAssignment;
		fallback_shaper: ShapeRoleAssignment;
		auditor: ShapeRoleAssignment;
	}>;
	readonly conversations: readonly ShapeConversationCounters[];
	readonly counters: Readonly<{
		logical_turns: Readonly<Record<ShapeLogicalRole, number>>;
		validation_passes: number;
		finish_guards: number;
		repairs: Readonly<Record<ShapeRepairKind, number>>;
	}>;
	readonly auditor: Readonly<{
		logical_requests: number;
		http_attempts: number;
		unknown_usage_attempts: number;
		known_tokens: ShapeTokenTotals;
	}>;
	readonly http: Readonly<{
		attempts: number;
		failed_attempts: number;
		partial_attempts: number;
	}>;
	readonly unknown_usage: Readonly<{ attempts: number }>;
	readonly known_tokens: ShapeTokenTotals;
	readonly elapsed_ms: number;
}

interface MutableTokens {
	input: number;
	cached_input: number;
	cache_write: number;
	output: number;
	reasoning: number;
}

interface MutableConversation {
	readonly conversation_id: string;
	readonly kind: ShapeConversationKind;
	readonly role: ShapeRoleAssignment;
	logical_turns: number;
	validation_passes: number;
	readonly pass_labels: number[];
	finish_guards: number;
	readonly repairs: Record<ShapeRepairKind, number>;
	attempts: number;
	failed_attempts: number;
	partial_attempts: number;
	unknown_usage_attempts: number;
	readonly known_tokens: MutableTokens;
}

function emptyTokens(): MutableTokens {
	return {
		input: 0,
		cached_input: 0,
		cache_write: 0,
		output: 0,
		reasoning: 0,
	};
}

function emptyRepairs(): Record<ShapeRepairKind, number> {
	return { style: 0, validation: 0, coverage: 0, test_audit: 0, combined: 0 };
}

function addCount(
	target: MutableTokens,
	key: keyof MutableTokens,
	value: number,
): void {
	const next = target[key] + value;
	if (!Number.isSafeInteger(next))
		throw new RangeError("Shape token total exceeded the safe integer range.");
	target[key] = next;
}

function frozenTokens(value: MutableTokens): ShapeTokenTotals {
	return Object.freeze({ ...value });
}

export function shapeRoleAssignment(
	role: ResolvedRole,
	assignedRole: ShapeLogicalRole,
): ShapeRoleAssignment {
	if (
		assignedRole !== "shaper" &&
		assignedRole !== "fallback_shaper" &&
		assignedRole !== "auditor"
	)
		throw new TypeError("Shape role assignment is invalid.");
	const effectiveRole: ModelRole =
		assignedRole === "fallback_shaper" ? "shaper" : role.name;
	if (effectiveRole !== role.name)
		throw new TypeError(
			"Shape role assignment does not match the resolved role.",
		);
	return Object.freeze({
		assigned_role: assignedRole,
		effective_role: effectiveRole,
		requested: Object.freeze({ ...role.requested }),
		effective: Object.freeze({ ...role.effective }),
	});
}

/**
 * Mutable accounting scoped to one Shape invocation. Conversation allowances
 * reset for fallback, while HTTP, auditor, token, and elapsed totals continue.
 */
export class ShapeAccounting {
	readonly roles: ShapeAccountingDocument["roles"];
	private readonly conversations = new Map<string, MutableConversation>();

	constructor(input: {
		readonly shaper: ResolvedRole;
		readonly auditor: ResolvedRole;
	}) {
		if (input.shaper.name !== "shaper" || input.auditor.name !== "auditor")
			throw new TypeError(
				"Shape accounting requires resolved shaper and auditor roles.",
			);
		const shaper = shapeRoleAssignment(input.shaper, "shaper");
		this.roles = Object.freeze({
			shaper,
			fallback_shaper: shapeRoleAssignment(input.shaper, "fallback_shaper"),
			auditor: shapeRoleAssignment(input.auditor, "auditor"),
		});
	}

	registerConversation(
		conversationId: string,
		kind: ShapeConversationKind,
		role: ShapeRoleAssignment,
	): void {
		if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(conversationId))
			throw new TypeError("Shape conversation id is invalid.");
		const prior = this.conversations.get(conversationId);
		if (prior) {
			if (
				prior.kind !== kind ||
				JSON.stringify(prior.role) !== JSON.stringify(role)
			)
				throw new TypeError(
					"Shape conversation id was reused with another role.",
				);
			return;
		}
		if (
			(kind === "primary" && role.assigned_role !== "shaper") ||
			(kind === "fallback" && role.assigned_role !== "fallback_shaper") ||
			(kind === "auditor" && role.assigned_role !== "auditor")
		)
			throw new TypeError("Shape conversation kind and role do not match.");
		this.conversations.set(conversationId, {
			conversation_id: conversationId,
			kind,
			role,
			logical_turns: 0,
			validation_passes: 0,
			pass_labels: [],
			finish_guards: 0,
			repairs: emptyRepairs(),
			attempts: 0,
			failed_attempts: 0,
			partial_attempts: 0,
			unknown_usage_attempts: 0,
			known_tokens: emptyTokens(),
		});
	}

	conversation(conversationId: string): ShapeConversationCounters {
		return this.snapshotConversation(this.requireConversation(conversationId));
	}

	canStartLogicalTurn(conversationId: string): boolean {
		const conversation = this.requireConversation(conversationId);
		return (
			conversation.kind === "auditor" ||
			conversation.logical_turns < SHAPE_LIMITS.logicalTurns
		);
	}

	startLogicalTurn(conversationId: string): void {
		const conversation = this.requireConversation(conversationId);
		if (!this.canStartLogicalTurn(conversationId))
			throw new RangeError("Shape logical turn allowance is exhausted.");
		conversation.logical_turns = checkedNext(
			conversation.logical_turns,
			"Shape logical turn count",
		);
	}

	canCompleteValidationPass(conversationId: string): boolean {
		const conversation = this.requireConversation(conversationId);
		if (conversation.kind === "auditor")
			throw new TypeError(
				"Auditor conversations do not own validation passes.",
			);
		return conversation.validation_passes < SHAPE_LIMITS.validationPasses;
	}

	nextValidationPassLabel(conversationId: string): number {
		const conversation = this.requireConversation(conversationId);
		if (!this.canCompleteValidationPass(conversationId))
			throw new RangeError("Shape validation pass allowance is exhausted.");
		return (
			(conversation.kind === "fallback" ? SHAPE_LIMITS.validationPasses : 0) +
			conversation.validation_passes +
			1
		);
	}

	/** Count a completed traversal, including a successful last-allowance pass. */
	completeValidationPass(conversationId: string): number {
		const conversation = this.requireConversation(conversationId);
		if (!this.canCompleteValidationPass(conversationId))
			throw new RangeError("Shape validation pass allowance is exhausted.");
		conversation.validation_passes = checkedNext(
			conversation.validation_passes,
			"Shape validation pass count",
		);
		const label =
			(conversation.kind === "fallback" ? SHAPE_LIMITS.validationPasses : 0) +
			conversation.validation_passes;
		conversation.pass_labels.push(label);
		return label;
	}

	canRepairStyle(conversationId: string): boolean {
		const conversation = this.requireConversation(conversationId);
		if (conversation.kind === "auditor")
			throw new TypeError("Auditor conversations do not own style repairs.");
		return conversation.repairs.style < SHAPE_LIMITS.styleRepairs;
	}

	recordRepair(conversationId: string, kind: ShapeRepairKind): void {
		const conversation = this.requireConversation(conversationId);
		if (conversation.kind === "auditor")
			throw new TypeError("Auditor conversations do not own repairs.");
		if (kind === "style" && !this.canRepairStyle(conversationId))
			throw new RangeError("Shape style repair allowance is exhausted.");
		conversation.repairs[kind] = checkedNext(
			conversation.repairs[kind],
			"Shape repair count",
		);
	}

	recordFinishGuard(conversationId: string): void {
		const conversation = this.requireConversation(conversationId);
		if (conversation.kind === "auditor")
			throw new TypeError("Auditor conversations do not own finish guards.");
		conversation.finish_guards = checkedNext(
			conversation.finish_guards,
			"Shape finish guard count",
		);
	}

	startHttpAttempt(conversationId: string): void {
		const conversation = this.requireConversation(conversationId);
		conversation.attempts = checkedNext(
			conversation.attempts,
			"HTTP attempt count",
		);
	}

	finishHttpAttempt(
		conversationId: string,
		input: {
			readonly usage: ResponseUsage | null;
			readonly failed: boolean;
			readonly partial: boolean;
		},
	): void {
		const conversation = this.requireConversation(conversationId);
		if (input.failed)
			conversation.failed_attempts = checkedNext(
				conversation.failed_attempts,
				"Failed HTTP attempt count",
			);
		if (input.partial)
			conversation.partial_attempts = checkedNext(
				conversation.partial_attempts,
				"Partial HTTP attempt count",
			);
		const usage = input.usage;
		if (usage === null) {
			conversation.unknown_usage_attempts = checkedNext(
				conversation.unknown_usage_attempts,
				"Unknown usage attempt count",
			);
			return;
		}
		let incomplete = false;
		for (const key of [
			"input",
			"cached_input",
			"cache_write",
			"output",
			"reasoning",
		] as const) {
			const value = usage[key];
			if (value === null) incomplete = true;
			else addCount(conversation.known_tokens, key, value);
		}
		if (incomplete)
			conversation.unknown_usage_attempts = checkedNext(
				conversation.unknown_usage_attempts,
				"Unknown usage attempt count",
			);
	}

	snapshot(input: {
		readonly outcome: ShapeAccountingDocument["outcome"];
		readonly elapsedMilliseconds: number;
	}): ShapeAccountingDocument {
		if (
			!Number.isSafeInteger(input.elapsedMilliseconds) ||
			input.elapsedMilliseconds < 0
		)
			throw new RangeError("Shape elapsed milliseconds are invalid.");
		const conversations = [...this.conversations.values()].map((value) =>
			this.snapshotConversation(value),
		);
		const logicalTurns: Record<ShapeLogicalRole, number> = {
			shaper: 0,
			fallback_shaper: 0,
			auditor: 0,
		};
		const passAndRepairTotals = {
			validation_passes: 0,
			finish_guards: 0,
			repairs: emptyRepairs(),
		};
		const tokens = emptyTokens();
		const auditorTokens = emptyTokens();
		let auditorRequests = 0;
		let auditorAttempts = 0;
		let auditorUnknownUsage = 0;
		let attempts = 0;
		let failedAttempts = 0;
		let partialAttempts = 0;
		let unknownUsageAttempts = 0;
		for (const conversation of conversations) {
			const role = conversation.role.assigned_role;
			logicalTurns[role] = checkedSum(
				logicalTurns[role],
				conversation.counters.logical_turns,
			);
			attempts = checkedSum(attempts, conversation.http.attempts);
			failedAttempts = checkedSum(
				failedAttempts,
				conversation.http.failed_attempts,
			);
			partialAttempts = checkedSum(
				partialAttempts,
				conversation.http.partial_attempts,
			);
			unknownUsageAttempts = checkedSum(
				unknownUsageAttempts,
				conversation.http.unknown_usage_attempts,
			);
			addTokenTotals(tokens, conversation.http.known_tokens);
			if (conversation.kind === "auditor") {
				auditorRequests = checkedSum(
					auditorRequests,
					conversation.counters.logical_turns,
				);
				auditorAttempts = checkedSum(
					auditorAttempts,
					conversation.http.attempts,
				);
				auditorUnknownUsage = checkedSum(
					auditorUnknownUsage,
					conversation.http.unknown_usage_attempts,
				);
				addTokenTotals(auditorTokens, conversation.http.known_tokens);
				continue;
			}
			passAndRepairTotals.validation_passes = checkedSum(
				passAndRepairTotals.validation_passes,
				conversation.counters.validation_passes,
			);
			passAndRepairTotals.finish_guards = checkedSum(
				passAndRepairTotals.finish_guards,
				conversation.counters.finish_guards,
			);
			for (const kind of Object.keys(
				passAndRepairTotals.repairs,
			) as ShapeRepairKind[])
				passAndRepairTotals.repairs[kind] = checkedSum(
					passAndRepairTotals.repairs[kind],
					conversation.counters.repairs[kind],
				);
		}
		return Object.freeze({
			schema: 1,
			profile: SHAPE_PROFILE,
			outcome: Object.freeze({ ...input.outcome }),
			roles: this.roles,
			conversations: Object.freeze(conversations),
			counters: Object.freeze({
				logical_turns: Object.freeze(logicalTurns),
				...passAndRepairTotals,
				repairs: Object.freeze({ ...passAndRepairTotals.repairs }),
			}),
			auditor: Object.freeze({
				logical_requests: auditorRequests,
				http_attempts: auditorAttempts,
				unknown_usage_attempts: auditorUnknownUsage,
				known_tokens: frozenTokens(auditorTokens),
			}),
			http: Object.freeze({
				attempts,
				failed_attempts: failedAttempts,
				partial_attempts: partialAttempts,
			}),
			unknown_usage: Object.freeze({ attempts: unknownUsageAttempts }),
			known_tokens: frozenTokens(tokens),
			elapsed_ms: input.elapsedMilliseconds,
		});
	}

	private requireConversation(conversationId: string): MutableConversation {
		const conversation = this.conversations.get(conversationId);
		if (!conversation)
			throw new TypeError(
				`Shape conversation ${conversationId} is not registered.`,
			);
		return conversation;
	}

	private snapshotConversation(
		value: MutableConversation,
	): ShapeConversationCounters {
		return Object.freeze({
			conversation_id: value.conversation_id,
			kind: value.kind,
			role: value.role,
			counters: Object.freeze({
				logical_turns: value.logical_turns,
				validation_passes: value.validation_passes,
				pass_labels: Object.freeze([...value.pass_labels]),
				finish_guards: value.finish_guards,
				repairs: Object.freeze({ ...value.repairs }),
			}),
			http: Object.freeze({
				attempts: value.attempts,
				failed_attempts: value.failed_attempts,
				partial_attempts: value.partial_attempts,
				unknown_usage_attempts: value.unknown_usage_attempts,
				known_tokens: frozenTokens(value.known_tokens),
			}),
		});
	}
}

function addTokenTotals(target: MutableTokens, source: ShapeTokenTotals): void {
	for (const key of [
		"input",
		"cached_input",
		"cache_write",
		"output",
		"reasoning",
	] as const)
		addCount(target, key, source[key]);
}

function checkedNext(value: number, label: string): number {
	const next = value + 1;
	if (!Number.isSafeInteger(next))
		throw new RangeError(`${label} exceeded the safe integer range.`);
	return next;
}

function checkedSum(left: number, right: number): number {
	const sum = left + right;
	if (!Number.isSafeInteger(sum))
		throw new RangeError("Shape counter exceeded the safe integer range.");
	return sum;
}
