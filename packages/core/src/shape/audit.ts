import type { ResolvedRole } from "../project/roles";
import type { RespondResult } from "../provider/retry/respond";
import { userMessageBytes } from "../provider/session/history";
import {
	newConversation,
	type SessionState,
} from "../provider/session/transition";
import type { ShapeWarning } from "./controller";

export type ShapeAuditKind = "requirement" | "test";

export interface ShapeAuditItemOutput {
	readonly id: string;
	readonly verdict: "valid" | "over_strict" | "infeasible";
	readonly citation: string;
	readonly reason: string;
}

export interface ShapeAuditParseResult {
	readonly repairs: readonly ShapeAuditItemOutput[];
	readonly warnings: readonly ShapeWarning[];
}

export const SHAPE_REQUIREMENT_AUDITOR_INSTRUCTIONS =
	'You are Kogen\'s requirement auditor. Enumerate each atomic constraint in the Request. Map each row to one existing Acceptance id, or use `untestable: <specific reason>`. Return only JSON with shape {"rows":[{"constraint":string,"maps_to":string}]} and no tools.';

export const SHAPE_TEST_AUDITOR_INSTRUCTIONS =
	'You are Kogen\'s acceptance test auditor. Check whether each acceptance test follows the verbatim Request. Cite an exact non-empty substring of the Request for every non-valid verdict. Return only JSON with shape {"items":[{"id":string,"verdict":"valid|over_strict|infeasible","citation":string,"reason":string}]} and no tools.';

function userInput(text: string): ReturnType<typeof userMessageBytes> {
	return userMessageBytes(text);
}

export function createShapeAuditSession(input: {
	readonly source: SessionState;
	readonly role: ResolvedRole;
	readonly passNumber: number;
	readonly kind: ShapeAuditKind;
	readonly message: string;
}): SessionState {
	if (
		input.role.name !== "auditor" ||
		!Number.isSafeInteger(input.passNumber) ||
		input.passNumber < 1 ||
		input.source.role === "auditor"
	)
		throw new TypeError("Shape audit session input is invalid.");
	const attempt = `shape-${input.kind}-pass-${input.passNumber}`;
	const roleInstructions =
		input.kind === "requirement"
			? SHAPE_REQUIREMENT_AUDITOR_INSTRUCTIONS
			: SHAPE_TEST_AUDITOR_INSTRUCTIONS;
	return newConversation(input.source, {
		type: "start_conversation",
		stage: "shape-audit",
		attempt,
		rung: attempt,
		epoch: "initial",
		role: "auditor",
		model: input.role.effective.model,
		effort: input.role.effective.effort,
		roleInstructions,
		initialItems: [{ bytes: userInput(input.message), kind: "message" }],
	});
}

export async function requestShapeAudit(input: {
	readonly source: SessionState;
	readonly role: ResolvedRole;
	readonly passNumber: number;
	readonly kind: ShapeAuditKind;
	readonly message: string;
	readonly requestModel: (
		session: SessionState,
		role: ResolvedRole,
	) => Promise<RespondResult>;
}): Promise<RespondResult> {
	const session = createShapeAuditSession(input);
	return input.requestModel(session, input.role);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function warning(
	code: string,
	itemIds: readonly string[],
	message: string,
): ShapeWarning {
	return { code, item_ids: [...itemIds], message };
}

/** Parse the test auditor's output without allowing incomplete advice to pass as valid. */
export function parseShapeTestAudit(
	text: string,
	expectedIds: readonly string[],
	request: string | Uint8Array,
	repairAlreadyUsed: boolean,
): ShapeAuditParseResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			repairs: [],
			warnings: [
				warning(
					"audit_invalid",
					expectedIds,
					"Acceptance test auditor returned malformed JSON.",
				),
			],
		};
	}
	const root = asRecord(parsed);
	if (
		root === null ||
		Object.keys(root).length !== 1 ||
		!Array.isArray(root.items)
	) {
		return {
			repairs: [],
			warnings: [
				warning(
					"audit_invalid",
					expectedIds,
					"Acceptance test auditor response must contain only an items array.",
				),
			],
		};
	}

	const expected = new Set(expectedIds);
	const byId = new Map<string, ShapeAuditItemOutput>();
	const seenIds = new Set<string>();
	const duplicateIds = new Set<string>();
	const warnings: ShapeWarning[] = [];
	for (const rawItem of root.items) {
		const item = asRecord(rawItem);
		if (
			item === null ||
			typeof item.id !== "string" ||
			!expected.has(item.id)
		) {
			warnings.push(
				warning(
					"audit_unknown",
					[],
					"Acceptance test auditor returned an item with an unknown or invalid id.",
				),
			);
			continue;
		}
		if (seenIds.has(item.id)) {
			warnings.push(
				warning(
					"audit_duplicate",
					[item.id],
					`Acceptance test auditor returned duplicate advice for ${item.id}.`,
				),
			);
			byId.delete(item.id);
			duplicateIds.add(item.id);
			continue;
		}
		seenIds.add(item.id);
		if (
			(item.verdict !== "valid" &&
				item.verdict !== "over_strict" &&
				item.verdict !== "infeasible") ||
			typeof item.citation !== "string" ||
			typeof item.reason !== "string"
		) {
			warnings.push(
				warning(
					"audit_invalid",
					[item.id],
					`Acceptance test auditor returned invalid advice for ${item.id}.`,
				),
			);
			continue;
		}
		byId.set(item.id, {
			id: item.id,
			verdict: item.verdict,
			citation: item.citation,
			reason: item.reason,
		});
	}

	const repairs: ShapeAuditItemOutput[] = [];
	for (const id of expectedIds) {
		const item = byId.get(id);
		if (item === undefined) {
			warnings.push(
				warning(
					"audit_missing",
					[id],
					`Acceptance test auditor returned no usable advice for ${id}.`,
				),
			);
			continue;
		}
		if (item.verdict === "valid") continue;
		const hasCitation =
			item.citation.length > 0 && containsExactCitation(request, item.citation);
		if (hasCitation && !repairAlreadyUsed) {
			repairs.push(item);
			continue;
		}
		warnings.push(
			warning(
				`audit_${item.verdict}`,
				[id],
				item.reason.length > 0
					? item.reason
					: `Acceptance test auditor marked ${id} ${item.verdict}.`,
			),
		);
	}
	return { repairs, warnings };
}

function containsExactCitation(
	request: string | Uint8Array,
	citation: string,
): boolean {
	if (typeof request === "string") return request.includes(citation);
	const needle = new TextEncoder().encode(citation);
	outer: for (
		let start = 0;
		start <= request.byteLength - needle.byteLength;
		start += 1
	) {
		for (let offset = 0; offset < needle.byteLength; offset += 1)
			if (request[start + offset] !== needle[offset]) continue outer;
		return true;
	}
	return false;
}
